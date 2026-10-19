# Stations and commerce: persistent project database

## Deployment

1. Apply `supabase/migrations/20261014000000_station_commerce.sql`, then `supabase/migrations/20261014010000_station_search.sql` **before** deploying the new server/Helper. Both migrations are included in `supabase/full_schema.sql` for clean installations. The station list (web 2.25.0) adds `supabase/migrations/20261022120000_station_search_by_station.sql`; until it is applied the page still works through the fallback described in «Station finder».
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

Atlas persists station metadata for all returned stations, all commodities from successful market responses (not just the requested commodity), and available module/ship inventories with independent timestamps. Optional equipment requests are made after commodity requests and stay within the step deadline. Unknown EDSM inventory times are represented as an unknown/stale epoch, never promoted to fresh merely because the response was fetched now. EDSM returns modules under `outfitting` (`{id: game symbol | null, name}`) and ships under `ships` (`{id: FDevID, name}`); `edsmInventoryItems` maps them to `{name, symbol}` and `{name, id}`. Before web 2.25.2 the step read a non-existent `modules` key, so EDSM module snapshots were never saved.

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

`/station-search` adds four tabs in the site's existing panel/button style: commodities, modules, ships and services. The sidebar entry is translated in all seven navigation locales. The page supports a query, optional reference system/radius, minimum commodity stock, module class/rating, one-hour freshness and distance/price/update sorting. Without a reference system, stations with unknown coordinates can still appear; they cannot be opened on the map.

### Results as a list (web 2.25.0)

Results are a **list of stations, one row per station** — not one card per station/item pair. A collapsed row shows the station and its type, the system, the distance from the reference system, a short summary (single match: buy price and stock; several: «N товаров · от X CR») and the observation age with a fresh/stale dot. Clicking the row (a disclosure button with `aria-expanded`) opens what this station has **from the current search**:

- commodities: buy price, sell price, stock and demand per matched commodity;
- modules: class + rating, name (Russian group name where the shipyard has one, English otherwise, with a mount for weapons) and price;
- ships: name and price;
- services: the matched services and named engineers.

The expanded row also shows the body, distance to arrival and the engineers attached to the station, the source and the exact observation time (with «отчёт старше часа» for stale snapshots), and links to the system card (`systemPageHref`) and the Atlas (new tab, unchanged focus parameters; disabled without coordinates). «Развернуть все / Свернуть все» toggles every row; a single result opens by itself. Pages are 50 **stations**; the heading shows the total («Найдено 132 станции · страница 1 из 3»).

### Quick pick («быстрый выбор»)

Every query field is a combobox (`src/components/StationSearch/StationItemPicker.tsx`, the same look and keyboard as the Atlas system field): the list is filtered while typing, ↑/↓ moves, Enter picks, Escape/Tab closes; recent picks are remembered per tab in `localStorage`. Before typing, the commodities tab lists all construction materials. Suggestions come from `GET /api/stations/search/options?kind=…` (cached for an hour) and are filtered in the browser (`src/lib/stationSearchOptions.ts`) by the Russian and English names, the Frontier symbol and common abbreviations (FSD, AFMU, SCB, DSS):

| Tab | Source | Russian names |
|---|---|---|
| Commodities | EDCD/FDevIDs `commodity.csv`, `rare_commodity.csv` (412) | construction materials (`COMMODITY_LABELS_RU`, as in «Проекты систем»); category names |
| Modules | EDCD/FDevIDs `outfitting.csv`, one entry per in-game name (125; bulkheads and removed items skipped, MercGear only with its own symbols) | the main family of a shipyard group gets the group name (`GROUP_NAMES`), variants keep the English name with the group as a hint |
| Ships | EDCD/FDevIDs `shipyard.csv` (48) + manufacturer and pad size from `outfitting.json` | — (proper names) |
| Services | `SERVICE_OPTIONS` (22) + `ENGINEERS` (38, with system and station) | yes |

