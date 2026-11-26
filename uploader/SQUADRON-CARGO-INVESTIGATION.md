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

## Follow-up: bank tracking stops after sparse dock / identity events

A new report describes delivery uploads continuing while carrier inventory and
LOADING stop changing. No new production journal or carrier-sync response was
supplied, so the exact cause of that live case remains unconfirmed. Delivery
reports and `/carriers/sync` are independent pipelines: a successful delivery
upload is not a carrier-ledger acknowledgement. If the log already contains a
bank transfer and applied carrier operations, inspect the read-only ledger
query above instead of assuming the client did not generate a transfer.

Reduced collector/watcher regressions reproduce two context defects:

- `_dock` replaced the squadron flag with false whenever a later Location or
  CarrierJump omitted CarrierType/StationServices. That disabled Cargo-based
  bank inference. A same-carrier dock refresh also reread the latest Cargo.json
  as a fresh baseline, potentially swallowing a deposit whose marker had not
  yet been processed.
- `restore_context` restored the dock but not StarSystem. The direct Market
  queue added by PR351 then rejected an otherwise matching Market.json. The
  independent station-report path still existed; this is not proof that every
  snapshot was lost.

The collector now retains explicit type evidence per carrier ID, including
CarrierStats/CarrierLocation/CarrierBuy, across sparse events and undocking.
The Helper tail allowlist includes the extra identity events. Restore still
queues no historical transfers. Another carrier never inherits that identity.
Same-dock live updates preserve the existing bank baseline rather than borrowing
a future sidecar. A genuinely new dock/session establishes a new baseline.
Restore also reconstructs system/coordinate context and reflects identity
records that follow the latest Location. Untyped Market uploads omit CarrierType
rather than assert personal ownership/type from missing evidence.

Late live type discovery starts tracking from an observed baseline; it does not
backfill unknown prior deposits. A file older than a known trade is not used as
that baseline, preventing a known purchase from becoming a phantom bank
withdrawal. Existing event-time, marker matching, zero/unknown, retry and
idempotency rules remain in place. Bank and hold remain one cargo ledger.

Validation: the initial new regressions failed before the fix; a separate stale
sidecar regression also reproduced a phantom 50t withdrawal before its guard.
After the fix, selected Python suites ran 139 tests: 132 passed, 7 Qt-dependent
tests skipped. Selected JavaScript/SQL/PGlite regressions passed 109/109;
TypeScript typecheck, changed-module Python compilation and diff checks passed.
Qt was not rendered. No new SQL migration, deployment, Helper release or manual
production stock repair was performed. Missing historical bank transfers are
not reconstructed from delivery totals; fresh trustworthy observations are
needed to repair already missed stock safely.

## New operational log: sustained carrier-sync rejection

The next supplied Helper excerpt materially narrows the live diagnosis:

- Up to 23:13:19, MarketSell changes local cargo and the server reports applied
  carrier operations with no duplicates/ignored/skipped events.
- Starting at 23:14:12, carrier sync repeatedly returns `Carrier database
  unavailable; retry later`. No successful carrier acknowledgement follows in
  the supplied excerpt, through 00:08:43. Pending count grows from 1 to 12.
- Meanwhile, three further 1320t CMM Composite sales update local tracked cargo
  from 2712 to 6672 and the independent delivery-report uploads succeed. This
  does not demonstrate delivery of those events to the carrier ledger.

This is direct evidence of the carrier-sync failure path, not evidence that
bank-diff inference stopped. The transfers in question are ordinary MarketSell
journal events, which do not require synthetic SquadronBankTransfer detection.
The sparse-context fixes above remain valid separately but must not be presented
as a demonstrated resolution of these server rejections.

`POST /api/carriers/sync` catches exceptions from authentication, normalization,
market identity lookup and batch application and maps them to the same 503
message. It does NOT prove that the entire database is offline. The secondary
registry update has its own catch and does not fail the acknowledged ledger
upload. Continued map reads also do not establish carrier RPC health.

The next required evidence is the matching server-side `[carriers/sync]` error
line: it already includes the underlying exception message. A transient service
failure and a repeatably failing event/trigger/RPC are both possible; the Helper
log alone cannot distinguish them. A failed batch stays queued and is retried
as a unit, so one failing event could block later good events. Do not drop or
manually acknowledge the outbox to bypass the error, and do not recreate cargo
from the successful delivery-report counter (that risks double counting).

Preserve `.carrier_events_outbox.json` in the Helper data directory. After the
server failure is fixed, existing idempotent retries should deliver the queued
events; verify a successful carrier-sync summary, drained pending queue and a
fresh loading-pattern response rather than assuming recovery. The intermittent
Status.json parse failures recover on subsequent reads in the supplied log and
do not identify the cause of the server's sustained carrier-sync 503s.

No new production data was accessed or altered to reach this conclusion.

## Confirmed server failure: legacy notification allowlist aborts carrier writes

The subsequently supplied web-container errors identify the underlying failure:
`new row for relation "user_notifications" violates check constraint
"user_notifications_type_check"`, from both `[carriers/sync]` and station-report
carrier accounting. This supersedes the earlier uncertainty about the server
failure path (not the separate, independently tested sparse-context defects).

The repository contains the complete causal chain: the legacy support migration
`20250907_fix_support_notifications.sql` restricts notification types to eight
values, none of them `carrier_jump`. `carrier_jump_notify_watchers` inserts that
new type for a watched carrier's location-change history. The notification runs
inside the location/cargo RPC transaction: a failing notification rolls back
that batch. Its durable retry repeats the same failure and holds later events.
No Helper reinstall, bank/hold split or manual stock increment fixes this.

New migration `20261130090000_carrier_jump_notification_type.sql` widens the
existing predicate with `OR type = 'carrier_jump'`, preserving custom/previously
allowed values and rejection of other types. It is atomic, repeatable, waits
at most five seconds for a table lock, and leaves schemas with no allowlist
unchanged. It changes no cargo, baselines, events, subscriptions, notifications,
RLS or grants. If lock acquisition fails, retry during a quieter moment; the
old constraint is not left dropped after a failed DO statement.

A real-SQL regression installs the actual legacy constraint, watch/history/
notification migrations and carrier ledger RPC. Before repair, a watched jump
plus a 1320t cargo delta fails with SQLSTATE 23514 and both location and cargo
remain unchanged. After repair, replay succeeds and repeated replay leaves one
notification and 1320t, not 2640t. Old types/custom types/no-constraint schemas
are also checked. The original notification suite now installs the actual
legacy allowlist too, instead of masking this integration gap with TEXT only.
147 selected JS/SQL tests and TypeScript typecheck pass.

The production database has NOT been modified by the agent. Apply the narrow
constraint repair there, preserve the Helper outbox, and verify acknowledged
retry/drain and fresh LOADING progress. A new Helper release is not required to
unblock this particular server failure. The separate colonisation_events schema
cache error in the log is not repaired by this migration; journal reset is not
a remedy for a notification constraint failure.
