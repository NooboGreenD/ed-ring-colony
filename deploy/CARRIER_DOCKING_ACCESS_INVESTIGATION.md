# Squadron carriers: two independent stock tasks

## Scope/status

This branch treats these as **separate** tasks:

1. Changing game docking access correlates with loading-pattern `?` values. The player says the affected carrier is a squadron carrier; display recovered after the managing pilot docked and sold goods.
2. A delivery by a pilot without Helper is not discovered when another pilot with Helper visits/trades. The visitor's own transactions are counted, but they do not reconstruct earlier unreported deliveries.

Implemented a reproduced destructive-path fix for (1) and an optional, server-fetched CAPI bank reconciliation path for (2). No deployment, production SQL execution, commit, push or Helper release performed. Exact reproduction of the player's `?` display still requires in-game validation; do not claim that the symptom's only cause is established.

## 1. Management/statistics must not erase squadron bank stock

`CarrierDockingPermission` alone only changes docking metadata. It does not revoke website squadron membership or pattern-sharing consent. Real ledger/projection tests cover multiple access transitions for personal/squadron carriers, unchanged consistent full stats, explicit zero/unknown commodities and public-cargo privacy.

The independently reproduced destructive path is **accompanying `CarrierStats` with `SpaceUsage.Cargo = 0`**. Previously:

- Normalization created a complete empty cargo baseline for both personal and squadron carriers. That baseline could wipe the unified bank ledger and delete covered event history.
- A sparse old client could omit `CarrierType` even when the persisted carrier was known to be squadron.
- Helper could clear/scale bank goods using a general Cargo aggregate, classify a known squadron carrier as personal on sparse stats, and send a false empty correction to optional Raven.

Changes:

- Only personal stats can create the empty-hold baseline. The store resolves persisted type and suppresses such baselines for squadron carriers even from sparse/older clients.
- Helper retains known squadron identity, never scales/clears its bank goods from the aggregate, and does not publish an empty Raven correction for squadron stats.
- No docking-access authorization rules were weakened. Personal empty-hold accounting remains in place. Explicit complete bank reconciliation still supports a genuinely empty bank.

Before-fix check using the new regressions with HEAD versions restored temporarily: the real DB path erased 400 steel to an empty inventory, and the Helper regression failed. Current regressions pass. These prove code defects, **not** the exact private journal sequence causing the reported `?` symptom. Historical lost stock is not guessed or replayed from delivery totals.

## 2. Discover deliveries by pilots without Helper

### Source

Frontier's `/squadron` response includes the shared commodity bank, distinct from commodity-market buy orders and the visiting ship's Cargo.json. Specification used:

https://github.com/EDCD/FDevIDs/blob/c7c29f7a13df543d4bc8b947eab29f88e06100fa/Frontier%20API/FrontierDevelopments-CAPI-endpoints.md#squadron

This replaces the earlier investigation conclusion that no complete-bank acquisition path was available. The path was absent **in this project's Helper**, not absent from Frontier's documented API.

### Implementation

- `POST /api/carriers/[id]/bank/refresh` authenticates a site session or project API token, checks current website squadron membership, and uses that user's existing website-owned Frontier OAuth binding. It accepts **no client inventory** and returns no Frontier credentials, member roster or finance payload.
- `CapiClient.getSquadron()` calls Live `/squadron`, no-store, with a bounded timeout. Partial HTTP 206, empty and malformed replies are rejected. No Legacy/profile fallback is used by this path; console/Legacy bindings are refused.
- The parser requires matching squadron/carrier tags, checks market ID when supplied, and accepts only an explicit `bank.commodities.All` array. Missing/private/unknown formats do **not** mean empty. Unknown commodities, duplicate canonical keys, malformed/fractional/negative quantities and totals above 60,000 are refused rather than partially imported.
- Only the shared bank account is used. Personal allocations, credit accounts, market demand and visiting ship cargo are not added or double-counted. Bank/hold remain one ledger, not parallel inventories.
- `sync_squadron_bank_from_capi` is service-only. Under the same carrier lock as journal ingestion, it rechecks membership/binding and invokes existing audited `reconcile_squadron_bank`. It preserves event hashes, records the actor, rejects stale baselines and known transactions racing retrieval. No personal delivery/contribution events are fabricated.
- Helper requests reconciliation in the existing background carrier-read worker while docked at a known squadron carrier, once its own outbox is empty. Attempts are throttled for 120 seconds (actual cadence follows the existing 90-second read worker); unsupported/unlinked access backs off for ten minutes. Server rate limits also bound attempts by user and carrier. After acknowledgement, the normal site read updates CARRIER and a signal refreshes LOADING.
- Changing account/server/dock while a request is in flight suppresses its old-account UI notification. Network/CAPI failure does not suppress the existing ledger read or erase local stock.

