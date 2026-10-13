# Atlas: all nearby systems

New tab: `/atlas?tab=nearby` (Поблизости, Alt+6). This is an independent,
unfiltered system search, not a change to world/market or route-planning filters.

## Volume

- Sphere: Euclidean distance <= R.
- Cube: |dx|, |dy|, |dz| <= R; side length 2R. Corners are R√3 from the center.
- R is 1–50 light years. The UI has a slider and keyboard number input.
- The reference system is included. No synthetic systems are generated.

## Discovery

Reference coordinates: exact normalized name in the local Spansh catalog,
Atlas cache, EDSM, then Spansh. Similar autocomplete names are not accepted.

Every search consults all five readers, even when the local catalog has results:

1. `galaxy_systems` (imported Spansh dump);
2. `atlas_system_cache`;
3. EDSM sphere;
4. EDSM cube;
5. live Spansh systems search, all pages until exhaustion/count or explicit failure.

Local box queries page through the whole result in stable `name_lc` order,
advancing by the actual returned count. They do not use the 2,000-row nearest
RPC or the cache helper's 40-page ceiling. Spansh queries a circumscribed sphere
for cubes; final geometry is checked locally for every source.

Normalized names and trustworthy ID64 aliases are deduplicated. ID64 strings
are preserved; already-rounded large JSON numbers are not presented as exact
IDs. Source provenance, aliases and coordinate conflicts are retained. Preferred
coordinates: local catalog, EDSM sphere, EDSM cube, Spansh API, cache. The same
coordinates determine both display and volume membership.

## Completeness and UI

All obtained records remain in the result state. Pages of 50/100/250 bound DOM
size, not the search dataset. The filter and CSV operate on the entire result
(or the entire filtered result), not the current page. Every row can focus the
map without pretending the system is a project route stop.

The shared 3D overlay has a separate 4,000-marker limit, clearly labelled when
applicable. It does not truncate the result table/CSV. Clicking a later result
adds that point to the overlay and focuses the camera.

Independent source statuses and counts are displayed. A sampled/unconfirmed
local catalog is marked partial. Failed later Spansh pages retain earlier data
and mark it partial. Empty pages before a declared total and repeated pages
are treated as incomplete, not silently successful. Failed local page reads do
not present their partial arrays as a complete catalog.

External requests have timeouts and one retry; coordinate resolution is bounded
by 20 seconds and parallel discovery by 35 seconds. This is not a claim to have
all systems in existence: third-party APIs can cap their output and databases
can be sampled, stale or offline. Source warnings are always available.

## Deployment and validation

No new migration is needed for this addition. It uses existing galaxy and Atlas
cache tables. The preceding market PR still requires its market migration.

Tests cover sphere/cube boundaries, shifted centers, large ID64 values, aliases,
coordinate priority/conflicts, invalid API input, 20,051 local rows with a lower
PostgREST cap, all Spansh pages despite existing local results, source failures,
full-list pagination/filter/CSV, cube/radius payloads and cancelled late responses.

Live EDSM/Spansh and production database connectivity have not been validated
from this sandbox; regression tests use mocked source responses.

Validation: 26 targeted nearby/market/progress/large-route tests passed;
TypeScript and whitespace checks passed. Full quick suite: 1,031 passed,
5 existing failures in unrelated ring geometry/label tests.
