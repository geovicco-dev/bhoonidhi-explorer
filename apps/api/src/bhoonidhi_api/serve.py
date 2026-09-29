"""The explorer as one web server, for the Docker image.

Serves the exported web app at ``/`` and the API under ``/api``, so the
browser talks to a single origin and needs no CORS. Development does not use
this module: there the web app runs on its own dev server and calls the API at
its root (see ``run.py``).

The web files are copied into the image at build time; ``WEB_ROOT`` says
where they are.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from .main import app as api

WEB_ROOT = Path(os.environ.get("WEB_ROOT", "/app/web"))


class _WebFiles(StaticFiles):
    """The exported web app. Unknown paths get the export's own not-found
    page (html=True). Hashed build files never change, so browsers keep them
    for a year; everything else is re-checked on each visit."""

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        if path.startswith("_next/static/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


@asynccontextmanager
async def lifespan(_: FastAPI):
    # A mounted app's own start-up (database, catalogue warm-up) does not run
    # on its own; run it here.
    async with api.router.lifespan_context(api):
        yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/api", api)
app.mount("/", _WebFiles(directory=WEB_ROOT, html=True), name="web")
