"""Conversation storage: SQLite, one file, stdlib only.

A conversation is an ordered list of turns. A turn is one user prompt plus
what came back: the events streamed to the browser (to redraw the chat and
map on resume) and the model messages the agent produced (to give the model
its memory on the next turn). Editing or retrying turn N deletes turns N and
later and runs again from there.
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .config import settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT '{}',
    forked_from TEXT,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_client ON conversations (client_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
    conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    idx             INTEGER NOT NULL,
    prompt          TEXT NOT NULL,
    events          TEXT NOT NULL DEFAULT '[]',
    llm             TEXT NOT NULL DEFAULT '[]',
    created_at      REAL NOT NULL,
    PRIMARY KEY (conversation_id, idx)
);
"""

TITLE_MAX = 60


def _db_path() -> Path:
    path = Path(settings.sessions_db).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    # One short-lived connection per call: safe across threads and requests.
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init() -> None:
    with _connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(_SCHEMA)


def title_from(prompt: str) -> str:
    text = " ".join(prompt.split())
    return text if len(text) <= TITLE_MAX else text[: TITLE_MAX - 1].rstrip() + "…"


def _summary(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "forked_from": row["forked_from"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "turns": row["turns"],
    }


def list_for(client_id: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns
               FROM conversations c WHERE c.client_id = ? ORDER BY c.updated_at DESC""",
            (client_id,),
        ).fetchall()
    return [_summary(r) for r in rows]


def create(client_id: str, title: str = "", forked_from: str | None = None) -> str:
    cid = uuid.uuid4().hex
    now = time.time()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, client_id, title, forked_from, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (cid, client_id, title, forked_from, now, now),
        )
    return cid


def _owned(conn: sqlite3.Connection, cid: str, client_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM conversations WHERE id = ? AND client_id = ?", (cid, client_id)
    ).fetchone()


def exists(cid: str, client_id: str) -> bool:
    with _connect() as conn:
        return _owned(conn, cid, client_id) is not None


def get(cid: str, client_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = _owned(conn, cid, client_id)
        if row is None:
            return None
        turns = conn.execute(
            "SELECT idx, prompt, events, created_at FROM turns WHERE conversation_id = ? ORDER BY idx",
            (cid,),
        ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "forked_from": row["forked_from"],
        "state": json.loads(row["state"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "turns": [
            {
                "idx": t["idx"],
                "prompt": t["prompt"],
                "events": json.loads(t["events"]),
                "created_at": t["created_at"],
            }
            for t in turns
        ],
    }


def update(cid: str, client_id: str, *, title: str | None = None, state: dict | None = None) -> bool:
    sets, args = [], []
    if title is not None:
        sets.append("title = ?")
        args.append(title.strip()[:200])
    if state is not None:
        sets.append("state = ?")
        args.append(json.dumps(state))
    if not sets:
        return True
    # Saving map state is not "activity"; only a rename moves it up the list.
    if title is not None:
        sets.append("updated_at = ?")
        args.append(time.time())
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE conversations SET {', '.join(sets)} WHERE id = ? AND client_id = ?",
            (*args, cid, client_id),
        )
    return cur.rowcount == 1


def delete(cid: str, client_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE id = ? AND client_id = ?", (cid, client_id))
    return cur.rowcount == 1


def expire(days: float, now: float | None = None) -> int:
    """Delete every conversation with no activity in the last `days` days,
    with its turns. Returns how many were deleted; 0 days deletes nothing."""
    if days <= 0:
        return 0
    cutoff = (time.time() if now is None else now) - days * 86400
    with _connect() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE updated_at < ?", (cutoff,))
    return cur.rowcount


def fork(cid: str, client_id: str, upto: int | None = None) -> str | None:
    """Copy a conversation, optionally only turns before `upto`, into a new one."""
    with _connect() as conn:
        row = _owned(conn, cid, client_id)
        if row is None:
            return None
        new_id = uuid.uuid4().hex
        now = time.time()
        conn.execute(
            "INSERT INTO conversations (id, client_id, title, state, forked_from, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (new_id, client_id, f"{row['title'] or 'Untitled'} (fork)", row["state"], cid, now, now),
        )
        limit = upto if upto is not None else 1 << 30
        conn.execute(
            "INSERT INTO turns (conversation_id, idx, prompt, events, llm, created_at)"
            " SELECT ?, idx, prompt, events, llm, created_at FROM turns"
            " WHERE conversation_id = ? AND idx < ?",
            (new_id, cid, limit),
        )
    return new_id


def begin_turn(cid: str, client_id: str, from_turn: int | None) -> tuple[int, list[dict]] | None:
    """Prepare a new turn: drop turns >= from_turn (edit/retry), return its index
    and the model history (all earlier turns' model messages, in order)."""
    with _connect() as conn:
        row = _owned(conn, cid, client_id)
        if row is None:
            return None
        if from_turn is not None:
            conn.execute("DELETE FROM turns WHERE conversation_id = ? AND idx >= ?", (cid, from_turn))
        rows = conn.execute(
            "SELECT idx, prompt, llm FROM turns WHERE conversation_id = ? ORDER BY idx", (cid,)
        ).fetchall()
    history: list[dict] = []
    for r in rows:
        history.append({"role": "user", "content": r["prompt"]})
        history.extend(json.loads(r["llm"]))
    next_idx = rows[-1]["idx"] + 1 if rows else 0
    return next_idx, history


def save_turn(
    cid: str, client_id: str, idx: int, prompt: str, events: list[dict], llm: list[dict]
) -> None:
    now = time.time()
    with _connect() as conn:
        row = _owned(conn, cid, client_id)
        if row is None:
            return
        conn.execute(
            "INSERT OR REPLACE INTO turns (conversation_id, idx, prompt, events, llm, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (cid, idx, prompt, json.dumps(events, default=str), json.dumps(llm, default=str), now),
        )
        # The first prompt names an untitled conversation.
        if idx == 0 and not row["title"]:
            conn.execute("UPDATE conversations SET title = ? WHERE id = ?", (title_from(prompt), cid))
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, cid))
