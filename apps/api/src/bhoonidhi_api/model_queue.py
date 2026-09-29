"""The line for the model.

A local model answers a few questions at a time (LM Studio's `parallel`
setting); sending it more at once only makes every answer slower. So a
question takes one of MODEL_SLOTS places, and the rest wait in order: at most
MODEL_QUEUE_MAX of them, each for at most MODEL_QUEUE_WAIT_S seconds. A
question whose visitor presses Stop or closes the page gives up its place at
once. Queries from the form never use the model and never wait here.

The line lives in the API process's memory, like the request limits: enough
for the single server process the image runs.
"""
from __future__ import annotations

import asyncio
import math
import time
from collections import deque

from .config import settings

# How long an answer takes before any has been timed; the estimate then
# follows the last few real answers.
FIRST_GUESS_S = 30.0


class Full(Exception):
    """The line is at MODEL_QUEUE_MAX."""


class Place:
    """One question's place: waiting, then answering, then gone."""

    def __init__(self, line: ModelQueue) -> None:
        self._line = line
        self._turn: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._started: float | None = None
        self._gone = False

    @property
    def answering(self) -> bool:
        return self._turn.done()

    def position(self) -> int:
        """1 for the next question to start; 0 once this one has started."""
        return 0 if self.answering else self._line._waiting.index(self) + 1

    async def wait(self, seconds: float) -> bool:
        """Wait up to `seconds` for the question's turn; True once it has it."""
        try:
            await asyncio.wait_for(asyncio.shield(self._turn), seconds)
        except TimeoutError:
            pass
        return self.answering

    def leave(self) -> None:
        """Give up the place, or the model once answered. Safe to call twice."""
        if self._gone:
            return
        self._gone = True
        if self.answering:
            self._line._finished(time.monotonic() - (self._started or time.monotonic()))
        else:
            self._line._waiting.remove(self)

    def _start(self) -> None:
        self._started = time.monotonic()
        self._turn.set_result(None)


class ModelQueue:
    def __init__(self, slots: int, max_waiting: int) -> None:
        self.slots = max(1, slots)
        self.max_waiting = max(0, max_waiting)
        self._answering = 0
        self._waiting: deque[Place] = deque()
        self._durations: deque[float] = deque(maxlen=20)

    @property
    def answering(self) -> int:
        return self._answering

    @property
    def waiting(self) -> int:
        return len(self._waiting)

    def full(self) -> bool:
        return self._answering >= self.slots and len(self._waiting) >= self.max_waiting

    def join(self) -> Place:
        """A place in line, answering at once when the model has room.
        Raises Full when the line is at its limit."""
        place = Place(self)
        if self._answering < self.slots and not self._waiting:
            self._answering += 1
            place._start()
        elif len(self._waiting) >= self.max_waiting:
            raise Full
        else:
            self._waiting.append(place)
        return place

    def estimate_s(self, position: int) -> int:
        """Seconds until the question at `position` starts: it waits for
        `position` answers to finish, `slots` of them at a time."""
        each = sum(self._durations) / len(self._durations) if self._durations else FIRST_GUESS_S
        return round(math.ceil(position / self.slots) * each)

    def _finished(self, took_s: float) -> None:
        self._durations.append(took_s)
        self._answering -= 1
        if self._waiting:
            self._answering += 1
            self._waiting.popleft()._start()


line = ModelQueue(settings.model_slots, settings.model_queue_max)
