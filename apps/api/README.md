# bhoonidhi-api

FastAPI backend for Bhoonidhi Explorer. It stores conversations and runs an
agent loop: a model on any OpenAI-compatible server calls tools to resolve
places and
search Bhoonidhi scenes, and each step (tool calls, results with scene
footprints, the answer) streams to the browser as Server-Sent Events.

Scenes come from one place: **the catalogue**, a STAC API over the scene
metadata that [`bhoonidhi-stac`](https://github.com/geovicco-dev/bhoonidhi-stac)
builds and updates weekly; by default the public one. It can lag the portal
by a week. The live Bhoonidhi portal is never searched; only the
quicklook images are fetched from it (the catalogue links to them), through
the `/quicklook` proxy.

A search returns up to 1,000 scenes, newest first. When more match, the
result says `"count": "1,000+"` and `more_available: true`; the catalogue
reports no total, and the API does not page past the limit to count.

Satellite and sensor names are resolved in `names.py`, against the
catalogue's own collection list: exact names stay exact, a family name
("Sentinel-1", "resourcesat") covers its members, common alternative names
("RISAT-1A", "Oceansat-3", "LISS-IV", "S2") are known, and a name the
catalogue does not hold comes back as `unknown_name` with the real list,
never as a guess.

A search can also narrow by **product level** ("Level-2A", "GRD", "SLC",
"BOA-Archives"), by **availability** ("Ready", "On order"), and to scenes
that **cover the whole area** rather than clipping a corner of it. All three
are done by the catalogue, in one CQL2 filter.

Dates can be several windows instead of one range. "May of each year for the
last ten years" is eleven windows, not one span from the first May to the
last, which would also return every June through April in between. The
catalogue tests them all in a single query, and 120 windows cost about the
same as one. The result states what it covered
(`"May of 2016 to 2026, 11 windows"`) so the answer can repeat it back.

Product levels live only inside a scene's `SELECTION` value, and each family
spells them its own way (`Level-2A` for Sentinel-2, `L2` for AWiFS, eight
different ones for NISAR). The list of them comes from `archive.py`, which
reads the portal's own catalogue out of the cache `bhd` keeps at
`~/.bhoonidhi/archive.json`. That file is written when the user runs
`bhd archive list`; the API only reads it, and falls back to the levels seen
in the catalogue's items when it is missing. Refresh it with
`bhd archive list --refresh`.

The agent says how it read the question: which months a season meant, which
dates it covered, and when a word has no single meaning ("dry periods") it
asks rather than choosing. A word the catalogue cannot filter (cloud cover,
pass direction, sun angle, off-nadir) is named as not recorded instead of
being quietly dropped, and an empty result carries its reason when the
collection records know it ("Sentinel-1B SAR(IW) has nothing after
2021-12-19").

The agent never downloads: for data it returns the `bhd` commands the user
runs on their own machine under their own Bhoonidhi login. Those commands
search the live portal, so they can also find scenes newer than the catalogue.

## Prerequisites

- **[uv](https://docs.astral.sh/uv/)** and Python ≥ 3.12.
- **A model server** that speaks the OpenAI API and supports tool calling
  (LM Studio, Ollama, llama.cpp, vLLM or OpenAI).
- **`bhoonidhi-downloader`**, installed from PyPI at the version
  `pyproject.toml` pins. The API uses its `Availability` labels, so they
  match what `bhd` prints, and its reader for the `bhd archive` cache.
- **The STAC API.** Without it the agent can look up places but not search
  scenes. See [Catalogue](#catalogue-stac-api).

## Setup

```bash
uv sync --all-packages    # from the repository root
cd apps/api
cp .env.example .env      # the model, the catalogue, place search
```

`.env` (loaded by `config.py`, gitignored):

| Variable          | Meaning                                                | Default                    |
| ----------------- | ------------------------------------------------------ | -------------------------- |
| `OPENAI_BASE_URL` | Any OpenAI-compatible server's base URL                | `http://localhost:1234/v1` |
| `OPENAI_API_KEY`  | Its key (**secret**, never commit); local servers usually need none | _(empty)_ |
| `OPENAI_MODEL`    | Model id                                               | `openai/gpt-oss-20b`       |
| `MODEL_SLOTS`, `MODEL_QUEUE_MAX`, `MODEL_QUEUE_WAIT_S` | The line for the model (`model_queue.py`): questions answered at once (match LM Studio's `parallel`), questions allowed to wait, the longest wait in seconds | `4`, `20`, `180` |
| `FRONTEND_ORIGIN` | Allowed CORS origin (the Next.js dev server)           | `http://localhost:3000`    |
| `STAC_API_URL`    | STAC API base URL; the only scene source. `.env.example` sets the public catalogue | _(empty)_ |
| `SESSIONS_DB`     | SQLite file for conversations                          | `data/sessions.db`         |
| `CONVERSATION_RETENTION_DAYS` | Days a conversation is kept after its last activity (a question, a query, a rename); checked at start and hourly. `0` keeps them forever | `7` |
| `CLIENT_IP_HEADER` | Header holding the visitor's address for the limits below; set only behind a proxy that always writes it (`Cf-Connecting-Ip` behind Cloudflare) | _(empty: the connection's address)_ |
| `GEOCODER_URL`    | Nominatim server for place search (`@` in the palette) | `https://nominatim.openstreetmap.org` |
| `GEOCODER_USER_AGENT` | User-Agent sent to it; Nominatim requires one naming the app | `bhoonidhi-explorer/0.1` |

## Catalogue (STAC API)

`.env.example` points at the public catalogue,
`https://bhoonidhi-stac.ecotrakr.in`, which is enough for development. To
work against a catalogue of your own, build one with
[`bhoonidhi-stac`](https://github.com/geovicco-dev/bhoonidhi-stac), set
`STAC_API_URL` to its STAC API in `apps/api/.env`, and restart the API. The
API reads the collection list once at start.

## Run

```bash
cd apps/api
uv run python run.py
```

Serves on `http://127.0.0.1:8787`, in the foreground. There is no auto-reload:
restart after changing anything under `src/`.

To run the whole explorer (the web app and this API) in a container instead,
see `docs/self-hosting.md`.

## Verify

```bash
curl -s http://127.0.0.1:8787/health
# -> {"status":"ok","tools":4,"catalogue":true}
```

`catalogue: false` with `tools: 1` means `STAC_API_URL` is not set.

## Tests

```bash
uv run pytest apps/api/tests          # from the repository root
uv run ruff check apps/api/src apps/api/tests
```

## Endpoints

Conversation routes need an `X-Client-Id` header: an anonymous per-browser id,
so each browser sees only its own conversations.

| Method | Path                            | Purpose                                                        |
| ------ | ------------------------------- | -------------------------------------------------------------- |
| GET    | `/health`                       | Liveness, tool count, whether the catalogue is on, the model line (`slots`, `answering`, `waiting`). |
| GET    | `/tools`                        | Names of the agent's tools.                                    |
| GET    | `/conversations`                | This browser's conversations, newest first.                   |
| POST   | `/conversations`                | Create an empty conversation.                                  |
| GET    | `/conversations/{id}`           | One conversation: turns (prompt + streamed events) and state. |
| PATCH  | `/conversations/{id}`           | Rename (`title`) or save map state (`state`).                  |
| DELETE | `/conversations/{id}`           | Delete it and its turns.                                       |
| POST   | `/conversations/{id}/fork`      | Copy it (optionally only turns before `upto`) into a new one.  |
| POST   | `/conversations/{id}/chat`      | Run one turn; streams SSE. Body `{message, from_turn?, area?}`: `from_turn` replaces that turn and all later ones (edit / retry); `area` is the area of interest on the map (`{kind: "bbox", west, south, east, north}` or `{kind: "circle", lon, lat, radius_km}`, optional `name`), stored with the turn and passed to the model. A circle is searched as the exact circle. |
| GET    | `/geocode?q=`                   | Places matching a name (Nominatim, cached, one upstream request a second). The agent's place lookup uses the same search. |
| GET    | `/quicklook?url=`               | CORS proxy for a portal quicklook JPEG; the only call to the portal. |
| GET    | `/query/products`               | Query mode: every satellite and product in `bhd`'s product list, with dates, resolution, access and whether the catalogue holds any of its scenes. Checked once per process, at startup. |
| POST   | `/query/check`                  | Query mode: check a query (`{query: {items, area, covers_area, dates: {from, to, yearly}, availability, max_resolution_m}}`) without searching: `{ok, problems, notes}`, each problem naming its field with a fix where one exists. The form calls this on every edit. |
| POST   | `/query/search`                 | Query mode: check a query and search when it has no problems. A query with problems returns `status: "invalid_query"` with each problem and its fix, and is never searched. Nothing is saved. |
| POST   | `/conversations/{id}/query`     | Run a query and save it as a turn, without the model (`{query, from_turn?}`). The agent sees it in later turns. 422 when the query has problems. |
| POST   | `/query/bhd`                    | The `bhd` commands that download the scenes a query found (`{query, scene_ids}`). |
| POST   | `/scene/handoff`                | The `bhd` commands and the MCP prompt that download one scene (`{scene}`). |
| POST   | `/scenes/handoff`               | The same for the scenes chosen in the strip (`{scenes}`, 1 to 100): one saved search over their days, products and a box around their middles, then `--select` of exactly those ids. |
| POST   | `/query/from-search`            | An agent's `search_catalog` arguments as a query, for "Edit query" on its turn. |
| POST   | `/query/from-question`          | A question waiting for the model as a query, for the form it opens (`{text, area, base, search_args?}`): the satellites, sensors, levels, months, years, "ready" and resolution the text names, over the previous search (`base`, or `search_args` from the agent's last search) and the map's area. Satellites with no scenes in the dates are left out. No model or geocoder call. |

Five routes are limited per visitor address over the last minute, since each
costs something upstream: `/conversations/{id}/chat` 6 (the model),
`/query/search` and `/conversations/{id}/query` 30 together (the catalogue),
`/quicklook` 60 (ISRO's server) and `/geocode` 20 (Nominatim). Past a limit
they answer 429 with `Retry-After` and `{"detail": "Too many requests, try
again in N s"}`, which the web app shows as is. Counts live in the API
process's memory (`limits.py`). The address counted is the header
`CLIENT_IP_HEADER` names, or else the connection's address. The Docker image
takes that address from `X-Forwarded-For` only when the request comes from a
proxy listed in `FORWARDED_ALLOW_IPS` (uvicorn's `--proxy-headers`); the
development server does not read it, so there every request counts as one
visitor.

Questions to the model wait in one line for all visitors (`model_queue.py`):
`MODEL_SLOTS` are answered at once and up to `MODEL_QUEUE_MAX` wait, in
order. A waiting question's stream sends `{"type": "waiting", "position",
"wait_s"}` every 2 s (position 1 is next; `wait_s` is estimated from the
last 20 answers) and then `turn` when it starts. It is dropped with an
`error` event after `MODEL_QUEUE_WAIT_S`, and it leaves the line as soon as
the browser stops the stream. A question that arrives with the line full is
refused with 503 and a message. Queries run from the form never use the
model and never wait. While a question waits, the page offers the query form
filled from it (`/query/from-question`); running that query takes the
question out of the line, so the model never answers it and only the query
is saved. `GET /conversations` also returns `retention_days`, which the page
states under its Recent list. `/health` reports `model: {slots, answering,
waiting}`.

## Troubleshooting

- **A product level the user asks for finds nothing, or a new level is
  missing.** The levels come from the `bhd` archive cache
  (`~/.bhoonidhi/archive.json`). If the portal has added a product since that
  file was written, run `bhd archive list --refresh`, then restart the API so
  it re-reads the catalogue. Without the cache the API falls back to the
  levels present in the catalogue's own items, which can miss one that the
  sample did not happen to contain.
- **"Failed to load model … Operation canceled."** (LM Studio) The server had
  unloaded the model (idle time-to-live, or a restart) and the reload did not
  finish. Keep it loaded: in the model's load settings turn off the idle
  time-to-live, or load it with `lms load <model> --ttl 0`.
- **The agent answers with nothing after a tool call.** gpt-oss sometimes
  writes a tool call with broken JSON, and some servers (LM Studio among
  them) drop it from a non-streamed reply without an error. The agent streams every step and repairs the known slip
  (`parse_arguments` in `agent.py`); if a new variant appears, stream the same
  request and look at the raw argument text.
- **Startup exits silently right after "Uvicorn running".** Run it through
  `uv run python run.py`, which pins `loop=asyncio`.
- **The browser shows a NetworkError.** The API isn't running on 8787, or
  `FRONTEND_ORIGIN` doesn't match the Next.js origin.
- **The web app can't reach the API.** `apps/web/.env.local` must set
  `NEXT_PUBLIC_AGENT_API_URL=http://localhost:8787`.
- **Place search says "failed" or is slow.** The public Nominatim server
  allows one request a second per app and blocks clients that ignore it. The
  API waits between requests and caches answers; for heavy use, run your own
  Nominatim and set `GEOCODER_URL`.
