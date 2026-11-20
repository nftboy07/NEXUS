import pytest

from channels.telegram import TelegramChannel
from channels.discord import DiscordChannel
from delivery import deliver


def test_skips_unconfigured_and_processes_others(record, store, log):
    # no telegram token -> skipped_no_config, no exception, discord also skipped
    outcome = deliver(record, "msg", store, [TelegramChannel(log), DiscordChannel(log)], log)
    assert outcome == "skipped_no_config"
    assert store.states[record.dedup_key] == "skipped_no_config"


class FailingChannel:
    name = "failing"
    def __init__(self):
        self.calls = 0
    def send(self, msg, rec):
        self.calls += 1
        raise RuntimeError("boom")


class OkChannel:
    name = "ok"
    def send(self, msg, rec):
        return "sent"


def test_retry_bounded_and_other_channels_still_deliver(record, store, log, monkeypatch):
    monkeypatch.setattr("delivery.time.sleep", lambda *_: None)
    ch = FailingChannel()
    outcome = deliver(record, "msg", store, [ch, OkChannel()], log)
    assert outcome == "failed"
    assert ch.calls == 3  # bounded


def test_dedup_skips_redelivery(record, store, log):
    store.states[record.dedup_key] = "sent"
    ch = OkChannel()
    outcome = deliver(record, "msg", store, [ch], log)
    assert outcome == "sent"  # short-circuits on stored state
