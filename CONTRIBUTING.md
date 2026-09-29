# Contributing

Bug reports, questions, documentation fixes and code are all welcome.

- **Report a bug:** open an issue with the steps to reproduce it, and the
  question you asked or the query you ran.
- **Suggest a feature:** open an issue that describes the problem first, so
  we agree on the direction before code is written.
- **Send a change:** fork, branch from `main`, and open a pull request.

## Setup

You need [pnpm](https://pnpm.io/), [uv](https://docs.astral.sh/uv/) and
Docker. From the repository root:

```bash
pnpm install
uv sync --all-packages
```

Running it: [README.md](README.md) (Docker) and
[`apps/api/README.md`](apps/api/README.md) (development servers).

## Checks

Every pull request runs these; run them before you push:

```bash
pnpm --filter web exec tsc --noEmit
pnpm --filter web exec eslint .
pnpm --filter @workspace/ui exec tsc --noEmit
uv run pytest
uv run ruff check apps/api/src apps/api/tests apps/api/scenarios
docker compose -f deploy/compose.yaml --env-file .env.example config --quiet
```

Add or update a test for any change in behaviour. For a bug fix, a test that
fails before the fix and passes after is the one to write.

## What belongs in a change

- The explorer is for discovery. It never downloads, stages a cart, or asks
  for a Bhoonidhi login. Downloads belong to `bhd` and `bhoonidhi-mcp`,
  which run on the user's own machine under the user's own Bhoonidhi
  account.
- No imagery is stored or served; quicklooks are linked from the portal.
- Credit ISRO-IRS and each foreign provider wherever their data appears.
- Settings that differ between machines are environment variables,
  documented in `.env.example`.

## Commits

Conventional commit titles (`feat(web): …`, `fix(api): …`), one change per
commit, with a body that says why.
