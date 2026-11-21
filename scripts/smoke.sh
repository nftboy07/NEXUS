#!/usr/bin/env bash
# NEXUS smoke test — run once Docker is installed. Bash (Git Bash OK).
# Brings the whole stack up, verifies migrations, ingestion growth on both
# chains, restart catch-up + dedup, per-chain isolation, API + dashboard.
# Prints PASS/FAIL per check; exit non-zero on any FAIL; leaves stack up.
set -u
cd "$(dirname "$0")/.."
FAILURES=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILURES=$((FAILURES + 1)); }
info() { echo "..    $1"; }

psql_() { docker compose exec -T postgres psql -U nexus -d nexus -tAc "$1"; }

# ---------- preflight ----------
docker --version >/dev/null 2>&1 || { echo "docker not installed; aborting."; exit 2; }
docker compose version >/dev/null 2>&1 || { echo "docker compose not installed; aborting."; exit 2; }
[ -f .env ] || { echo ".env missing — cp .env.example .env first."; exit 2; }
set -a; . ./.env; set +a

if [ -z "${WSS_RPC_URL:-}" ] || [ -z "${HTTP_RPC_URL:-}" ]; then
  info "Ethereum RPC env unset; smoke run will inject free public endpoints:"
  info "  WSS_RPC_URL=wss://ethereum-rpc.publicnode.com"
  info "  HTTP_RPC_URL=https://ethereum.publicnode.com"
  info "  (override by setting them in .env before running)"
fi
if [ -z "${WSS_RPC_URL_BASE:-}" ] || [ -z "${HTTP_RPC_URL_BASE:-}" ]; then
  info "Base RPC env unset; smoke run will inject free public endpoints:"
  info "  WSS_RPC_URL_BASE=wss://base-rpc.publicnode.com"
  info "  HTTP_RPC_URL_BASE=https://base-rpc.publicnode.com"
fi
: "${WSS_RPC_URL:=wss://ethereum-rpc.publicnode.com}"
: "${HTTP_RPC_URL:=https://ethereum.publicnode.com}"
: "${WSS_RPC_URL_BASE:=wss://base-rpc.publicnode.com}"
: "${HTTP_RPC_URL_BASE:=https://base-rpc.publicnode.com}"
export WSS_RPC_URL HTTP_RPC_URL WSS_RPC_URL_BASE HTTP_RPC_URL_BASE
: "${NEXUS_API_KEY:=smoke-key}"; export NEXUS_API_KEY
: "${DASHBOARD_PROXY_TOKEN:=smoke-operator-token}"; export DASHBOARD_PROXY_TOKEN

# ---------- bring up ----------
docker compose up -d --build
info "waiting for postgres..."
for i in $(seq 1 60); do
  docker compose exec -T postgres pg_isready -U nexus -d nexus >/dev/null 2>&1 && break
  sleep 2
done
docker compose exec -T postgres pg_isready -U nexus -d nexus >/dev/null 2>&1 || { fail "postgres healthy"; exit 1; }

# ---------- migrations check (one probe per migration file) ----------
declare -A PROBES=(
  [001]="SELECT to_regclass('logs')"
  [002]="SELECT to_regclass('pending_transactions')"
  [003]="SELECT to_regclass('wallet_scores')"
  [004]="SELECT to_regclass('pool_reserves')"
  [005]="SELECT to_regclass('mev_findings')"
  [006]="SELECT attname FROM pg_attribute WHERE attrelid='investigations'::regclass AND attname='trigger_tx'"
  [007]="SELECT to_regclass('removed_blocks')"
  [008]="SELECT attname FROM pg_attribute WHERE attrelid='pools'::regclass AND attname='discovery'"
  [009]="SELECT attname FROM pg_attribute WHERE attrelid='pending_transactions'::regclass AND attname='included_block_hash'"
  [010]="SELECT to_regclass('alert_deliveries')"
  [011]="SELECT attname FROM pg_attribute WHERE attrelid='investigations'::regclass AND attname='updated_at'"
  [012]="SELECT attname FROM pg_attribute WHERE attrelid='investigations'::regclass AND attname='source_alert_id'"
)
for m in 001 002 003 004 005 006 007 008 009 010 011 012; do
  out=$(psql_ "${PROBES[$m]}")
  [ -n "$out" ] && [ "$out" != "" ] && pass "migration $m applied" || fail "migration $m applied (probe: ${PROBES[$m]})"
done

