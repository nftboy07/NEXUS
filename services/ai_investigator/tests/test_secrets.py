import httpx
import json

from investigate import run_investigation
from test_no_key_mode import FakeInvestigationConn

KEY = "sk-test-secret-DO-NOT-LEAK"


def _resp(payload):
    return httpx.Response(200, json={
        "choices": [{"message": {"content": payload}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    })


class ReportTransport(httpx.BaseTransport):
    def __init__(self, payload):
        self.payload = payload

    def handle_request(self, request):
        # the key may go over the wire as auth — but must never be stored
        return _resp(self.payload)


def test_key_never_stored_or_logged(conn, package, caplog):
    import json as j
    valid = open("tests/fixtures/report_valid.json").read()
    wrapped = FakeInvestigationConn(conn)
    with caplog.at_level("DEBUG"):
        inv = run_investigation(wrapped, 1, "0xtx1",
                                transport=ReportTransport(valid),
                                api_key=KEY, model="stub-model")
    stored = j.dumps(wrapped.rows[inv])
    assert wrapped.rows[inv]["status"] == "complete"
    for text in (stored, caplog.text, package.model_dump_json()):
        assert KEY not in text
