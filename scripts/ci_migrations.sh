#!/usr/bin/env bash
# Apply migrations/*.sql in numeric order to a fresh Postgres, then apply them
# all a second time to prove idempotency. Uses PG* env vars (PGHOST, PGPORT,
# PGUSER, PGPASSWORD, PGDATABASE). Exits non-zero on the first SQL error.
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"
cd "$(dirname "$0")/.."

shopt -s nullglob
files=(migrations/[0-9][0-9][0-9]_*.sql)
[ ${#files[@]} -gt 0 ] || { echo "no migrations found"; exit 1; }

# Numbers must be unique and contiguous from 001.
expected=1
for f in "${files[@]}"; do
  n=$((10#$(basename "$f" | cut -c1-3)))
  if [ "$n" -ne "$expected" ]; then
    echo "FAIL  migration numbering: expected $(printf '%03d' "$expected"), got $(basename "$f")"
    exit 1
  fi
  expected=$((expected + 1))
done

for pass in 1 2; do
  for f in "${files[@]}"; do
    echo "pass $pass: applying $f"
    psql -X -q -v ON_ERROR_STOP=1 -f "$f"
  done
done

tables=$(psql -X -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'")
echo "PASS  ${#files[@]} migrations applied twice; public tables: $tables"
