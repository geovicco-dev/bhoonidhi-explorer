"""FastAPI app: conversations, the streaming agent loop, and place/quicklook helpers."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Any, Literal
from urllib.parse import urlparse

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from . import geocode, limits, model_queue, query, sessions, tools
from .agent import run_agent
from .config import settings

log = logging.getLogger("bhoonidhi_api")

# Restricts the quicklook proxy so it cannot be used as an open proxy.
_QUICKLOOK_HOST = "bhoonidhi.nrsc.gov.in"


@asynccontextmanager
async def lifespan(app: FastAPI):
    sessions.init()
    # The query form's product list checks every product against the
    # catalogue (about 6 s); do it now so the first open is instant.
    warm = asyncio.create_task(_warm()) if tools.stac_enabled() else None
    sweep = asyncio.create_task(_sweep()) if settings.conversation_retention_days > 0 else None
    yield
    for task in (warm, sweep):
        if task:
            task.cancel()


async def _warm() -> None:
    # A failed warm-up only means a slower first open of the form.
    with contextlib.suppress(Exception):
        await query.archive_list(await tools.catalogue())


# How often old conversations are looked for. A conversation can outlive its
# retention by at most this long.
SWEEP_EVERY_S = 3600


async def _sweep() -> None:
    """Deletes conversations past their retention: once at start, then hourly."""
    while True:
        try:
            gone = await asyncio.to_thread(sessions.expire, settings.conversation_retention_days)
            if gone:
                log.info("deleted %d conversation(s) with no activity in %g days", gone, settings.conversation_retention_days)
        except Exception:  # noqa: BLE001 - a failed sweep is retried next hour
            log.exception("conversation sweep failed")
        await asyncio.sleep(SWEEP_EVERY_S)


app = FastAPI(title="bhoonidhi-api", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _client_id(value: str | None) -> str:
    # Anonymous per-browser id; each browser sees only its own conversations.
    if not value or len(value) > 64:
        raise HTTPException(status_code=400, detail="X-Client-Id header required")
    return value


@app.get("/health")
async def health() -> dict:
    specs, _ = tools.registry()
    line = model_queue.line
    return {
        "status": "ok",
        "tools": len(specs),
        "catalogue": tools.stac_enabled(),
        "model": {"slots": line.slots, "answering": line.answering, "waiting": line.waiting},
    }


@app.get("/tools")
async def list_tools() -> dict:
    specs, _ = tools.registry()
    return {"tools": [t["function"]["name"] for t in specs]}


@app.get("/config")
async def client_config() -> dict:
    """Settings the page needs from the server: read while it runs, so a
    self-hosted explorer can change them without rebuilding the web app."""
    return {"stac_public_url": tools.stac_public_url()}


# --- conversations ---------------------------------------------------------


class ConversationPatch(BaseModel):
    title: str | None = None
    # Map/filter state restored on resume (selected scene, filters).
    state: dict[str, Any] | None = None


class ForkRequest(BaseModel):
    # Copy only turns before this index; omit to copy the whole conversation.
    upto: int | None = None


@app.get("/conversations")
async def list_conversations(x_client_id: str | None = Header(None)) -> dict:
    # retention_days: how long an idle conversation is kept, for the notice
    # under Recent; 0 keeps them forever.
    return {
        "conversations": sessions.list_for(_client_id(x_client_id)),
        "retention_days": settings.conversation_retention_days,
    }


@app.post("/conversations")
async def create_conversation(x_client_id: str | None = Header(None)) -> dict:
    cid = sessions.create(_client_id(x_client_id))
    return sessions.get(cid, _client_id(x_client_id)) or {}


@app.get("/conversations/{cid}")
async def get_conversation(cid: str, x_client_id: str | None = Header(None)) -> dict:
    conv = sessions.get(cid, _client_id(x_client_id))
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return conv


@app.patch("/conversations/{cid}")
async def patch_conversation(
    cid: str, body: ConversationPatch, x_client_id: str | None = Header(None)
) -> dict:
    if not sessions.update(cid, _client_id(x_client_id), title=body.title, state=body.state):
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"ok": True}


@app.delete("/conversations/{cid}")
async def delete_conversation(cid: str, x_client_id: str | None = Header(None)) -> dict:
    if not sessions.delete(cid, _client_id(x_client_id)):
        raise HTTPException(status_code=404, detail="conversation not found")
    return {"ok": True}


@app.post("/conversations/{cid}/fork")
async def fork_conversation(
    cid: str, body: ForkRequest, x_client_id: str | None = Header(None)
) -> dict:
    new_id = sessions.fork(cid, _client_id(x_client_id), body.upto)
    if new_id is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    return sessions.get(new_id, _client_id(x_client_id)) or {}


# --- chat --------------------------------------------------------------------


class AreaBox(BaseModel):
    kind: Literal["bbox"]
    west: float = Field(ge=-180, le=180)
    south: float = Field(ge=-90, le=90)
    east: float = Field(ge=-180, le=180)
    north: float = Field(ge=-90, le=90)
    name: str | None = Field(default=None, max_length=200)


class AreaCircle(BaseModel):
    kind: Literal["circle"]
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    # The portal's point search accepts 1 to 100 km.
    radius_km: float = Field(ge=1, le=100)
    name: str | None = Field(default=None, max_length=200)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    # Edit/retry: replace turn N and everything after it. Omit to append.
    from_turn: int | None = None
    # The area of interest on the map when the message was sent.
    area: Annotated[AreaBox | AreaCircle, Field(discriminator="kind")] | None = None


def _sse(event: dict) -> bytes:
    return f"data: {json.dumps(event, default=str)}\n\n".encode()


# How often a waiting question hears its place in line.
WAIT_UPDATE_S = 2.0

LINE_FULL = (
    "Too many questions are waiting for the model. Ask again in a few minutes, "
    "or search with the query form, which does not need the model."
)


def _waited_too_long() -> str:
    minutes = round(settings.model_queue_wait_s / 60)
    waited = f"{minutes} minute{'s' if minutes != 1 else ''}" if minutes else f"{settings.model_queue_wait_s:g} s"
    return (
        f"Your question waited {waited} without reaching the model, so it was dropped. "
        "Ask again in a while, or search with the query form, which does not need the model."
    )


@app.post("/conversations/{cid}/chat", dependencies=[Depends(limits.QUESTIONS)])
async def chat(cid: str, req: ChatRequest, x_client_id: str | None = Header(None)) -> StreamingResponse:
    client_id = _client_id(x_client_id)
    if not sessions.exists(cid, client_id):
        raise HTTPException(status_code=404, detail="conversation not found")
    if model_queue.line.full():
        raise HTTPException(status_code=503, detail=LINE_FULL)
    area = req.area.model_dump(exclude_none=True) if req.area else None

    async def event_stream() -> AsyncIterator[bytes]:
        try:
            place = model_queue.line.join()
        except model_queue.Full:
            # Filled up between the check above and this stream starting.
            yield _sse({"type": "error", "message": LINE_FULL})
            yield _sse({"type": "done"})
            return
        idx: int | None = None
        events: list[dict] = []
        llm: list[dict] = []
        try:
            # Wait for the model, telling the browser its place as it moves.
            # A stopped fetch cancels this generator, which gives the place up.
            deadline = time.monotonic() + settings.model_queue_wait_s
            while not place.answering:
                left = deadline - time.monotonic()
                if left <= 0:
                    yield _sse({"type": "error", "message": _waited_too_long()})
                    yield _sse({"type": "done"})
                    return
                position = place.position()
                yield _sse({"type": "waiting", "position": position, "wait_s": model_queue.line.estimate_s(position)})
                await place.wait(min(WAIT_UPDATE_S, left))

            begun = sessions.begin_turn(cid, client_id, req.from_turn)
            if begun is None:
                # Deleted while the question waited.
                yield _sse({"type": "error", "message": "This session no longer exists."})
                yield _sse({"type": "done"})
                return
            idx, history = begun
            yield _sse({"type": "turn", "idx": idx})
            if area:
                # Stored with the turn, so the transcript can show which area it asked about.
                events.append({"type": "area", "area": area})
                yield _sse(events[-1])
            async for event in run_agent(req.message, history, area):
                if event["type"] == "turn_llm":
                    llm = event["messages"]
                    continue
                events.append(event)
                yield _sse(event)
        finally:
            place.leave()
            # Saved even if the browser stops the stream, so a partial turn
            # survives a reload. Runs off the event loop; SQLite blocks.
            if idx is not None:
                await asyncio.to_thread(sessions.save_turn, cid, client_id, idx, req.message, events, llm)
        yield _sse({"type": "done"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- query mode: structured searches without the model -----------------------


class QueryBody(BaseModel):
    query: dict[str, Any]


class QueryTurn(BaseModel):
    query: dict[str, Any]
    # Edit query: replace turn N and everything after it. Omit to append.
    from_turn: int | None = None


class BhdBody(BaseModel):
    query: dict[str, Any]
    scene_ids: list[str] = Field(default_factory=list)


class SceneBody(BaseModel):
    scene: dict[str, Any]


class ScenesBody(BaseModel):
    scenes: list[dict[str, Any]]


class FromSearchBody(BaseModel):
    arguments: dict[str, Any]


class FromQuestionBody(BaseModel):
    # The question typed into the bar.
    text: str = Field(max_length=4000)
    # The area on the map, if any.
    area: dict[str, Any] | None = None
    # The conversation's previous search: a query-form turn's query, or an
    # agent turn's search_catalog arguments. Neither: `base` is the form's
    # blank query.
    base: dict[str, Any]
    search_args: dict[str, Any] | None = None


@app.get("/query/products")
async def query_products() -> dict:
    """Every satellite and product `bhd` knows, for the form and the archive."""
    return {"satellites": await query.archive_list(await tools.catalogue())}


@app.post("/query/check")
async def query_check(body: QueryBody) -> dict:
    """Check a query without searching: its problems, each with a fix, and
    its notes. The form calls this on every edit; the catalogue is searched
    only when the query is run."""
    checked = query.check(body.query, await tools.catalogue())
    return {"ok": checked.ok, "problems": checked.problems, "notes": checked.notes}


@app.post("/query/search", dependencies=[Depends(limits.SEARCHES)])
async def query_search(body: QueryBody) -> dict:
    """Check a query and, if it has no problems, search; nothing is saved."""
    return await query.run(body.query, await tools.catalogue())


@app.post("/conversations/{cid}/query", dependencies=[Depends(limits.SEARCHES)])
async def query_turn(cid: str, body: QueryTurn, x_client_id: str | None = Header(None)) -> dict:
    """Run a query and save it as a turn, so the conversation and the agent
    see it. A query with problems is refused and nothing is saved."""
    client_id = _client_id(x_client_id)
    cat = await tools.catalogue()
    result = await query.run(body.query, cat)
    if result.get("status") == "invalid_query":
        raise HTTPException(status_code=422, detail=result)
    begun = sessions.begin_turn(cid, client_id, body.from_turn)
    if begun is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    idx, _ = begun
    shown = {k: v for k, v in body.query.items() if k != "area"}
    events: list[dict[str, Any]] = [{"type": "query", "query": body.query}]
    if body.query.get("area"):
        events.append({"type": "area", "area": body.query["area"]})
    events += [
        {"type": "tool_call", "name": "query_catalog", "arguments": shown},
        {"type": "tool_result", "name": "query_catalog", "result": result},
        {"type": "answer", "text": query.answer(result)},
    ]
    prompt = query.said(body.query)
    await asyncio.to_thread(sessions.save_turn, cid, client_id, idx, prompt, events, query.memory(body.query, result))
    return {"idx": idx, "prompt": prompt, "events": events}


@app.post("/query/bhd")
async def query_bhd(body: BhdBody) -> dict:
    """The `bhd` commands that download the scenes a query found."""
    return query.bhd_steps(body.query, body.scene_ids, await tools.catalogue())


@app.post("/scene/handoff")
async def scene_handoff(body: SceneBody) -> dict:
    """The `bhd` commands and the MCP prompt that download one scene."""
    return query.scene_handoff(body.scene, await tools.catalogue())


@app.post("/scenes/handoff")
async def scenes_handoff(body: ScenesBody) -> dict:
    """The `bhd` commands and the MCP prompt that download the chosen scenes."""
    return query.scenes_handoff(body.scenes, await tools.catalogue())


@app.post("/query/from-search")
async def query_from_search(body: FromSearchBody) -> dict:
    """An agent's search, as a query the form can open."""
    return {"query": query.from_search(body.arguments, await tools.catalogue())}


