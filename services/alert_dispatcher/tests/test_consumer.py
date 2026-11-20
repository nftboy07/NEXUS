import json

from consumer import process_record


class OkChannel:
    name = "ok"
    def send(self, msg, rec):
        return "sent"


def test_valid_record_delivered(record, store, log):
    fields = {"record": json.dumps(record.model_dump())}
    assert process_record(fields, store, [OkChannel()], log) is True
    assert store.states[record.dedup_key] == "sent"


def test_malformed_parked_not_crashed(store, log):
    assert process_record({"record": "{not json"}, store, [OkChannel()], log) is False
    assert process_record({"record": json.dumps({"kind": "x"})}, store, [OkChannel()], log) is False
