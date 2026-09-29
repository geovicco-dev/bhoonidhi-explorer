"""Storage-layer tests: create, turns, edit/retry truncation, fork, ownership."""
from __future__ import annotations

import pytest

from bhoonidhi_api import sessions
from bhoonidhi_api.config import settings


@pytest.fixture(autouse=True)
def tmp_db(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "sessions_db", str(tmp_path / "s.db"))
    sessions.init()


def _turn(cid, prompt, answer):
    idx, _ = sessions.begin_turn(cid, "me", None)
    sessions.save_turn(
        cid, "me", idx, prompt,
        [{"type": "answer", "text": answer}],
        [{"role": "assistant", "content": answer}],
    )
    return idx


def test_first_prompt_names_conversation_and_history_replays():
    cid = sessions.create("me")
    assert _turn(cid, "Sentinel-2 over Shillong", "24 scenes") == 0
    assert _turn(cid, "only Sentinel-2B", "12 scenes") == 1
    conv = sessions.get(cid, "me")
    assert conv["title"] == "Sentinel-2 over Shillong"
    assert [t["prompt"] for t in conv["turns"]] == ["Sentinel-2 over Shillong", "only Sentinel-2B"]
    _, history = sessions.begin_turn(cid, "me", None)
    assert history == [
        {"role": "user", "content": "Sentinel-2 over Shillong"},
        {"role": "assistant", "content": "24 scenes"},
        {"role": "user", "content": "only Sentinel-2B"},
        {"role": "assistant", "content": "12 scenes"},
    ]


def test_edit_drops_that_turn_and_later():
    cid = sessions.create("me")
    for i in range(3):
        _turn(cid, f"p{i}", f"a{i}")
    idx, history = sessions.begin_turn(cid, "me", 1)
    assert idx == 1
    assert [m["content"] for m in history] == ["p0", "a0"]
    assert [t["prompt"] for t in sessions.get(cid, "me")["turns"]] == ["p0"]


def test_fork_copies_turns_before_upto_and_keeps_original():
    cid = sessions.create("me")
    for i in range(3):
        _turn(cid, f"p{i}", f"a{i}")
    new_id = sessions.fork(cid, "me", upto=2)
    fork = sessions.get(new_id, "me")
    assert fork["forked_from"] == cid
    assert fork["title"] == "p0 (fork)"
    assert [t["prompt"] for t in fork["turns"]] == ["p0", "p1"]
    assert len(sessions.get(cid, "me")["turns"]) == 3


def test_rename_state_delete_and_ownership():
    cid = sessions.create("me")
    assert sessions.update(cid, "me", title="Shillong winter", state={"selectedSceneId": "x"})
    conv = sessions.get(cid, "me")
    assert conv["title"] == "Shillong winter"
    assert conv["state"] == {"selectedSceneId": "x"}
    # Another browser cannot see, change or delete it.
    assert sessions.get(cid, "other") is None
    assert not sessions.update(cid, "other", title="x")
    assert not sessions.delete(cid, "other")
    assert sessions.list_for("other") == []
    assert sessions.delete(cid, "me")
    assert sessions.get(cid, "me") is None


def test_expire_deletes_conversations_idle_past_retention(monkeypatch):
    import time

    real = time.time
    # Created and last used 8 days ago.
    monkeypatch.setattr(sessions.time, "time", lambda: real() - 8 * 86400)
    old = sessions.create("me")
    _turn(old, "an old question", "old answer")
    # Created 8 days ago, asked again 1 day ago: the clock restarts.
    revisited = sessions.create("me")
    monkeypatch.setattr(sessions.time, "time", lambda: real() - 86400)
    _turn(revisited, "asked again", "new answer")
    monkeypatch.setattr(sessions.time, "time", real)
    fresh = sessions.create("me")

    assert sessions.expire(7) == 1
    assert sessions.get(old, "me") is None
    assert sessions.get(revisited, "me") is not None
    assert sessions.get(fresh, "me") is not None
    # Its turns went with it.
    with sessions._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM turns WHERE conversation_id = ?", (old,)).fetchone()[0] == 0


def test_expire_with_zero_days_keeps_everything(monkeypatch):
    import time

    real = time.time
    monkeypatch.setattr(sessions.time, "time", lambda: real() - 400 * 86400)
    cid = sessions.create("me")
    monkeypatch.setattr(sessions.time, "time", real)
    assert sessions.expire(0) == 0
    assert sessions.get(cid, "me") is not None
