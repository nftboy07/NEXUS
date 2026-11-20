import json
from pathlib import Path

from liquidations import decode_liquidation, load_protocols

LOG = json.loads((Path(__file__).parent / "fixtures" / "liquidation_log.json").read_text())


def test_recorded_aave_v3_liquidation_decodes():
    protocols = load_protocols()
    row = {
        "chain_id": 1,
        "contract": LOG["address"],
        "topics": LOG["topics"],
        "data": LOG["data"],
        "transaction_hash": LOG["transactionHash"],
        "block_number": int(LOG["blockNumber"], 16),
        "log_index": int(LOG["logIndex"], 16),
    }
    f = decode_liquidation(row, protocols[1])
    assert f is not None
    assert f.kind == "liquidation"
    assert f.confidence.level == "high"
    e = f.evidence[0]
    assert e["tx_hash"] == LOG["transactionHash"]
    assert e["collateral"] == "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2"
    assert e["debt"] == "0x6b175474e89094c44da98b954eedeac495271d0f"
    assert f.victim == "0x48df18e8dd5a0f5d3792b7c98aaa1beab93e1305"
    assert f.estimated_impact["debt_to_cover"] is not None


def test_unconfigured_contract_ignored():
    row = dict(LOG)
    row["contract"] = "0x" + "0" * 40
    row = {"contract": "0x" + "0" * 40, "topics": LOG["topics"], "data": LOG["data"],
           "transaction_hash": "0x1", "block_number": 1, "chain_id": 1}
    assert decode_liquidation(row, load_protocols()[1]) is None
