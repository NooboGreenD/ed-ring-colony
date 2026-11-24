# Squadron carrier cargo: bank, market and HUD

## What changed

- A live synthetic `SquadronBankTransfer` now drives both the durable server
  outbox and the local carrier tracker. Deposits/withdrawals update stock and
  the commander's existing delivered counter without waiting for the network.
  Loading history or restoring the outbox does not replay this callback.
- Live market stock can update the currently docked squadron carrier directly.
  It is a **partial** snapshot: absent goods and Consumer/buy orders do not
  erase cargo; an explicit depleted sale row is zero. Snapshots never imply
  personal deliveries. Market/system/station/dock time must match.
- Per-commodity observation times protect bank/market changes (including
  depletion) from stale site replies, older aggregate CarrierStats and
  unversioned Raven replies. After the server acknowledges the observation,
  the pending local protection is released. A late bank event already covered
  by a newer snapshot updates deliveries, not stock a second time.
- Historical station inventories still enter the station upload outbox but
  cannot run live HUD/Raven inventory callbacks.
- The station-report endpoint returns retriable HTTP 503 when the market was
  saved but carrier accounting failed. Helper keeps the report queued; retries
  are idempotent instead of silently leaving the two stores out of sync.
- Personal carrier bank/market stock accounting keeps its existing path.

## Rollout

1. Apply `supabase/migrations/20261123120000_carrier_cargo_observation_time.sql`
   **before deploying the updated site**. It adds/backfills `observed_at` from
   the ledger/baseline, with a trigger maintaining it on cargo recomputation.
   It does not change quantities, batch RPC rules or public access.
2. Deploy the site and publish the updated Helper using the normal release
   process. Existing cargo `items` remain positive-only; the private API adds
   an optional `cargo.observations` map including depleted rows. Public views
   still receive no cargo information.
3. With the new Helper, dock and open the squadron carrier market/bank to get
   a current observation. Market data alone cannot reveal goods not listed for
   sale; those still require the ledger/bank events or another trusted source.

Older site responses without observation metadata cannot acknowledge newer
local squadron cargo. Local data remains protected until a timestamped server
observation/full baseline arrives; Raven cannot override pending local changes.

No production migration, deployment or release was performed while implementing
this change.

## Validation (sandbox)

- Python targeted regression run: **230 tests, 215 passed, 15 skipped**.
  Includes pure carrier/accounting/reconciliation tests, carrier sync, 23 new
  squadron cargo wiring/freshness tests, station commerce/market, PowerPlay
  data/live/sync and bundle tests. Tests needing the full Qt GUI were excluded
  from this targeted run because PySide6/native GUI support is unavailable;
  the initial broader carrier run hit 56 GUI dependency errors, not assertions.
- `node scripts/run-tests.mjs fleet-carriers station-commerce`: **80 passed**,
  including PGlite ledger/migration/backfill/retry and endpoint regressions.
- `npm run typecheck`: passed.
- Modified Python sources compile; all six non-Russian translations of the
  partial-market source label are present; `git diff --check` passed.

Still required on a real game client: load/unload at a squadron bank, check
stock and delivered in HUD/site after refresh, then switch to a personal carrier
and confirm its independent totals. This is not a claim of a Windows/in-game
GUI test.

## Follow-up: starting Helper already docked / delayed Cargo.json

The first fix covered an idealised live `Docked` → `Cargo` sequence, but missed
watcher startup with saved journal offsets:

- `_restore_station_state_from_journal` restored HUD and station-commerce state,
  not the bank collector's dock. No subsequent `Docked` meant no bank diffs.
- A historical Docked replay reset the expected ship inventory to `None`. The
  first live Cargo then became a baseline rather than a deposit/withdrawal.
- Reading Cargo.json only when its journal marker arrived lost delayed writes;
  discarding its timestamp also let an earlier marker borrow a later snapshot.

The follow-up restores the collector's dock without queuing historical events,
primes its inventory **after** startup reconciliation, and retries Cargo.json
within the existing five-second watcher loop. Snapshots retain timestamps,
counts and inventory; malformed, stale, SRV or incomplete snapshots are ignored.
A sidecar ahead of the journal waits for its Cargo marker (and matching count),
so unread market transactions cannot become invented bank movements. Duplicate
polls/markers do not reapply a delta. Personal carriers do not use this poll.
Recognised bank movements now log local totals and explicitly say that upload
is queued, not that the server has already acknowledged it.

`test_squadron_bank_watcher.py` adds 15 Qt-free regressions, including actual
Helper restore-method wiring with a real temporary journal/Cargo.json. Existing
HUD wiring tests now also use timestamped Cargo snapshots instead of a bare map.
Both startup failures were reproduced against the pre-follow-up collector.

This follow-up changes Helper only; it needs no additional database migration.
It does not reconstruct bank operations performed while Helper was not watching,
and a sale-only market snapshot still cannot reveal an entire squadron bank.
Confirmation against the affected user's journal/Cargo.json and an in-game run
is still required; these automated tests are not that confirmation.
