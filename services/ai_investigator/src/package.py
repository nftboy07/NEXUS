"""Build an EvidencePackage from stored rows for (chain_id, tx_hash).
Everything comes from the database; absent data lands in `missing`."""
from __future__ import annotations

import psycopg

from evidence_schema import EvidencePackage, WalletSummary


def build_package(conn: psycopg.Connection, chain_id: int, tx_hash: str) -> EvidencePackage:
    pkg = EvidencePackage(trigger={"tx_hash": tx_hash, "chain_id": chain_id, "block_number": None})

    def rows(sql, params):
        cur = conn.execute(sql, params)
        cols = [d.name for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]

    # Stage A context: alerts that selected this tx (provenance: source_engine)
    try:
        pkg.alerts = rows(
            "SELECT id, source_engine, kind, record FROM alerts WHERE chain_id=%s AND "
            "(lower(record->'facts'->>'tx_hash')=%s "
            " OR lower(record->'facts'->'evidence'->0->>'tx_hash')=%s) ORDER BY id LIMIT 20",
            (chain_id, (tx_hash or "").lower(), (tx_hash or "").lower()))
    except psycopg.Error:
        conn.rollback()

    tx = rows(
        "SELECT hash, sender, recipient, value, status, block_number, nonce "
        "FROM transactions WHERE chain_id=%s AND hash=%s",
        (chain_id, tx_hash))
    if not tx:
        pkg.missing.append(f"transaction {tx_hash} not found on chain {chain_id}")
        return pkg
    t = tx[0]
    for k in ("value", "nonce", "block_number"):
        if t.get(k) is not None:
            t[k] = str(t[k])
    pkg.transaction = t
    block_num = int(t["block_number"]) if t["block_number"] else None
    pkg.trigger["block_number"] = block_num

    blocks = rows("SELECT number, hash, parent_hash, ts FROM blocks WHERE chain_id=%s AND number=%s",
                  (chain_id, block_num)) if block_num else []
    pkg.block = ({**blocks[0], "number": str(blocks[0]["number"])} if blocks
                 else pkg.missing.append(f"block {block_num} not stored") or None)

    pkg.logs = rows(
        "SELECT contract, topics, data, log_index, removed FROM logs "
        "WHERE chain_id=%s AND transaction_hash=%s ORDER BY log_index",
        (chain_id, tx_hash))

    pkg.transfers = rows(
        "SELECT token, sender, recipient, amount, tx_hash, block_number FROM wallet_transfers "
        "WHERE chain_id=%s AND tx_hash=%s",
        (chain_id, tx_hash))

    addresses = {a for a in (t.get("sender"), t.get("recipient")) if a}
    wallets: list[WalletSummary] = []
    for addr in sorted(addresses):
        w = rows("SELECT label, label_source FROM wallets WHERE address=%s", (addr,))
        tr = rows(
            "SELECT direction, COUNT(*) c FROM ("
            " SELECT CASE WHEN sender=%s THEN 'out' ELSE 'in' END direction"
            " FROM wallet_transfers WHERE chain_id=%s AND (sender=%s OR recipient=%s)) d "
            "GROUP BY direction", (addr, chain_id, addr, addr))
        counts = {r["direction"]: r["c"] for r in tr}
        score = rows("SELECT score, coverage FROM wallet_scores WHERE address=%s AND chain_id=%s",
                     (addr, chain_id))
        wallets.append(WalletSummary(
            address=addr,
            label=w[0]["label"] if w else None,
            label_source=w[0]["label_source"] if w else None,
            transfers_in=counts.get("in", 0),
            transfers_out=counts.get("out", 0),
            score=float(score[0]["score"]) if score and score[0]["score"] is not None else None,
            score_coverage=score[0]["coverage"] if score else None,
            enrichment_source="wallet_intelligence (engine 3)" if score else None,
        ))
    pkg.wallets = wallets

    # Engine 3 relation hypotheses involving these addresses
    try:
        pkg.hypotheses = rows(
            "SELECT address_a, address_b, signals, confidence, alternatives "
            "FROM wallet_relations WHERE chain_id=%s AND (address_a = ANY(%s) OR address_b = ANY(%s))",
            (chain_id, sorted(addresses), sorted(addresses)))
    except psycopg.Error:
        conn.rollback()  # table may not exist yet — enrichment absent, not fabricated

    # Citable: every stored tx/log block reference in the package
    pairs = [(tx_hash, block_num)] + [(r["tx_hash"], r["block_number"])
                                       for r in pkg.transfers if r.get("block_number")]
    pkg.citable = [{"tx_hash": h, "block_number": b} for h, b in dict.fromkeys(pairs)]
    return pkg
