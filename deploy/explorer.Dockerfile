# syntax=docker/dockerfile:1
# The explorer in one image: the web app, exported as static files, served by
# the API, which answers under /api (apps/api/src/bhoonidhi_api/serve.py).
# Build context: the repository root. Releases are built with
# deploy/build-image.sh.
#
# Base images are pinned by digest (the tag beside each is for reading), so
# every build of a release starts from the same images.

# --- the web app ---------------------------------------------------------------
FROM node:24.21.0-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS web
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@10.33.4
WORKDIR /repo
# Dependencies first, so a code change does not re-install them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/typescript-config/package.json packages/typescript-config/
RUN pnpm install --frozen-lockfile --filter web...
COPY apps/web apps/web
COPY packages packages
COPY tsconfig.json turbo.json ./
# Written into the JavaScript at build time. The API is on the same origin
# under /api, so one image works at any address.
ARG NEXT_PUBLIC_BASEMAP_URL=https://tiles.openfreemap.org/styles/liberty
ARG NEXT_PUBLIC_BASEMAP_DARK_URL=https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json
ARG NEXT_PUBLIC_AGENT_API_URL=/api
RUN pnpm --filter web build

# --- the API and its dependencies ------------------------------------------------
FROM ghcr.io/astral-sh/uv:0.12.18@sha256:3adc3706091ce7c2fe595e669628caedd6d951551b92b258b7e7dbe06d9440bc AS uv

FROM python:3.12.14-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f AS api
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /repo
# Dependencies first, from the workspace lock, so a code change does not
# re-install them.
COPY pyproject.toml uv.lock .python-version ./
COPY apps/api/pyproject.toml apps/api/
RUN uv sync --frozen --no-dev --package bhoonidhi-api --no-install-workspace
COPY apps/api/src apps/api/src
RUN uv sync --frozen --no-dev --package bhoonidhi-api --no-editable

# --- the image that runs ---------------------------------------------------------
FROM python:3.12.14-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /app/data /home/app/.bhoonidhi \
 && chown app:app /app/data /home/app/.bhoonidhi
COPY --from=api /app/.venv /app/.venv
COPY --from=web /repo/apps/web/out /app/web
COPY apps/api/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    WEB_ROOT=/app/web \
    SESSIONS_DB=/app/data/sessions.db
WORKDIR /app
USER app
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
# loop=asyncio: the loop run.py uses in development. uvicorn reads
# X-Forwarded-For and X-Forwarded-Proto only from the proxies listed in
# FORWARDED_ALLOW_IPS (docs/self-hosting.md, "Behind a reverse proxy").
CMD ["uvicorn", "bhoonidhi_api.serve:app", "--host", "0.0.0.0", "--port", "8080", \
     "--loop", "asyncio", "--proxy-headers"]
