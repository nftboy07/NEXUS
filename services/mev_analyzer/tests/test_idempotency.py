import json
import logging

from blocks import analyze_range
from findings import RunStats

from test_sandwich import planted


def test_repeated_analysis_no_duplicates(store):
    store.rows[1] = planted()
    sent = []
    xadd = lambda stream, fields: sent.append((stream, fields))  # noqa: E731
    stats = RunStats()
    n1 = analyze_range(store, 1, 100, 100, {}, 0.5, stats, xadd, logging.getLogger("t"))
    n2 = analyze_range(store, 1, 90, 110, {}, 0.5, stats, xadd, logging.getLogger("t"))
    assert n1 == 1 and n2 == 0
    assert len(store.findings) == 1
    # high-confidence finding -> alert emitted once, in alert_dispatcher's shape
    assert len(store.alerts) == 1 and len(sent) == 1
    stream, fields = sent[0]
    assert stream == "nexus:alerts"
    rec = json.loads(fields["record"])
    assert rec["source_engine"] == "mev_analyzer" and rec["chain_id"] == 1
    assert rec["dedup_key"] == fields["dedup_key"] == "mev_analyzer:potential_sandwich:0xa1"
    assert rec["facts"]["evidence"][0]["tx_hash"] == "0xa1"
    assert stats.summary()["findings"] == {"potential_sandwich": 1}
