# Squadron bank investigation

## Scope and reproduced defect

New deliveries must change inventory, independently of market updates. Raven
Colonial is optional and is not the site's source of truth.

A regression using the actual carrier SQL ledger reproduces a destructive path:
MarketSell +1320 steel -> later inactive Market row (Stock=0, Producer=false,
Consumer=false) -> stock becomes zero. Another sale can be erased by the next
market refresh. An inactive commodity order does not establish an empty
squadron bank. The previous sales-only replay missed this interleaving.

The fix excludes inactive rows from squadron market baselines and local HUD
merges. The server also checks persisted carrier type for older station reports
that omit squadron services. Explicit Producer observations, positive stock,
consumer-demand exclusion, observation timestamps, delivery accounting and
personal carrier semantics are retained. SQL and Helper regressions check the
inactive snapshot between two sales. No Raven import or rights escalation.

This establishes a code defect, not proof of the exact production sequence:
the user's matching Market.json, private DB observations and runtime logs were
not supplied. Already overwritten quantities are not automatically reconstructed;
replaying identical sales cannot safely restore a newer false baseline.

## Access and display

Tests replay four anonymised actual MarketSell events (4 x 1320 steel) with an
ordinary squadron member token; both member and officer read the same cargo.
The public carrier card continues to omit cargo and finances. Its page now
sends authentication, then separately loads the private carrier endpoint for
squadron members. That endpoint rechecks access. A bank table explicitly says
these are tracked goods, not a complete bank snapshot or market demand.

## Remaining operational validation

Compare new sale quantities before and after the following market refresh in
the current Helper and deployed site. If quantities still freeze, inspect the
carrier-sync response and private carrier observations, without sharing tokens.
Opening inventory completeness remains separate from ongoing delivery tracking.
Full personal journals and credentials must not be committed.

## Actual Market.json supplied afterwards

Snapshot 2026-11-24T16:46:41Z, MarketID 3713477376, contains 25 rows:
19 Consumer buy orders and six inactive rows, no Producer rows. Steel is a
Consumer row with Stock=0 and Demand=7003. This is NOT an inventory measurement.
The inactive-zero defect therefore does not explain a steel reset from this
particular snapshot. Its six inactive goods are terrain enrichment systems,
surface stabilisers, building fabricators, evacuation shelter, survival
equipment and Thargoid Titan drive component.

A reduced fixture preserving the market fields (not the whole personal journal)
is exercised through the report normalizer, applyCarrierOps and real SQL. Steel
is excluded even before the fix; after the fix the inactive rows are excluded
using persisted squadron identity too, and tracked cargo is unchanged. This
narrows the diagnosis, but does not establish why live steel deliveries freeze.
Do not describe the reproduced inactive-zero bug as a confirmed explanation of
that symptom. Next useful evidence is the Helper carrier-sync result/log and
private carrier quantities/observations bracketing one new sale, not Raven data.

## Supplied operational logs and diagnostics gap

The supplied crash log records 2.30.9 during the four historical sales, and a
later 2.30.12 startup. It contains lifecycle/crash records, not carrier-sync
outcomes. The supplied in-app log shows successful delivery upload of 1320 t
at 19:46:49, but no carrier ledger acknowledgement. The Raven startup inventory
and the earlier site refresh do not establish the outcome of that sale.

Previously a successful carrier-sync response removed the batch without a
visible summary, and the collector discarded `ignored`/`skipped` counters.
Absence of warnings therefore cannot prove cargo was applied. Added summaries
retain server counters (operations, not tonnes) and carrier IDs, plus live
MarketSell/MarketBuy local before/after tracked quantities. They do not log
credentials or complete requests, do not poll separately, and do not change
acknowledgement/retry semantics. These diagnostics narrow the next observation;
they are not an asserted fix for the unresolved live steel symptom.

Diagnostics-focused and related non-Qt Python suite: 87 tests passed. The broader
`test_carrier` GUI-backed tests could not run in this environment because
PySide6 is unavailable; that run failed at GUI setup, not a passing validation.

## Follow-up: accepted operation, no visible inventory change

A later user log reports 1320 t delivery and one carrier operation applied,
with zero duplicates/ignored/skipped for 3713477376. This rules out a rejected
batch, but does not prove that quantity changed. Two ledger cases can produce
that response: an older event covered by a newer genuine baseline (correct),
and a hidden negative balance from withdrawals of unobserved opening inventory
(incorrect for the tracked-stock estimate).

The second case is reproduced in real SQL: -10000 steel from unknown stock,
then +1320, returns applied=1 but remains at zero. Helper already floors its
estimate after each event; the old SQL only floored the final sum. The new
`20261124100000_squadron_cargo_no_negative_debt.sql` migration aligns squadron
inventory with the chronological per-event floor. Its trigger covers existing
batch RPC writes without changing RPC authentication, parent-carrier locking or
personal-carrier semantics. The prefix-minimum calculation is equivalent to
`quantity = max(0, quantity + delta)` at each event. All events/hashes remain so
late older uploads and newer baselines can still be correctly recomputed.

The migration repairs existing squadron rows from available events, preserving
baseline and observation times. **It must be applied to the site database**;
a Helper-only update cannot fix this SQL calculation. It does not reconstruct
history previously deleted by a full baseline or recover unobserved stock.

Separately, the local HUD update ran after unrelated session/ship/UI handlers;
a swallowed downstream exception could acknowledge the journal offset after
queuing the server event but before updating local cargo. It now runs adjacent
to the carrier collector. A test injects a session UI failure and verifies that
the inventory update has already happened exactly once.

Production negative debt or a future/incorrect baseline has NOT been observed
directly. Before attributing the live symptom to this defect, run the read-only
`scripts/diagnose-squadron-cargo.sql` in the project's SQL editor. It returns
stored quantity, old/new calculations, negative-prefix deficit, baseline time
and latest event/upload times, plus recent non-personal event fields. It works
before the new migration and does not change records or require sharing secrets.
The carrier/good defaults are 3713477376/steel; comparisons are to event time,
not the helper log's local wall clock.

Validation: new underflow regression failed before the fix (expected 1320,
actual zero). Real-SQL regressions cover late uploads, idempotency, partial/full
baselines, preservation of genuinely covered deliveries, migration repair,
repeatability, private function grants and unchanged personal semantics. Local
Helper tests execute actual methods without Qt. The broader GUI run is blocked
by missing libGL.so.1 even after installing PySide6 in the disposable venv;
it is not counted as passing.
