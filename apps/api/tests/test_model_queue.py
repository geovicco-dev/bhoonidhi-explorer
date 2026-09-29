"""The line for the model: places, order, leaving, the limit, the estimate."""
import asyncio

import pytest

from bhoonidhi_api import model_queue
from bhoonidhi_api.model_queue import Full, ModelQueue


def test_answers_at_once_while_there_is_room_then_waits_in_order():
    async def go():
        line = ModelQueue(slots=2, max_waiting=5)
        a, b, c, d = (line.join() for _ in range(4))
        assert a.answering and b.answering
        assert (c.position(), d.position()) == (1, 2)
        assert (line.answering, line.waiting) == (2, 2)
        # An answer finishes: the first in line takes its place.
        a.leave()
        assert c.answering and d.position() == 1
        assert (line.answering, line.waiting) == (2, 1)

    asyncio.run(go())


def test_leaving_the_line_moves_everyone_behind_up():
    async def go():
        line = ModelQueue(slots=1, max_waiting=5)
        first = line.join()
        a, b, c = line.join(), line.join(), line.join()
        b.leave()  # Stop pressed while waiting
        assert (a.position(), c.position()) == (1, 2)
        first.leave()
        assert a.answering and c.position() == 1
        # Leaving twice changes nothing.
        b.leave()
        assert line.waiting == 1

    asyncio.run(go())


def test_a_full_line_refuses_a_new_question():
    async def go():
        line = ModelQueue(slots=1, max_waiting=1)
        line.join()
        line.join()
        assert line.full()
        with pytest.raises(Full):
            line.join()

    asyncio.run(go())


def test_wait_returns_when_the_turn_comes_or_the_time_is_up():
    async def go():
        line = ModelQueue(slots=1, max_waiting=1)
        first = line.join()
        waiting = line.join()
        assert not await waiting.wait(0.01)
        asyncio.get_running_loop().call_later(0.01, first.leave)
        assert await waiting.wait(1)

    asyncio.run(go())


def test_estimate_counts_rounds_of_answers(monkeypatch):
    async def go():
        line = ModelQueue(slots=2, max_waiting=5)
        # Before any answer: the first guess per round of `slots` answers.
        assert line.estimate_s(1) == model_queue.FIRST_GUESS_S
        assert line.estimate_s(3) == 2 * model_queue.FIRST_GUESS_S
        clock = [100.0]
        monkeypatch.setattr(model_queue.time, "monotonic", lambda: clock[0])
        p = line.join()
        clock[0] += 12
        p.leave()
        assert line.estimate_s(2) == 12
        assert line.estimate_s(3) == 24

    asyncio.run(go())
