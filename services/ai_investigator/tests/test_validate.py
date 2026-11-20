import json

from report_schema import InvestigationReport
from validate import validate

from conftest import FIX


def load(name):
    return json.loads((FIX / name).read_text())


def test_wellformed_report_passes(package):
    rep = InvestigationReport.model_validate(load("report_valid.json"))
    ok, problems = validate(rep, package)
    assert ok, problems


def test_fabricated_citation_fails_and_names_hash(package):
    rep = InvestigationReport.model_validate(load("report_fake_citation.json"))
    ok, problems = validate(rep, package)
    assert not ok
    assert any("0xdeadbeef" in p for p in problems)


def test_fact_without_citation_fails(package):
    rep = InvestigationReport.model_validate({
        "findings": [{"kind": "fact", "statement": "Alice sent 50 tokens", "citations": []}],
        "citations": [],
        "confidence": {"level": "low", "rationale": "no evidence"},
        "alternative_explanations": [], "missing_evidence": [], "next_steps": [],
    })
    ok, problems = validate(rep, package)
    assert not ok
    assert any("fact finding lacks a valid citation" in p for p in problems)


def test_malformed_response_rejected_by_schema():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        InvestigationReport.model_validate(load("report_malformed.json"))