# ---------- check 1: ingestion grows on both chains ----------
info "check 1: waiting up to 5 min for block/log growth on chains 1 and 8453"
START=$(date +%s)
ok1=no
for i in $(seq 1 50); do
  b1=$(psql_ "SELECT COUNT(*) FROM blocks WHERE chain_id=1"); b8453=$(psql_ "SELECT COUNT(*) FROM blocks WHERE chain_id=8453")
  c1=$(psql_ "SELECT last_block FROM checkpoints WHERE chain_id=1"); c8453=$(psql_ "SELECT last_block FROM checkpoints WHERE chain_id=8453")
  info "  blocks: eth=$b1 base=$b8453 checkpoints: eth=${c1:-none} base=${c8453:-none}"
  [ "${b1:-0}" -gt 0 ] && [ "${b8453:-0}" -gt 0 ] && [ -n "$c1" ] && [ -n "$c8453" ] && { ok1=yes; break; }
  sleep 6
done
[ "$ok1" = yes ] && pass "ingestion advancing on both chains" || fail "ingestion advancing on both chains"

MIN_B1=$(psql_ "SELECT MIN(number) FROM blocks WHERE chain_id=1"); MIN_B8453=$(psql_ "SELECT MIN(number) FROM blocks WHERE chain_id=8453")

# ---------- check 2: restart catch-up, no duplicates, no gaps ----------
info "check 2: stopping evm_listener 60s, restarting, verifying catch-up + dedup"
docker compose stop evm_listener
sleep 60
docker compose start evm_listener
PRE_HEAD=$(psql_ "SELECT MAX(number) FROM blocks WHERE chain_id=1")
ok2=no
for i in $(seq 1 30); do
  cp_now=$(psql_ "SELECT last_block FROM checkpoints WHERE chain_id=1")
  [ -n "$cp_now" ] && [ -n "$PRE_HEAD" ] && [ "$cp_now" -ge "$PRE_HEAD" ] && { ok2=yes; break; }
  sleep 6
done
[ "$ok2" = yes ] && pass "checkpoint caught up past pre-stop head" || fail "checkpoint caught up past pre-stop head"
DUPQ="SELECT chain_id, block_hash, transaction_hash, log_index, COUNT(*) FROM logs GROUP BY 1,2,3,4 HAVING COUNT(*) > 1"
echo "duplicate check: $DUPQ"
DUPS=$(psql_ "$DUPQ")
[ -z "$DUPS" ] && pass "no duplicate logs" || { fail "no duplicate logs"; echo "$DUPS"; }
for cid in 1 8453; do
  MINB=$([ "$cid" = "1" ] && echo "$MIN_B1" || echo "$MIN_B8453")
  GAPS=$(psql_ "SELECT COUNT(*) FROM (SELECT number, LEAD(number) OVER (ORDER BY number) nxt FROM blocks WHERE chain_id=$cid AND number >= $MINB) t WHERE nxt IS NOT NULL AND nxt <> number + 1")
  [ "${GAPS:-1}" = "0" ] && pass "no block gaps on chain $cid" || fail "no block gaps on chain $cid"
done

# ---------- check 3: per-chain isolation ----------
info "check 3: Base pointed at dead RPC; chain 1 must keep advancing"
docker compose stop evm_listener
docker compose run -d --no-deps \
  -e WSS_RPC_URL_BASE=wss://dead.invalid -e HTTP_RPC_URL_BASE=http://dead.invalid:1 \
  --name evm_listener_broken evm_listener >/dev/null 2>&1 || true
sleep 20
CP_A=$(psql_ "SELECT last_block FROM checkpoints WHERE chain_id=1")
sleep 25
CP_B=$(psql_ "SELECT last_block FROM checkpoints WHERE chain_id=1")
ERR=$(docker logs evm_listener_broken 2>&1 | grep -ci "error\|fail" || true)
if [ -n "$CP_A" ] && [ -n "$CP_B" ] && [ "$CP_B" -gt "$CP_A" ]; then
  pass "chain 1 advanced with Base dead"
else
  fail "chain 1 advanced with Base dead"
fi
[ "${ERR:-0}" -gt 0 ] && pass "Base error logged" || fail "Base error logged"
docker rm -f evm_listener_broken >/dev/null 2>&1 || true
docker compose up -d evm_listener

# ---------- check 5: Engine 3 scores + relations computed live ----------
info "check 5: waiting up to 3 min for wallet_scores on chains 1 and 8453"
ok5=no
for i in $(seq 1 36); do
  s1=$(psql_ "SELECT COUNT(*) FROM wallet_scores WHERE chain_id=1"); s8453=$(psql_ "SELECT COUNT(*) FROM wallet_scores WHERE chain_id=8453")
  [ "${s1:-0}" -gt 0 ] && [ "${s8453:-0}" -gt 0 ] && { ok5=yes; break; }
  sleep 5
