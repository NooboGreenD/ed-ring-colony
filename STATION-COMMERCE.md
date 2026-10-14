# Stations and commerce: persistent project database

## Deployment

1. Apply `supabase/migrations/20261014000000_station_commerce.sql`, then `supabase/migrations/20261014010000_station_search.sql` **before** deploying the new server/Helper. Both migrations are included in `supabase/full_schema.sql` for clean installations.
2. Deploy the server and publish an updated Colonial Helper code bundle using the project's normal signed-bundle procedure. This change does not itself publish a bundle or deploy a database.
3. For bulk station data, import a **rich Spansh galaxy dump containing stations** from a local gzip file, e.g.:
   ```sh
   node scripts/import-spansh-systems.mjs --file /path/to/galaxy.json.gz --no-points
   ```
   The in-app streaming importer also saves commerce when its records contain these fields. The brief `systems.json.gz` dump has no population, stations or inventory; importing it cannot manufacture station data. Existing unpacked map shards contain only flattened system records, so use the original rich archive to import commerce, not `--from-shards`.
4. The optional EDDN subscriber now accepts compressed commodity, outfitting and shipyard reports; configure `EDDN_INGEST_SECRET` as before. Test schemas are ignored.

Live EDSM/Spansh services and the production database could not be exercised from this sandbox. Tests use fixtures and a local embedded PostgreSQL (PGlite).

## Storage

- `commerce_systems`: normalized system name, Elite Cartesian coordinates in light-years, population when reported, station-presence evidence, observation time and source. An indexed spatial box followed by an exact sphere test finds nearby inhabited systems without scanning the galaxy catalog. The JSONB RPC result avoids PostgREST's default 1,000-row result limit; up to 5,000 nearest candidates are returned.
- `station_commerce`: station name/type, stable `MarketID` where known, current system, body, distance to arrival, surface latitude/longitude, services, and an optional explicitly reported local Cartesian position. Carrier moves update the same identity; old body metadata is cleared. Name-only reports are reconciled to a known MarketID.
- `station_inventory_snapshots`: one **complete current snapshot** per station and kind (`market`, `outfitting`, `shipyard`), including observation time, receipt time and source. Commodities retain purchase/sale prices, stock and demand. Ships/modules retain identifiers/symbols and reported prices; Spansh module class/rating/restrictions are retained.

Station orbital Cartesian coordinates are generally not provided by the journal or EDSM station endpoint. System coordinates are **not** mislabeled as station coordinates. Unknown values stay unknown; the location metadata contains only actual observations. `metadata.distance_to_arrival` is in **light-seconds**; Spansh's published full galaxy schema describes `distanceToArrival` in kilometres, so its adapter divides by 299792.458. Schema reference: https://github.com/spansh/elite_dangerous_schemas/blob/main/galaxy.schema.json.

Only the latest complete service snapshots are retained, not an unbounded history of every market tick. The existing EDDN cleanup job does not delete these durable snapshots.

## Updates and concurrency

`save_station_commerce(report)` updates metadata and service snapshots in one database transaction. Each service has its own observation timestamp. Older service reports cannot overwrite newer ones; at equal timestamps the source priority is Helper → EDDN → EDSM → Spansh. An absent service means **unknown / unchanged**, whereas an explicit `items: []` means **observed empty** and replaces that service. A failed request never clears inventory. Complete snapshots prevent removed goods/modules from surviving a per-item merge.

The API `POST /api/stations/report` authenticates an existing Helper API token or a web session. It validates the entire batch before writing, fixes the source server-side, limits uploads to 20 reports / 4 MiB and each service to 5,000 items, and returns a retryable error on persistence failure. Database writes and RPCs are service-role only; browser roles cannot write the tables directly.

### Colonial Helper

- Journal `Location`, `FSDJump`, `Docked`, `CarrierJump`, `Undocked` maintain station/system context. Historical uploads save station visits and inline inventory data too, even when there are no construction deliveries.
- While docked, the existing watcher reads `Market.json`, `Outfitting.json`, `Shipyard.json` when they change. The file's event type, system, station name and MarketID must match the current dock. Historical replay never attaches today's sidecar to an old docking event.
- **Docking alone does not populate all inventory files.** Frontier normally generates them when the player opens the respective market/outfitting/shipyard service. Helper uploads the actual complete snapshot once available; it does not pretend an unopened service is empty.
- A local `.station_commerce_outbox.json` beside the Helper configuration stores pending reports separately from journal offsets. Upload errors are retried, including after restart. Reports coalesce by station/service, up to 5,000 pending keys; batches are bounded to 20 reports and approximately 3 MiB. Extremely large/offline histories beyond that limit retain the most recently queued keys rather than growing indefinitely.

### EDSM and Spansh