No Russian name is invented: an item without one shows its English in-game name. The FDevIDs snapshot lives in `src/lib/stationSearchItems.json` (source commit recorded in the file) and is rebuilt with `node scripts/build-station-search-items.mjs` (`--from <dir>` for local CSV files).

A picked suggestion is searched **exactly**: the page sends `item=<id>` (`market:Steel`, `module:frame-shift-drive`, `ship:python_nx`, `service:techbroker`, `engineer:farseer`), and the server turns it into `exact_keys` — the English name and the Frontier symbol(s). The key (`station_item_key` in SQL, `stationItemKey` in TypeScript, the same rule as `commodityKey`) drops `$…_name;` and keeps `a-z0-9`, so `$steel_name;` (Helper), `steel` (EDDN) and `Steel` (Spansh) are one item. «Вода» therefore does not return Water Purifiers, a plain shield generator does not return prismatic or Bi-Weave shields, and Python does not return Python Mk II. Typing a full name (in Russian, English or as a symbol) and pressing «Найти станции» counts as a pick. Free text that is not a full name keeps the old substring search; Russian commodity names are translated to the English name and symbol for it. Services and engineers are always matched by their aliases.

### API and database

`GET /api/stations/search` validates filters (`item` must look like `prefix:value`; a pick from another tab is ignored) and reads only the project DB; it never contacts EDSM or Spansh. With `group=station` (the page) it calls the service-role-only RPC `search_station_catalog_stations` and answers `{kind, query, reference, page, has_more, total, stations: [{…station, items, item_count, best_price}], pick, grouping, source}`; each item carries a `display` label and an optional `hint`. Without `group` the old flat response `results: [{…station, item, item_display}]` is unchanged.

`GET /api/market/find` (the pre-Atlas market search; no UI callers) keeps its response shape — `{mode, commodity?, reference_system, radius, commodities?, stations, count, source: 'project-db'}` — but since web 2.25.2 answers from the same RPC instead of fanning out to EDSM: the reference system comes from `commerce_systems`, then the galaxy catalogue (`referenceSystem.ts`, shared with the station search); a known commodity name is an exact pick (`marketPickByName`), an unknown one a substring search; `mode=build` takes the 50 nearest stations with any construction commodity and ranks them by commodities found. Each offer carries `buy_price` (what the player pays) and `sell_price` (what the station pays); `landing_pad` is set only where the station type defines it.

Migration `20261022120000_station_search_by_station.sql` moves the matching into one function, `station_catalog_matches`, used by both the old `search_station_catalog` (same signature and response — an overload would break PostgREST) and the new `search_station_catalog_stations`. The new RPC groups matches by station, orders items (modules from the highest class and best rating, goods and ships by price), caps them at `item_limit` (100) while reporting `item_count`, counts stations for `total`, and pages by station with one extra row as the «has more» lookahead; sorting by distance, best price or observation time.

Without the migration the route falls back to the old RPC: it groups one page of 100 station/item rows on the server, trims exact picks there, answers `grouping: 'page'` with `total: null` (the page says so), remembers the missing function for five minutes and logs one warning naming the migration.

Availability comes exclusively from persisted station rows and current complete inventories. The catalogs supply names, symbols and aliases only, **not availability**. Module symbols from every source (Helper, EDDN, EDSM) are graded in `canonicalReport`: class and rating come from the FDevIDs catalogue (`outfitting/moduleGrades.ts`, the same snapshot as the quick-pick lists), then from symbol parsing; a rating the source reports itself (Spansh) is kept. Weapon symbols carry no rating (`Hpt_PulseLaser_Gimbal_Small` is 1G), and before web 2.25.2 they were stored with a placeholder E, so the rating filter missed them; such snapshots are corrected as fresh data arrives. The RPC also extracts class/rating from standard persisted symbols. Unknown prices/timestamps remain unknown.