@app.post("/query/from-question")
async def query_from_question(body: FromQuestionBody) -> dict:
    """A question waiting for the model, as a query the form can open: what it
    names plainly over the previous search. No model or geocoder call."""
    cat = await tools.catalogue()
    base = query.from_search(body.search_args, cat) if body.search_args else body.base
    # Fields the agent's search left unset keep the form's.
    base = {**body.base, **{k: v for k, v in base.items() if v not in (None, [], {})}}
    return {"query": query.from_question(body.text, base, body.area, cat)}


# --- places and quicklooks -------------------------------------------------


@app.get("/geocode", dependencies=[Depends(limits.PLACES)])
async def geocode_place(
    q: str = Query(..., min_length=2, max_length=200),
    limit: int = Query(5, ge=1, le=10),
) -> dict:
    """Places matching a name, for the palette's place search (@)."""
    try:
        places = await geocode.search(q, limit)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"place search failed: {exc}") from exc
    return {"places": places}


@app.get("/quicklook", dependencies=[Depends(limits.QUICKLOOKS)])
async def quicklook(url: str = Query(...)) -> Response:
    """Proxy a quicklook JPEG; the ISRO host sends no CORS headers, so the
    browser cannot use it as a WebGL texture directly."""
    host = urlparse(url).hostname or ""
    if host != _QUICKLOOK_HOST:
        raise HTTPException(status_code=400, detail="host not allowed")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(url)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"upstream fetch failed: {exc}") from exc
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"upstream {r.status_code}")
    return Response(
        content=r.content,
        media_type=r.headers.get("content-type", "image/jpeg"),
        # Quicklooks are immutable.
        headers={"Cache-Control": "public, max-age=86400"},
    )