Atlas persists station metadata for all returned stations, all commodities from successful market responses (not just the requested commodity), and available module/ship inventories with independent timestamps. Optional equipment requests are made after commodity requests and stay within the step deadline. Unknown EDSM inventory times are represented as an unknown/stale epoch, never promoted to fresh merely because the response was fetched now.

Both direct-Postgres and PostgREST streaming Spansh writers import rich-system population and station inventories. Population-only records become search candidates as well. Imports do not buffer the entire galaxy or overwrite a newer live snapshot with an older dump.

## Atlas search

1. Resolve the reference system locally (galaxy/Atlas/commerce coordinates) before consulting EDSM.
2. Start with indexed nearby `population > 0` or station-presence candidates; the old availability table is backfilled into this index on migration.
3. Use complete local station inventories. The freshness interval is **one hour**. Fresh complete snapshots, including empty snapshots or snapshots missing the requested commodity, do not require EDSM requests just to verify the same absence.
4. Refresh stale/missing market data from EDSM and persist successful observations. During an outage, stored results remain available with their source/time and a stale warning; they are not a promise of current stock.
5. Only if stage one cannot find the requested goods does the job append the broader nearest-system search (project catalog → Atlas cache → EDSM). Already visited systems are excluded. For a construction search the fallback looks for missing recipe commodities. New systems' coordinates are sent to the UI so fallback markers and scan beams remain correctly positioned.
6. The standalone `/atlas/market` commodity page also reads durable snapshots, with legacy per-item EDDN data only for stations not covered by complete snapshots.

The fallback inherits the existing bounded search volume/candidate limits. Neither the catalog nor external services guarantee all real stations have been observed. The separate station finder described below searches all three stored inventory kinds plus station services; it does not perform external discovery itself.

## Station finder (Tools → Station search)

`/station-search` adds four tabs in the site's existing panel/button style: commodities, modules, ships and services. The sidebar entry is translated in all seven navigation locales. The page supports a query, optional reference system/radius, minimum commodity stock, module class/rating, one-hour freshness, distance/price/update sorting and 50-result pagination. Without a reference system, stations with unknown coordinates can still appear; they cannot be opened on the map.

`GET /api/stations/search` validates filters and calls the service-role-only `search_station_catalog` RPC. Availability comes exclusively from persisted station rows and current complete inventories. Reference coordinates come from the project DB; this route never contacts EDSM or Spansh. The outfitting catalog supplies display names and symbol aliases only, **not availability**. Helper module symbols are enriched with class/rating when recognizable; the RPC also extracts those fields from standard persisted symbols. Unknown prices/timestamps remain unknown. Cards include station/system, source, observation time, stale status, stock/demand, actual prices and known arrival/body metadata.

Services normalize source aliases (technology brokers, engineers/workshops, material traders, Interstellar Factors, etc.). Named engineer references are attached only to actually observed matching station/system rows, including a migration backfill; the static engineer list does not fabricate station records. Broker subtype and a commander's unlocks/permits are not inferred. Service presence is not a guarantee of personal access.

“Показать систему в Атласе” opens a new tab and preserves the original search. It passes a validated `focus_system` and finite `x/y/z` coordinates (including zero); Atlas displays the target marker/notice and passes a mount-safe camera focus to GalaxyMap. Missing coordinates disable the map action. Changing filters or categories aborts pending requests and invalidates stale responses; tabs support arrow/Home/End navigation. Initial interactive search controls stay disabled until hydration to prevent a native form submission before the client handler is ready.

## Validation

- TypeScript: `npm run typecheck`.
- Targeted Node tests cover station upload authorization/validation, local-first and delayed-fallback search, snapshot removal, source timestamps/priorities, offline stale reports, equipment persistence, rich Spansh normalization, SQL migration parsing and schema snapshot consistency.
- `scripts/tests/station-search.test.mjs` covers query validation, catalog aliases, DB-only API filters/pagination, service aliases and finite Atlas links.
- `tests/browser/station-search.spec.ts` covers result cards and actual prices, pagination, unknown-coordinate actions, cancellation/category reset, keyboard tabs, mobile overflow and the Atlas focus notice, with fixture API responses. Run `npx playwright test tests/browser/station-search.spec.ts` against the dev server.
- `scripts/tests/station-commerce-db.test.mjs` executes both real migrations and RPCs in embedded PostgreSQL: complete/empty snapshots, stale updates, independent services, population-only candidates, carrier moves, identity reconciliation, standalone commodity search, unified four-kind search, module filters, observed-only engineer matching, radius/price/pagination and RLS.
- `uploader/tests/test_station_commerce.py` covers current-dock matching, all three service files, empty vs unknown inventories, metadata-only visits and durable retry after restart.

The full quick suite has existing unrelated ring geometry/label failures. The full Python suite additionally references absent `.github/workflows/build-*.yml` files and has a fixed-date deadline expectation now in the past; targeted commerce tests pass.
