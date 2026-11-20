"""LLM_PROVIDER=deterministic: offline template report, zero HTTP, every
fact cites the package, and it passes the same validator."""
import httpx

from deterministic import MODEL_NAME, build_report
from investigate import run_investigation
from llm import model_configured
from test_no_key_mode import FakeInvestigationConn, SpyTransport
from validate import validate


def test_template_report_cites_only_package(conn, package):
    conn.ALERTS = []
    rep = build_report(package)
    ok, problems = validate(rep, package)
    assert ok, problems
    facts = [f for f in rep.findings if f.kind == "fact"]
    assert facts and all(f.citations for f in facts)
    assert {(c.tx_hash, c.block_number) for c in rep.citations} == {("0xtx1", 100)}
    assert "0xtx1" in facts[0].statement and "100" in facts[0].statement
    assert rep.confidence["level"] == "low"


def test_template_includes_alert_context(conn, monkeypatch):
    from package import build_package
    monkeypatch.setattr(type(conn), "ALERTS", [
        {"id": 7, "source_engine": "wallet_intelligence", "kind": "whale_transfer",
         "record": {"facts": {"tx_hash": "0xtx1", "rule": "WHALE_THRESHOLD_ETH=100"}}}])
    pkg = build_package(conn, 1, "0xtx1")
    assert pkg.alerts[0]["id"] == 7
    rep = build_report(pkg)
    assert any("whale_transfer alert (alert id 7)" in f.statement for f in rep.findings)
    assert validate(rep, pkg)[0]


def test_missing_tx_reports_nothing_as_fact(conn):
    from package import build_package
    pkg = build_package(conn, 1, "0xnope")
    rep = build_report(pkg)
    assert not [f for f in rep.findings if f.kind == "fact"]
    assert rep.citations == []
    assert any("0xnope" in m for m in rep.missing_evidence)


def test_pipeline_deterministic_no_http(conn, monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "deterministic")
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    assert model_configured()
    spy = SpyTransport()
    wrapped = FakeInvestigationConn(conn)
    inv = run_investigation(wrapped, 1, "0xtx1", transport=spy)
    assert wrapped.rows[inv]["status"] == "complete"
    assert spy.calls == 0
    assert MODEL_NAME  # recorded as the model name


def test_base_url_required_for_http_provider(monkeypatch):
    from llm import ModelNotConfigured, call_model
    import pytest
    monkeypatch.delenv("LLM_BASE_URL", raising=False)
    assert not model_configured()
    with pytest.raises(ModelNotConfigured):
        call_model("p", "{}", api_key="k", model="m")


def test_base_url_used(monkeypatch):
    from llm import call_model
    seen = {}

    class T(httpx.BaseTransport):
        def handle_request(self, req):
            seen["url"] = str(req.url)
            return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    call_model("p", "{}", transport=T(), api_key="k", model="m",
               base_url="http://ollama:11434/v1/")
    assert seen["url"] == "http://ollama:11434/v1/chat/completions"
