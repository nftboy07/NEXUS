import pytest

from channels.telegram import TelegramChannel
from channels.discord import DiscordChannel
from delivery import deliver


def test_skips_unconfigured_and_processes_others(record, store, log):
    # no telegram token -> skipped_no_config, no exception, discord also skipped
    outcome = deliver(record, "msg", store, [TelegramChannel(log), DiscordChannel(log)], log)
    assert outcome == "skipped_no_config"
    assert store.states[store.alert_id(record)] == "skipped_no_config"


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


def test_sent_channel_never_resent(record, store, log):
    aid = store.alert_id(record)
    store.channels[(aid, "ok")] = "sent"
    outcome = deliver(record, "msg", store, [OkChannel()], log)
    assert outcome == "sent"
    # already-sent channel short-circuits before send()


class CountingChannel:
    name = "counting"
    def __init__(self):
        self.calls = 0
    def send(self, msg, rec):
        self.calls += 1
        return "sent"


def test_substring_dedup_keys_both_delivered(record, store, log):
    """Keys where one is a substring of the other are distinct rows."""
    other = record.model_copy(update={"dedup_key": record.dedup_key + ":extra"})
    ch = CountingChannel()
    assert deliver(record, "m", store, [ch], log) == "sent"
    assert deliver(other, "m", store, [ch], log) == "sent"
    assert ch.calls == 2
    assert store.alerts[record.dedup_key] != store.alerts[other.dedup_key]
