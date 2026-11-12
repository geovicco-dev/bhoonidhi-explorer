# Self-hosting

The explorer runs as one container from `deploy/compose.yaml`, configured by
one `.env` file at the repository root (copy `.env.example`).

```bash
cp .env.example .env
docker compose -f deploy/compose.yaml --env-file .env up -d
docker compose -f deploy/compose.yaml --env-file .env ps
curl -s localhost:8080/api/health     # "status":"ok", "catalogue":true, and which model answers
```

## What runs

One container, `explorer`: the web app at `/` and the API at `/api`, on
`EXPLORER_PORT`. It needs three things outside it:

```
browser ─► explorer :8080 ─┬─ /       the web app (static files)
                           └─ /api/*  the API ─┬─► the STAC API (STAC_API_URL)
                                               ├─► the model (OPENAI_BASE_URL or Anthropic's API)
                                               ├─► Nominatim (place search)
                                               └─► bhoonidhi.nrsc.gov.in (quicklooks, product list)
```

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `EXPLORER_PORT`, `EXPLORER_BIND` | Where the explorer listens; `0.0.0.0` when a reverse proxy runs on another host | `8080`, `127.0.0.1` |
| `EXPLORER_IMAGE`, `EXPLORER_TAG` | The image and its tag; point them at a published image to skip building | `bhoonidhi-explorer`, `local` |
| `MODEL_PROVIDER` | Which model answers: `openai` for any OpenAI-compatible server, `anthropic` for Claude | `openai` |
| `MODEL_FALLBACK` | The other provider, which answers when `MODEL_PROVIDER` fails (see "The model"); empty for none | empty |
| `OPENAI_BASE_URL` | Any OpenAI-compatible server with tool calling | required for `openai` |
| `OPENAI_API_KEY` | Its key (secret); local servers usually need none | empty |
| `OPENAI_MODEL` | Model id | required for `openai` |
| `ANTHROPIC_API_KEY` | A key from the Anthropic Console (secret) | required for `anthropic` |
| `ANTHROPIC_MODEL` | Claude model id | `claude-haiku-5-5` |
| `ANTHROPIC_EFFORT`, `ANTHROPIC_THINKING` | How hard Claude works on each step (`low` to `max`), and whether it thinks first (`disabled`, `adaptive`, `between_tools`); empty uses the model's default. Not every model accepts every value | empty, empty |
| `ANTHROPIC_MAX_TOKENS` | The most one step may write, thinking included | `4096` |
| `ANTHROPIC_CACHE_TTL` | How long the start of each request stays cached for the next step: `5m`, `1h` (cache writes cost twice as much) or `off` | `5m` |
| `MODEL_FALLBACK_COOLDOWN_S`, `MODEL_FIRST_TOKEN_TIMEOUT_S` | After a failure, how long new questions go to the fallback; and, with a fallback set, how long a silent provider is waited for | `300`, `20` |
| `MODEL_BUDGET_DAILY_USD`, `MODEL_BUDGET_MONTHLY_USD` | Spend ceilings in US dollars per UTC day and calendar month; past one, the fallback answers until the day or month ends. `0` is no ceiling | `0`, `0` |
| `MODEL_HISTORY_TURNS` | Earlier turns sent to the model whole; older ones keep only the question and the answer. `0` sends every turn whole | `0` |
| `STAC_API_URL` | The STAC API the scenes come from | `https://bhoonidhi-stac.ecotrakr.in` |
| `STAC_PUBLIC_URL` | The same STAC API at the address visitors' browsers reach, for the scene card's "STAC Item" link; set it when `STAC_API_URL` is an address only the explorer reaches | empty: `STAC_API_URL` |
| `GEOCODER_URL`, `GEOCODER_USER_AGENT` | Nominatim for place search; its policy requires a User-Agent naming the app | public Nominatim |
| `CONVERSATION_RETENTION_DAYS` | Days a conversation is kept after its last activity; `0` keeps them forever | `7` |
| `MODEL_SLOTS`, `MODEL_QUEUE_MAX`, `MODEL_QUEUE_WAIT_S` | The line for the model: questions answered at once (match your model server's parallel limit), questions allowed to wait, and the longest wait in seconds. A question past either limit is refused with a message pointing to the query form | `4`, `20`, `180` |
| `FORWARDED_ALLOW_IPS`, `CLIENT_IP_HEADER` | Which proxies to believe, and which header names the visitor; see "Behind a reverse proxy" | `127.0.0.1`, empty |

A provider in use without its model, address or key stops the server at
start with a message naming the setting.

## The published image

Each release is published as `ghcr.io/geovicco-dev/bhoonidhi-explorer`,
tagged with its version. To run it instead of building, set in `.env`:

```bash
EXPLORER_IMAGE=ghcr.io/geovicco-dev/bhoonidhi-explorer
EXPLORER_TAG=0.1.0
```

and start with `docker compose -f deploy/compose.yaml --env-file .env up -d --no-build`.

Every published image is built by `deploy/build-image.sh` from the
release's commit, with base images pinned by digest; the image's
`org.opencontainers.image.revision` label names that commit
(`docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <image>`).

## The model

The explorer's agent calls tools (place lookup, STAC API search, `bhd`
commands), so the model must support tool calling. Two kinds of model can
answer:

- **An OpenAI-compatible server** (`MODEL_PROVIDER=openai`): LM Studio,
  Ollama, llama.cpp, vLLM or OpenAI. `host.docker.internal` in
  `OPENAI_BASE_URL` reaches a server on the machine running Docker, on
  Linux as well. A turn usually takes 10 to 40 seconds on a local model.
