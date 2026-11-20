# Execution Safeguards — NOT IMPLEMENTED in the MVP

This document describes the required design for any future execution
capability in NEXUS (Crypto Relic). No execution code exists today:
there is no signing, no private-key handling, and no transaction
submission anywhere in this repository.

## Required safeguards before any execution ships

- **Simulation first**: every candidate transaction must be simulated
  (e.g. `eth_call` / dry-run) and the result stored before submission is
  even considered.
- **Allowlists**: only pre-registered pools, routers, and tokens may be
  interacted with; the allowlist is static config, reviewed per deploy.
- **Bounded risk**: max value per transaction, max daily notional, and
  max slippage parameters are enforced in code; exceeding any bound
  rejects the transaction deterministically.
- **Manual approval**: a human approval step (signed approval record
  with audit trail) gates every transaction in v1 of any execution.
- **Kill switch**: `EXECUTION_ENABLED=false` (default in `.env.example`)
  must hard-disable all execution paths; toggling requires redeploy, not
  a runtime flag a prompt can flip.
- **Separate execution wallet**: a dedicated low-balance wallet, never
  the treasury; key material lives only in a secrets manager.
- **Full audit logs**: every decision input, simulation result, approval
  record, and submission outcome is persisted immutably.

## Secrets

Private keys must never appear in code, logs, prompts, AI context,
fixtures, or commits. The AI investigator (Engine 6) receives evidence
packages only and has no path to credentials.
