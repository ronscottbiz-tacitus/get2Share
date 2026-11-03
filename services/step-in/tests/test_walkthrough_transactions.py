"""A busy budget document means try again, never an error the host sees right away."""
import pytest
from google.api_core.exceptions import Aborted

from walkthrough.service import ApiError
from walkthrough.transactions import retry_contended


def _busy():
    try:
        raise Aborted("Transaction lock timeout.")
    except Aborted as e:
        raise ValueError("Failed to commit transaction in 10 attempts.") from e


def test_tries_again_until_it_goes_through():
    calls, waits = [], []

    def attempt():
        calls.append(1)
        if len(calls) < 3:
            _busy()
        return "done"

    assert retry_contended(attempt, sleep=waits.append, rand=lambda: 0.5) == "done"
    assert len(calls) == 3 and len(waits) == 2 and waits[1] > waits[0]


def test_gives_a_friendly_busy_message_in_the_end():
    calls, waits = [], []

    def attempt():
        calls.append(1)
        _busy()

    with pytest.raises(ApiError) as e:
        retry_contended(attempt, rounds=3, sleep=waits.append)
    assert e.value.status == 503 and len(calls) == 3 and len(waits) == 2


def test_other_errors_are_not_retried():
    calls = []

    def attempt():
        calls.append(1)
        raise ValueError("a real bug")

    with pytest.raises(ValueError):
        retry_contended(attempt, sleep=lambda _: None)
    assert len(calls) == 1


def test_a_limit_answer_is_not_retried():
    calls = []

    def attempt():
        calls.append(1)
        raise ApiError(429, "over budget")

    with pytest.raises(ApiError) as e:
        retry_contended(attempt, sleep=lambda _: None)
    assert e.value.status == 429 and len(calls) == 1