done
info "  wallet_transfers: $(psql_ "SELECT string_agg(chain_id||'='||n, ' ') FROM (SELECT chain_id, COUNT(*) n FROM wallet_transfers GROUP BY 1 ORDER BY 1) t")"
info "  wallet_scores:    $(psql_ "SELECT string_agg(chain_id||'='||n, ' ') FROM (SELECT chain_id, COUNT(*) n FROM wallet_scores GROUP BY 1 ORDER BY 1) t")"
info "  wallet_relations: $(psql_ "SELECT COALESCE(string_agg(chain_id||'='||n, ' '), 'none yet (data-dependent)') FROM (SELECT chain_id, COUNT(*) n FROM wallet_relations GROUP BY 1 ORDER BY 1) t")"
[ "$ok5" = yes ] && pass "wallet_scores computed live on both chains" || fail "wallet_scores computed live on both chains"

# ---------- check 4: API + dashboard ----------
CODE=000
for i in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health || echo 000)
  [ "$CODE" = "200" ] && break
  sleep 3
done
[ "$CODE" = "200" ] && pass "api /health 200" || fail "api /health 200 ($CODE)"
# the dashboard renders with the server API key, so it must refuse anonymous
# callers (redirect to /login) and serve pages only with an operator session
DANON=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ || echo 000)
[ "$DANON" = "307" ] || [ "$DANON" = "302" ] && pass "dashboard rejects anonymous ($DANON -> /login)" || fail "dashboard rejects anonymous (got $DANON, want 302/307)"
DPROXY_ANON=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/nexus/alerts || echo 000)
[ "$DPROXY_ANON" = "401" ] && pass "dashboard proxy 401 without session" || fail "dashboard proxy 401 without session ($DPROXY_ANON)"
COOKIES=$(mktemp)
SCODE=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIES" -X POST http://localhost:3000/api/session \
  -H 'content-type: application/json' -d "{\"token\":\"$DASHBOARD_PROXY_TOKEN\"}" || echo 000)
[ "$SCODE" = "200" ] && pass "dashboard /api/session issues operator session" || fail "dashboard /api/session issues operator session ($SCODE)"
DCODE=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIES" http://localhost:3000/ || echo 000)
[ "$DCODE" = "200" ] && pass "dashboard 200 with session" || fail "dashboard 200 with session ($DCODE)"
DPROXY=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIES" http://localhost:3000/api/nexus/system/health || echo 000)
[ "$DPROXY" = "200" ] && pass "dashboard proxy 200 with session" || fail "dashboard proxy 200 with session ($DPROXY)"
rm -f "$COOKIES"

# ---------- check 6: Engine 6 auto-investigations from alerts ----------
NALERTS=$(psql_ "SELECT COUNT(*) FROM alerts WHERE record->'facts'->>'tx_hash' IS NOT NULL OR record->'facts'->'evidence'->0->>'tx_hash' IS NOT NULL")
if [ "${NALERTS:-0}" -gt 0 ]; then
  NINV=0
  for i in $(seq 1 20); do
    NINV=$(psql_ "SELECT COUNT(*) FROM investigations WHERE source_alert_id IS NOT NULL AND evidence IS NOT NULL")
    [ "${NINV:-0}" -gt 0 ] && break
    sleep 3
  done
  info "  tx-bearing alerts=$NALERTS auto investigations with evidence=$NINV"
  psql_ "SELECT id, status, trigger_tx, citations_valid FROM investigations WHERE source_alert_id IS NOT NULL ORDER BY id LIMIT 5"
  [ "${NINV:-0}" -gt 0 ] && pass "engine 6 investigations created from alerts" || fail "engine 6 investigations created from alerts"
else
  info "check 5 skipped: no tx-bearing alerts yet (no whale/liquidity/MEV alert fired)"
fi

# ---------- check 7: Engine 5 cursor follows ingestion ----------
ok5=no
for i in $(seq 1 20); do
  m1=$(psql_ "SELECT last_block FROM mev_analyzer_cursor WHERE chain_id=1"); m8453=$(psql_ "SELECT last_block FROM mev_analyzer_cursor WHERE chain_id=8453")
  [ -n "$m1" ] && [ -n "$m8453" ] && { ok5=yes; break; }
  sleep 6
done
[ "$ok5" = yes ] && pass "mev_analyzer cursor set on both chains (eth=$m1 base=$m8453)" || fail "mev_analyzer cursor set on both chains"
MERR=$(docker compose logs --no-log-prefix mev_analyzer 2>&1 | grep -c '"level": "error"' || true)
[ "${MERR:-0}" = "0" ] && pass "mev_analyzer passes without errors" || fail "mev_analyzer passes without errors ($MERR error lines)"
info "mev_findings: $(psql_ "SELECT COALESCE(string_agg(kind || '@' || chain_id || '=' || n, ' '), 'none') FROM (SELECT kind, chain_id, COUNT(*) n FROM mev_findings GROUP BY 1,2) t")"

echo "----------------------------------------"
echo "smoke duration: $(( $(date +%s) - START ))s, failures: $FAILURES"
info "stack left running (docker compose down to stop)"
[ "$FAILURES" -eq 0 ]
