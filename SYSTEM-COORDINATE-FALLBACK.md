# Coordinates for hubs, the global route and squadron projects

All three entry points share the same resolver:

1. EDSM exact system-name batch lookup (25 names, up to four parallel requests).
2. Imported Spansh `galaxy_systems` catalog for missing systems.
3. Live Spansh search for remaining names; accept only an exact normalized name.
4. If an exact Spansh search hit contains only ID64, read its dump and recheck
   the system name before accepting coordinates. Do not use rounded large IDs.

Normalization ignores capitalization and repeated/surrounding whitespace;
not prefixes, substring matches, nearest systems or fabricated coordinates.
Every accepted record has all three finite axes. Null/blank axes are not zero;
actual zero coordinates and negative coordinates are valid.

## Compatibility and controls

- `/api/hubs/resolve` resolves new hub coordinates from both providers. The
  admin hub tab also has a bulk fill-missing-coordinates button.
- `/api/route/resolve` and the historical `/api/edsm/batch` URL share one handler,
  preserving `results`, `total` and `resolved` and adding source/name provenance,
  unresolved names and source warnings. Response keys retain requested spelling
  so existing database names still match.
- Batch endpoints accept 1–100 names. Current UI callers use chunks of 10 and
  at most five concurrent writes, rather than sending a whole 20,000-system route.
- Source calls have three-second timeouts, one retry and a 50-second per-request
  budget; the route handlers allow 60 seconds. Source outages do not prevent
  trying other providers. An exhausted budget leaves explicit unresolved names
  and a warning; users can rerun the button for remaining rows.
- Buttons and all seven admin translation dictionaries name EDSM / Spansh.
  Progress and summaries count successful database writes, not merely lookups.
- Already complete stored coordinates are not overwritten. Invalid/partial
  coordinates can be repaired. Failed saves are reported, not counted as success.
- Hub/global-route writes use row IDs. Project writes still use the existing
  authorized PATCH API and only touch `project_systems`, never the global route.
- Project updates fetch the full stored-coordinate list through
  `/api/projects/[id]/systems?coordinates_only=1`, bypassing the project detail
  preview's 1,000-row limit and global-route coordinate enrichment. This optional
  read-only mode pages all project rows and does not load unrelated map metadata.
- Hub list reads now page completely; a failed hub read disables bulk mutations.

## Deployment and verification

No migration or new API key is required. The imported Spansh catalog is optional;
its absence is handled by live Spansh fallback. Existing server database settings
and outbound access to www.edsm.net / spansh.co.uk are required for those sources.

`node scripts/run-tests.mjs system-coordinates large-route` passes 16 tests.
Coverage includes all three actual React button paths, EDSM-first lookup,
catalog/live Spansh fallback, ID64-only dump lookup, exact-name rejection,
invalid coordinates, HTTP failures, correct table/row persistence, failed writes,
all 20,051 rows, and project rows not present in the initial detail view.
TypeScript and diff checks pass. Live production connectivity was not tested;
external providers and database responses are mocked in regression tests.

Full quick suite: 1,040 tests passed; 5 existing unrelated ring geometry/label
tests still fail. No new coordinate tests fail.
