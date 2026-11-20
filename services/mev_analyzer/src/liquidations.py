"""Liquidation findings from Engine 1's logs table: Aave V2/V3
LiquidationCall and Compound LiquidateBorrow, only from configured
protocol contracts in src/protocols.json (unverified addresses are left
out rather than guessed)."""
from __future__ import annotations

import json
from pathlib import Path

from models import Confidence, Finding

# keccak256 event selectors (computed via viem toEventSelector)
AAVE_V2_LIQ = "0x62c17e2a17a00d43cfce82c97a035e2fad4eabdb8d38fdd8ca59ee150ecbebb6"  # LiquidationCall(...,address)
AAVE_V3_LIQ = "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"  # LiquidationCall(...,address,bool)
COMPOUND_LIQ = "0x298637f684da70674f26509b10f07ec2fbc77a335ab1e7d6215a4b2484d8bb52"   # LiquidateBorrow


def load_protocols(path: Path | None = None) -> dict[int, dict[str, str]]:
    p = path or Path(__file__).with_name("protocols.json")
    data = json.loads(p.read_text())
    out: dict[int, dict[str, str]] = {}
    for cid, protos in data["chains"].items():
        out[int(cid)] = {name: meta["address"].lower() for name, meta in protos.items()}
    return out


def _topic_addr(t: str) -> str:
    return "0x" + t[-40:].lower()


def _words(data: str) -> list[int]:
    d = data[2:] if data.startswith("0x") else data
    return [int(d[i:i + 64], 16) for i in range(0, len(d) - 63, 64)]


def decode_liquidation(log_row: dict, protocol_addrs: dict[str, str]) -> Finding | None:
    """log_row: {contract, topics, data, transaction_hash, block_number,
    chain_id, log_index}. Aave LiquidationCall(collateral, debt, user,
    debtToCover, liquidatedCollateral, liquidator[, receiveAToken]) —
    collateral/debt/user are indexed topics, the rest in data."""
    contract = (log_row["contract"] or "").lower()
    name = next((n for n, a in protocol_addrs.items() if a == contract), None)
    topics = [str(t).lower() for t in (log_row["topics"] or [])]
    if name is None or len(topics) < 4 or topics[0] not in (AAVE_V2_LIQ, AAVE_V3_LIQ):
        return None
    collateral = _topic_addr(topics[1])
    debt = _topic_addr(topics[2])
    user = _topic_addr(topics[3])
    words = _words(log_row["data"] or "0x")
    debt_to_cover = words[0] if len(words) > 0 else None
    liquidated = words[1] if len(words) > 1 else None
    liquidator = "0x" + format(words[2], "040x")[-40:] if len(words) > 2 else None
    return Finding(
        kind="liquidation",
        chain_id=int(log_row.get("chain_id") or 0),
        block_number=int(log_row["block_number"]),
        initiator=liquidator,
        victim=user,
        pool_id=contract,
        evidence=[{
            "tx_hash": log_row["transaction_hash"],
            "block_number": log_row["block_number"],
            "log_index": log_row.get("log_index"),
            "protocol": name,
            "collateral": collateral,
            "debt": debt,
        }],
        estimated_impact={
            "debt_to_cover": str(debt_to_cover) if debt_to_cover is not None else None,
            "liquidated_collateral": str(liquidated) if liquidated is not None else None,
        },
        confidence=Confidence(
            level="high",
            rationale=f"LiquidationCall emitted by configured {name} contract — observed event, not inference",
        ),
    )
