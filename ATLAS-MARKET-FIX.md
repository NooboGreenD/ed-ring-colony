# Atlas: markets and construction materials

## What changed

- EDSM calls now have bounded deadlines and one retry. Large-radius discovery
  starts at most eight cube requests at once (previously all promises started
  before the batching loop). Each job step has a 35-second external-call budget.
- A failed system/station no longer aborts the entire scan or writes a false
  “no market” record. Partial coverage is saved in the scan log and displayed.
- Per-station inventories from `market_search_cache` and EDDN `market_prices`
  can supply results when EDSM is unavailable. Symbols such as `computercomponents`
  are matched to display names such as `Computer Components`.
- Cached station names without market IDs no longer prevent inventory lookup;
  cached/live commodities are merged without dropping cached goods.
- Purchase prices use EDSM/EDDN `buyPrice`. Legacy `sell_price` values are not
  treated as a trustworthy purchase price; unknown purchase prices show no price.
- The construction selector has 55 site types and 55 distinct construction
  commodities. The chosen recipe is pinned on the job, so later UI changes do
  not alter an in-progress search. The generic option searches the union of all
  recipes rather than the old incomplete 22-commodity list.
- Site-specific material quantities are **reference baseline tonnages**, not
  the remaining cargo of a live depot. The game/depot remains authoritative.

## Deployment

Apply `supabase/migrations/20261013030000_market_construction_blueprints.sql`
when deploying to an existing database. It adds nullable `build_type` and
`buy_price` columns; existing jobs continue using the generic recipe.
`supabase/full_schema.sql` includes this migration for new installations.

The server still needs access to its database and EDSM. For self-hosted
Supabase, use `SUPABASE_INTERNAL_URL` for the internal Kong address when the
public hostname/TLS is unavailable. `EDSM_API_BASE` optionally selects a trusted
server-side EDSM proxy; it is not a browser URL. If all sources are unavailable
and there are no stored reports, search cannot manufacture market data.

## Reference data

The reduced catalog records community-observed game quantities from
https://github.com/njthomson/RavenColonialWeb/blob/main/src/assets/colonization-costs2.json
(retrieved 2026-10-13). Commodity display names were checked against
https://github.com/EDCD/FDevIDs/blob/master/commodity.csv.
Only factual site identifiers, names, tiers, locations and material quantities
are retained; no upstream implementation code is copied.

## Validation

`node scripts/run-tests.mjs atlas-market` covers transport retries, catalog-only
startup, recipe persistence, input validation, offline EDDN, merged inventory on
EDSM outage, partial-coverage warnings, purchase prices and the actual React
selector/material table/request payload.

Production EDSM/database connectivity has not been tested from this sandbox.

Latest validation: 27 targeted tests passed; TypeScript and diff checks passed.
The full quick suite reports 1,025 passes and 5 existing failures in unrelated
ring geometry/label tests. The migration snapshot consistency check now passes.