- **Claude** (`MODEL_PROVIDER=anthropic`) through Anthropic's own API. Each
  question, the conversation so far and the tools' results are sent to
  Anthropic. Give the explorer a key in an Anthropic workspace of its own
  with a spend limit: the site is open to anyone, and that limit caps what
  they can cost you. On Claude Haiku 5.5 with `ANTHROPIC_EFFORT=low` and
  `ANTHROPIC_THINKING=disabled`, a question cost about $0.001 and took
  about 5 seconds in our tests. The start of each request (the
  instructions, the tools and the conversation so far) is cached, so most
  of every step after the first is read from the cache at a tenth of the
  price.

The STAC API itself answers in about a second.

**Fallback.** With `MODEL_FALLBACK` set to the other provider, the explorer
switches by itself when `MODEL_PROVIDER` fails, and the visitor sees no
error:

| What happens | What the explorer does |
|---|---|
| No connection, nothing received for `MODEL_FIRST_TOKEN_TIMEOUT_S`, a server error or "overloaded" | The fallback answers; new questions go to it for `MODEL_FALLBACK_COOLDOWN_S`, then `MODEL_PROVIDER` is tried again |
| Rate limited | The same, for as long as the provider's `Retry-After` asks if that is longer |
| A refused key | The same, logged as an error |
| Out of credit or past the provider's spend limit | The fallback answers, and `MODEL_PROVIDER` is tried again every hour |
| `MODEL_BUDGET_DAILY_USD` or `MODEL_BUDGET_MONTHLY_USD` reached | The fallback answers until the UTC day or the month ends. An answer under way when the budget is passed is finished by the same model |
| Any other refused request | The fallback answers that question only |
| A failure halfway through an answer | The fallback carries on from the steps already done |

When neither can answer, the visitor gets one plain message pointing to
the query form, which needs no model. The budgets count only models with a
known price (Claude's are built in); a local model is free to them.

**What to watch.** `/api/health` shows under `model` who answers now
(`answered_by`: `provider`, `fallback` or `nobody`), the reason when it is
not the provider, and the day's and month's spend when a budget is set.
Each answer writes one `model_usage` line to the log with the model, its
steps, the tokens by kind and the cost; a switch writes one warning line
with the reason. The lines never contain the question.

## The STAC API

By default the explorer reads the public Bhoonidhi STAC API,
https://bhoonidhi-stac.ecotrakr.in, which is read-only and needs no key. To
run your own, see [`bhoonidhi-stac`](https://github.com/geovicco-dev/bhoonidhi-stac)
and set `STAC_API_URL` to its STAC API. The explorer reads the collection
list once at start, so restart it after the STAC API gains a collection.

Each scene card links to the scene's STAC item, which the visitor's browser
opens directly from the STAC API. When the explorer reaches the STAC API on
an address visitors cannot open (a LAN address, a container name), set
`STAC_PUBLIC_URL` to its public address; the link is built from that.

## How the image is built

- **One origin, one port.** The web app calls the API at `/api` on the same
  address, so the browser needs no CORS, one image works at any hostname, and
  a reverse proxy needs one plain host rule with no path rewriting.
- **The API serves the web files.** The web app is one page with no
  server-side features, so `next build` exports plain files
  (`output: "export"` in `apps/web/next.config.ts`), and
  `bhoonidhi_api.serve` serves them beside the API.
- **Build-time settings.** Next.js writes `NEXT_PUBLIC_*` values into the
  JavaScript during the build; the basemap URLs and `/api` are build
  arguments with defaults in `deploy/explorer.Dockerfile`.
- **One lock for Python.** The API installs from `uv.lock`, so the image and
  development run the same versions.
- **The product list at start-up.** Before the server starts,
  `apps/api/docker-entrypoint.sh` runs `bhd archive export --refresh`: one
  request to the Bhoonidhi portal, no login. The result is kept on the
  `bhd-cache` volume, so a restart while the portal is unreachable uses the
  saved list.
- **Limits and logs.** `mem_limit` and `cpus` cap the container; logs rotate
  at 3 x 10 MB.

## Behind a reverse proxy

The API limits each visitor's requests per minute (questions, searches,
quicklooks, place searches), so it has to know who the visitor is. Behind a
proxy every request arrives from the proxy's address, and the visitor's own
address is in a header. Which header to believe depends on the proxy:

- **A proxy that sets `X-Forwarded-For`** (nginx, Traefik, Caddy): put the
  proxy's address in `FORWARDED_ALLOW_IPS`. The server then reads the
  visitor's address and `https` from that proxy's headers, and from no one
  else's. Leave `CLIENT_IP_HEADER` empty.
- **Cloudflare** (proxied DNS or a tunnel): set
  `CLIENT_IP_HEADER=Cf-Connecting-Ip`. Cloudflare writes that header itself,
  while it adds to an `X-Forwarded-For` the visitor sent, so the visitor
  could choose the address counted there. Set it only when every request
  passes through Cloudflare: otherwise a visitor can send the header
  directly.

## Data and backups

- **`explorer-data`** holds `sessions.db`, every conversation. A conversation
  is deleted, with its messages, once it has had no activity for
  `CONVERSATION_RETENTION_DAYS` days; the check runs at start and hourly.
  Take a consistent copy while it runs with
  `docker compose -f deploy/compose.yaml exec explorer python -c "import sqlite3; sqlite3.connect('/app/data/sessions.db').backup(sqlite3.connect('/app/data/backup.db'))"`,
  then copy `backup.db` out of the volume.
- **`bhd-cache`** holds the product list and is rebuilt on every start.

## Footprint

Measured on a laptop: the explorer idles at about 105 MB of memory (limit
768 MB).
