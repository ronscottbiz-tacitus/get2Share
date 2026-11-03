"""Firestore transactions that cope with many hosts touching the same budget at once.

A busy document makes Firestore abort a transaction, and its client gives up after a few quick
tries. That never overspends, since nothing commits, but the host shouldn't see an error for it.
So each transaction gets more tries, then whole new rounds after a short random wait."""
from __future__ import annotations

import random
import time

from .service import ApiError

COMMIT_ATTEMPTS = 10
ROUNDS = 6
MSG_BUSY = "Walkthrough is busy right now. Try again in a minute."


def _contended(e: ValueError) -> bool:
    from google.api_core.exceptions import Aborted
    return isinstance(e.__cause__, Aborted)


def retry_contended(attempt, *, rounds: int = ROUNDS, sleep=time.sleep, rand=random.random):
    """Runs attempt(), starting over when it failed only because the data was busy."""
    for i in range(rounds):
        try:
            return attempt()
        except ValueError as e:
            if not _contended(e):
                raise
            if i < rounds - 1:
                sleep((0.2 * 2 ** i) * (0.5 + rand()))
    raise ApiError(503, MSG_BUSY)


def run_transaction(db, fn):
    from google.cloud import firestore

    @firestore.transactional
    def go(tx):
        return fn(tx)
    return retry_contended(lambda: go(db.transaction(max_attempts=COMMIT_ATTEMPTS)))