### Timestamp/availability limits

Prefer a valid recent provider timestamp when supplied. When Frontier supplies no timestamp, the request-start time is a **retrieval cursor**, not a claimed exact game transaction time. The SQL function rejects already-observed transactions at/after that cursor. Provider-side caching and transactions uploaded late from another pilot cannot be made transactionally atomic with the game; periodic idle refreshes converge to the provider's bank state. Do not claim instantaneous game-wide consistency.

The `All` array adapter is based on published schema and synthetic reduced fixtures, not a live response from the player's account. A redacted/changed schema fails closed with an explicit message and no write. In-game validation is still required. Do not collect or commit entire `/squadron` payloads: they can contain other members' private information.

### Requirements / rollout

1. Review and apply `20261201090000_squadron_bank_capi_snapshot.sql` through the normal migration process, after the existing bank reconciliation/officer-correction migrations. The new migration creates only a service function/grants and changes no current stock by itself. Normal deployment backup/pending-migration review still applies.
2. Deploy the site and distribute the updated Helper. The server-side management-stat guard also protects older Helper uploads once the site is deployed; local HUD/Raven protection and automatic CAPI requests need the updated Helper.
3. The visiting pilot must belong to the carrier's squadron on the website and have an active **Live Frontier binding on the website**, plus CAPI permission to see the shared bank. A Helper project token alone is not a Frontier login. No Frontier tokens need to be copied into Helper/chat.
4. Verify in game: known initial bank -> pilot without Helper deposits -> linked ordinary member visits with updated Helper and waits for the successful Frontier-bank log -> website/LOADING reflect the actual common-bank goods, without changing personal delivery credit. Recheck after a known member sale and an idle refresh.
5. Separately change docking access/open management; confirm bank quantities/progress remain stable. Check a personal carrier's genuine empty hold and public/private views as regressions. If the exact `?` symptom persists, inspect a reduced journal/API sequence without credentials; do not conflate it with missing-delivery reconciliation.

## Validation

- Targeted JS/SQL suite (`squadron-bank-refresh fleet-carriers loading-pattern personal-carrier-stock carrier-bank bank-correction capi`): **249 passed**.
- Wider carrier/CAPI/station suite: **447 passed, 1 failed**. The isolated failure also reproduces when run alone: unchanged `carrier-jump-schedule.test.mjs` expects its fixed 2026-11-11 departure to still be the next future jump; it is now past, so the API correctly returns null. Schedule implementation/tests were not modified for these stock tasks.
- Qt-free Python selection: **174 run, 167 passed, 7 skipped**. The initial broader run additionally attempted 11 GUI-dependent cases and errored because PySide6 is absent; those cases are excluded from the Qt-free result, not counted as passing.
- TypeScript/Next route type generation, modified Python source compilation and `git diff --check`: passed.

Coverage includes real PGlite normalization/store/ledger/projection, CAPI parser and authenticated route, service RPC access/races/audit, and Qt-free actual Helper method harnesses. Live Frontier/Windows GUI testing and production rollout are not claimed.
