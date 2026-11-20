from format import format_alert


def test_facts_and_assessment_separate(record):
    out = format_alert(record)
    fi, ai = out.index("Facts"), out.index("Assessment")
    assert fi < ai
    assert "0xabc" in out[fi:ai]
    assert "confidence: high" in out[ai:]


def test_pending_surfaced(pending_record):
    out = format_alert(pending_record)
    assert "PENDING" in out.split("\n")[0]


def test_no_assessment_shows_disclaimer(record):
    out = format_alert(record.model_copy(update={"assessment": None}))
    assert "No assessment supplied" in out
