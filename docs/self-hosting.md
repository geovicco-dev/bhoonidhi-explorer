# Self-hosting

The explorer runs as one container from `deploy/compose.yaml`, configured by
one `.env` file at the repository root (copy `.env.example`).

```bash
cp .env.example .env
docker compose -f deploy/compose.yaml --env-file .env up -d
docker compose -f deploy/compose.yaml --env-file .env ps
curl -s localhost:8080/api/health     # {"status":"ok","tools":4,"catalogue":true}
```

## What runs

One container, `explorer`: the web app at `/` and the API at `/api`, on
`EXPLORER_PORT`. It needs three things outside it:

```
browser ─► explorer :8080 ─┬─ /       the web app (static files)
                           └─ /api/*  the API ─┬─► the STAC API (STAC_API_URL)
                                               ├─► the model (OPENAI_BASE_URL)
                                               ├─► Nominatim (place search)
                                               └─► bhoonidhi.nrsc.gov.in (quicklooks, product list)
```

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `EXPLORER_PORT`, `EXPLORER_BIND` | Where the explorer listens; `0.0.0.0` when a reverse proxy runs on another host | `8080`, `127.0.0.1` |
| `EXPLORER_IMAGE`, `EXPLORER_TAG` | The image and its tag; point them at a published image to skip building | `bhoonidhi-explorer`, `local` |
| `OPENAI_BASE_URL` | Any OpenAI-compatible server with tool calling | required |
| `OPENAI_API_KEY` | Its key (secret); local servers usually need none | empty |
| `OPENAI_MODEL` | Model id | required |
| `STAC_API_URL` | The STAC API the scenes come from | `https://bhoonidhi-stac.ecotrakr.in` |
| `STAC_PUBLIC_URL` | The same STAC API at the address visitors' browsers reach, for the scene card's "STAC Item" link; set it when `STAC_API_URL` is an address only the explorer reaches | empty: `STAC_API_URL` |
| `GEOCODER_URL`, `GEOCODER_USER_AGENT` | Nominatim for place search; its policy requires a User-Agent naming the app | public Nominatim |
| `CONVERSATION_RETENTION_DAYS` | Days a conversation is kept after its last activity; `0` keeps them forever | `7` |
| `MODEL_SLOTS`, `MODEL_QUEUE_MAX`, `MODEL_QUEUE_WAIT_S` | The line for the model: questions answered at once (match your model server's parallel limit), questions allowed to wait, and the longest wait in seconds. A question past either limit is refused with a message pointing to the query form | `4`, `20`, `180` |
| `FORWARDED_ALLOW_IPS`, `CLIENT_IP_HEADER` | Which proxies to believe, and which header names the visitor; see "Behind a reverse proxy" | `127.0.0.1`, empty |

A required value that is missing stops Compose with a message naming it.

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
commands), so the model must support tool calling. `host.docker.internal` in
`OPENAI_BASE_URL` reaches a server on the machine running Docker, on Linux as
well. A turn usually takes 10 to 40 seconds on a local model; the STAC API
itself answers in about a second.

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
