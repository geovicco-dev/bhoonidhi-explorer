"""Run the agent backend.

Pins loop=asyncio (uvicorn's default is uvloop), the loop it has always run
on. Run with:

    uv run python run.py
"""
import uvicorn
from bhoonidhi_api.main import app

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8787, loop="asyncio", log_level="info")
