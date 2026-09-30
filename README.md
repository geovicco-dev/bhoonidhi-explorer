# Bhoonidhi Explorer

Find satellite scenes in ISRO's Bhoonidhi archive by asking in plain words or
by filling in a query, see them on a map, and leave with the `bhd` commands
that download them.

> **Unofficial and metadata-only.** Bhoonidhi Explorer is not
> affiliated with or endorsed by ISRO or NRSC. It stores scene footprints and
> descriptive fields only; it never stores or serves imagery, and it never
> downloads. Metadata © ISRO-IRS (and each foreign mission's provider), reused
> under the open-data terms of the
> [Bhoonidhi EULA](https://bhoonidhi.nrsc.gov.in/bhoonidhi/htmls/TnC.html).
> Availability is as of the last update of the STAC API's data. Downloading any scene needs
> your own free Bhoonidhi account.

You can search the metadata without an account or API approval. Downloads
run on your own machine, under your own Bhoonidhi login, through the
explorer's sibling tools:

- [`bhoonidhi-downloader`](https://github.com/geovicco-dev/bhoonidhi-downloader)
  (`bhd`): the command line and Python SDK that searches the live portal and
  downloads scenes.
- [`bhoonidhi-mcp`](https://github.com/geovicco-dev/bhoonidhi-mcp): the same,
  for AI agents.
- [`bhoonidhi-stac`](https://github.com/geovicco-dev/bhoonidhi-stac): the
  STAC API of scene metadata the explorer searches.

Under the
[Indian Space Policy 2023](https://www.isro.gov.in/media_isro/pdf/IndianSpacePolicy2023.pdf),
ISRO's remote-sensing data of 5 m ground sampling distance and coarser is free
and open to all.

## Run it

You need Docker with Compose, and a model server that speaks the OpenAI API
and supports tool calling (LM Studio, Ollama, llama.cpp, vLLM or OpenAI).

```bash
git clone https://github.com/geovicco-dev/bhoonidhi-explorer.git
cd bhoonidhi-explorer
cp .env.example .env          # set OPENAI_BASE_URL and OPENAI_MODEL
docker compose -f deploy/compose.yaml --env-file .env up -d
```

Open http://localhost:8080 and ask, for example, "LISS-4 scenes over Delhi in
August 2026".

The explorer reads scenes from the public Bhoonidhi STAC API,
https://bhoonidhi-stac.ecotrakr.in, unless `STAC_API_URL` names another. The
[self-hosting guide](docs/self-hosting.md) covers every setting and backups.

## What is in this repository

| Path | What it is |
|---|---|
| `apps/web` | The web app (Next.js), exported as static files |
| `apps/api` | The API (FastAPI): conversations, the agent, the query form, place search, quicklooks. See [`apps/api/README.md`](apps/api/README.md) |
| `packages/ui` | The design tokens, the shared components and the Tailwind setup |
| `deploy` | The Dockerfile and `compose.yaml` |
| `docs` | The self-hosting guide |

## Where the scenes come from

The scenes come from a [STAC](https://stacspec.org/) API over the
Bhoonidhi portal's scene metadata, one collection per satellite and sensor,
so a search answers in about a second instead of the portal's thirty. It is
built and kept current by
[`bhoonidhi-stac`](https://github.com/geovicco-dev/bhoonidhi-stac), whose
methods page lists every field and rule. Quicklook images stay on the portal:
the explorer links to them and never copies them.

What the STAC API cannot tell you:

- Availability changes: a scene that could be downloaded when the STAC API
  was last updated may need ordering now. `bhd` searches the live portal when you run
  it, and says what it finds.
- The STAC API lags the portal by up to a week.
- Footprints are the portal's; some products report a scene's bounding box
  rather than its exact outline.

## Develop

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
pnpm --filter web dev                 # http://localhost:3000

uv sync --all-packages                # the API's Python environment
cd apps/api && cp .env.example .env   # model, STAC API, place search
uv run python run.py                  # http://127.0.0.1:8787
```

[CONTRIBUTING.md](CONTRIBUTING.md) lists the checks every change passes.

## Licence

The code is MIT-licensed ([LICENSE](LICENSE)). The licence covers the code
only. The scene metadata and the quicklooks belong to NRSC/ISRO and to the
foreign missions' providers, and stay under their terms.