Services normalize source aliases (technology brokers, engineers/workshops, material traders, Interstellar Factors, search and rescue, crew lounge, Pioneer Supplies, Frontline Solutions, Apex, bartender, carrier administration, redemption office, etc.). Named engineer references are attached only to actually observed matching station/system rows, including a migration backfill; the static engineer list does not fabricate station records. Broker subtype and a commander's unlocks/permits are not inferred. Service presence is not a guarantee of personal access.

“Показать систему в Атласе” opens a new tab and preserves the original search. It passes a validated `focus_system` and finite `x/y/z` coordinates (including zero); Atlas displays the target marker/notice and passes a mount-safe camera focus to GalaxyMap. Missing coordinates disable the map action. Changing filters or categories aborts pending requests and invalidates stale responses; tabs support arrow/Home/End navigation. Initial interactive search controls stay disabled until hydration to prevent a native form submission before the client handler is ready. Deep links accept `?reference=&kind=&q=` and, new, `&item=<id>` for an exact pick. Radius and minimum stock have one-click presets.

## Validation

- TypeScript: `npm run typecheck`.
- Targeted Node tests cover station upload authorization/validation, local-first and delayed-fallback search, snapshot removal, source timestamps/priorities, offline stale reports, equipment persistence, rich Spansh normalization, SQL migration parsing and schema snapshot consistency.
- `scripts/tests/station-search.test.mjs` covers query validation, catalog aliases, DB-only API filters/pagination, service aliases and finite Atlas links; the quick-pick lists (sources, Russian names, no bulkheads), ranking and exact-name detection, item keys, the station list call (`exact_keys`, paging, labels), picks from another tab, the flat contract and the fallback without the migration.
- `scripts/tests/station-search-ui.test.mjs` renders the page in jsdom with the real suggestion lists: typing and keyboard picks, recent picks, exact search, the list with collapsed rows, expanded prices/stock/links, «Развернуть все», pagination, services with engineers and the presets.
- `tests/browser/station-search.spec.ts` covers the station list, an expanded row with actual prices, the quick-pick list and its exact search, pagination, unknown-coordinate actions, cancellation/category reset, keyboard tabs, mobile overflow (also with the open list) and the Atlas focus notice, with fixture API responses. Run `npx playwright test tests/browser/station-search.spec.ts` against the dev server.
- `scripts/tests/station-commerce-db.test.mjs` executes the real migrations and RPCs in embedded PostgreSQL: complete/empty snapshots, stale updates, independent services, population-only candidates, carrier moves, identity reconciliation, standalone commodity search, unified four-kind search (run against the rewritten flat RPC), module filters, observed-only engineer matching, radius/price/pagination, RLS; and the station list: one row per station, exact keys (Water vs Water Purifiers, Helper `$gold_name;`, plain vs prismatic shields), station paging with lookahead and total, price/update sorting, the item cap, idempotent re-application and service-only access.
- `scripts/tests/station-commerce-db.test.mjs` also feeds real-format EDSM outfitting/shipyard responses through `edsmInventoryItems` into the station search (symbol, class/rating, the 1G weapon filter) and grades EDDN-style symbols from the FDevIDs catalogue; `scripts/tests/atlas-market.test.mjs` runs the market step against real-format EDSM responses.
- `scripts/tests/market-find-legacy.test.mjs` covers the compatibility `GET /api/market/find`: no external requests, exact keys for known commodities, the reference system from `commerce_systems` or the catalogue, radius clamping, `mode=build` ranking, prices and hidden DB errors.
- `uploader/tests/test_station_commerce.py` covers current-dock matching, all three service files, empty vs unknown inventories, metadata-only visits and durable retry after restart.

The full Node and Python suites pass (web 2.25.2 brought the ring tests to the tilted-ring API, removed the workflow test for the deleted `.github/workflows/build-*.yml` and gave the deadline test a fixed clock).
