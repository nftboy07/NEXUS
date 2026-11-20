from package import build_package


def test_package_contains_only_stored_evidence(conn, package):
    assert package.transaction["hash"] == "0xtx1"
    assert package.trigger["block_number"] == 100
    assert package.block["hash"] == "0xbh"
    assert len(package.logs) == 1
    assert len(package.transfers) == 1
    assert package.wallets[0].label == "alice-lab"
    assert package.wallets[0].label_source == "manual"
    assert package.wallets[0].transfers_out == 3
    assert package.citable[0] == {"tx_hash": "0xtx1", "block_number": 100}
    assert package.missing == []


def test_missing_tx_listed_under_missing(conn):
    pkg = build_package(conn, 1, "0xnotfound")
    assert pkg.transaction is None
    assert any("0xnotfound" in m for m in pkg.missing)
    assert pkg.citable == []
