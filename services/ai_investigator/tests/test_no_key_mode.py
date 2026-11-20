import httpx

from investigate import run_investigation


class SpyTransport(httpx.BaseTransport):
    def __init__(self):
        self.calls = 0

    def handle_request(self, request):
        self.calls += 1
        return httpx.Response(200, json={})


class FakeInvestigationConn:
    """Conn stand-in for investigate tests: captures inserts/updates."""

    def __init__(self, inner):
        self.inner = inner
        self.rows = {}
        self._id = 0

    def execute(self, sql, params=()):
        if "INSERT INTO investigations" in sql:
            self._id += 1
            self.rows[self._id] = {"status": params[2]}

            class C:
                description = None

                def fetchone(_):
                    return (self._id,)
            return C()
        if "UPDATE investigations" in sql:
            row = self.rows[int(params[-1])]
            row["status"] = params[0]
            if "report=" in sql:
                row["report"] = params[1]
            return type("C", (), {"description": None, "fetchone": lambda _: None})()
        return self.inner.execute(sql, params)

    def commit(self):
        pass

    def rollback(self):
        pass


def test_no_key_package_only(conn, monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    spy = SpyTransport()
    wrapped = FakeInvestigationConn(conn)
    inv = run_investigation(wrapped, 1, "0xtx1", transport=spy)
    assert wrapped.rows[inv]["status"] == "awaiting_model"
    assert spy.calls == 0
