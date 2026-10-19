# ED Ring Colony — Project Context & Architecture

> **Living document for developers and AI assistants.**
> Last updated: **2026-10-19** (checked against the code).
> Web release: **2.24.0** · Colonial Helper: **2.17.0** (`PARSER_VERSION = 5`, launcher 1.0.0).
> 89 SQL migrations · 230 API routes · 59 pages · 147 test files (1563 checks).
> Map of all documents: [DOCS.md](DOCS.md) · history: [CHANGELOG.md](CHANGELOG.md) ·
> how the sections work as one mechanism (analysis, gaps, plan): [ARCHITECTURE.md](ARCHITECTURE.md).
> Project: https://github.com/NooboGreenD/ed-ring-colony
> Live: https://edringcolony.ru

---

## Current deployment

Production runs on the project's own server (Docker Compose) with self-hosted
Supabase at `https://supabase.edringcolony.ru`; the browser may also reach it
through the same-origin gateway `/api/supabase/*` (`next.config.mjs` →
`SUPABASE_INTERNAL_URL`). Vercel is disabled (`vercel.json`), there are **no
GitHub Actions** in the repository.

| Service | What it does |
|---|---|
| `web` | Next.js standalone (`Dockerfile`, `npm test` during the build unless `RUN_TESTS=0`), port `127.0.0.1:3000` behind nginx; bind mounts: Spansh/factions dumps (`GALAXY_DATA_HOST_DIR` → `/app/data/spansh`) and Helper releases (`UPLOADER_STORE_HOST_DIR` → `/data/uploader`) |
| `jobs` | The only scheduler (`scripts/server-jobs.mjs` + `scripts/job-schedule.mjs`): calls `/api/cron/*` and `/api/galnet` inside the Docker network with `CRON_SECRET` — section 9 |
| `monitor-agent` (profile `monitoring`) | Read-only Docker/disk agent for Admin → Мониторинг (`MONITOR_AGENT_TOKEN`) |
| `update-agent` (profile `monitoring`) | The only process with git and a writable Docker socket: project update (`deploy/update-project.sh`), DB backup (`deploy/db-backup.sh`), env and SMTP changes (`UPDATE_AGENT_TOKEN`) — MONITORING.md |

Releases reach production through **Admin → Мониторинг → «Обновить сейчас»**:
git fetch/merge of `PROJECT_UPDATE_BRANCH` (default `main`), optional pg_dump,
missing migrations (everything not in `migrations.mark`, alphabetical),
rebuild, switch, health check; progress is shown to every visitor as
«System Update». Colonial Helper releases are built, signed (Ed25519) and
published by the server itself (Admin → Обновления Helper,
UPLOADER-UPDATE-STRUCTURE.md); source changes in `uploader/` do not reach pilots
until a package is published. The one-off migration to this setup (September
2026) is described in POST-MIGRATION.md / UBUNTU20-UPGRADE.md.

Development goes through pull requests from `arena/*` branches into `main`.

Next 16.3.5 + React 19.2.8, Fiber 9.7.0 / Drei 10.7.8, Supabase SSR 0.12.7;
generated node_modules are not tracked; use `npm ci` and the lockfile.
Node >=22.18. Request cookies/params are async; `src/proxy.ts` replaces middleware.
SSR cookie refreshes preserve no-store headers. Browser URL autologin is disabled.
OAuth link/login shares a signed, UUID-bound PKCE flow for Discord and opt-in
Google/GitHub. Provider credentials belong in GoTrue, not just site env.

Email signup uses anonymous signUp, requires GoTrue autoconfirm=false and
AUTH_EMAIL_ENABLED=true. No SMTP means new signups are closed; existing passwords
are untouched. New email links carry TokenHash in the fragment, then require POST
consent. Recovery has a signed 10-minute user/session-bound grant and revokes
refresh sessions + uploader tokens; it does not silently unlink social methods.
Legacy auto-confirmed email claims need targeted review, not mass account mutation.
SMTP is configured in Admin → Авторизация → «Отправка писем» (MONITORING.md).

Realtime troubleshooting: see REALTIME-FIX.md and the standalone read-only
`deploy/selfhost/realtime-check.py` (Kong vs direct Realtime vs public WSS,
validated Upgrade + Phoenix heartbeat, no keys/env/logs in the report).
NotificationBell/UnreadBadge must never subscribe for guests or with eq.undefined;
subscriptions follow the current auth UUID and clean up on logout/account change.
Fresh nginx templates include a dedicated /realtime/v1/ upgrade route; existing
production TLS configs require a reviewed merge, not rerunning install.sh.

## 1. Project Overview

**ED Ring Colony** is a web platform for coordinating colonization efforts in the game Elite Dangerous. It serves as a command center for player squadrons, colonization planning, a galaxy atlas, fleet carriers, community forum, wiki and leaderboard, with a desktop companion (Colonial Helper) feeding it journal data.

### Core Features
- **Homepage** — Hero with starfield, stats, news feed, Galnet feed
- **Galaxy Map** (`/map`) — 3D map of the colonization ring: hubs, route, pilots, carriers, nebulae, regions, «Все системы ⚗» catalog cloud
- **Atlas** (`/atlas`, 8 tabs) — world search, project route, route A→B, galactic ring, market, nearby, PowerPlay, minor factions; sectors (`/atlas/sector`)
- **System pages** — `/system/[name]` 3D orrery, `/systems` construction progress
- **System Architect** (`/architect`) — buildout planner, plans on the server, appointed system architect; **«Проекты систем»** (`/architect/projects`)
- **Fleet carriers** — personal and squadron carriers tracked by the site from journals (cargo, services, jumps), map layer
- **Squadrons** — CRUD, members, ranks, branding, dual-channel chat, voice rooms (WebRTC)
- **Projects** — squadron colonization projects with route planning
- **Pilot dossier** — `/cmdr/[name]`, `/cmdrs`, Frontier CAPI binding, journal import (site and Helper)
- **Stations and commerce** — `/station-search`, persistent market/outfitting/shipyard snapshots
- **Outfitting / Engineers** — `/outfitting` ship builder, `/engineers` unlock tree, admin catalog editor
- **Forum**, **Wiki**, **News**, **Galnet**, **Community Goals** (`/cg`)
- **Leaderboard** — Player statistics and achievements
- **Notifications** — Real-time push + in-app notification bell
- **Direct Chat**, **Friends**, **Comments**
- **Support** — tickets with attachments (`/support`)
- **Premium shop & billing** — cosmetics, titles, subscriptions, credits, T-Bank (off by default)
- **Admin Panel** — 4 groups of tabs (content, community, game data, system & services) + **Mobile Admin `/m-admin`** (PWA, 9 tabs, HUD, bottom nav, auto-refresh 20s)
- **Android App** — Native Kotlin + Compose monitor in `android-app/` (currently does not compile — see android-app/README.md)
- **i18n** — 7 interface languages (ru, en, de, it, ko, zh, ja) with Yandex Translate for content

---

## 2. Tech Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Framework | Next.js / React | 16.3.5 / 19.2.8 | App Router, `output: 'standalone'`; async cookies/params, `src/proxy.ts` |
| Mobile Web | Next.js `/m-admin` | — | PWA, HUD, bottom nav 9 tabs, auto-refresh 20s, uses /api/mobile/admin-summary |
| Android | Kotlin + Compose | 1.9.22 / BOM 2024.02 | `android-app/`: Material3 HUD theme, Navigation Compose, Retrofit2, EncryptedSharedPreferences, Min SDK 26 |
| Desktop | Python + Tk | 3.10+ | Colonial Helper (`uploader/`): ttkbootstrap, requests; launcher + signed code bundle |
| Language | TypeScript + Python + Kotlin | 5.x | Strict mode |
| Styling | Tailwind CSS + CSS | 4.3.3 | `src/app/globals.css`, `src/styles/forum-extra.css`, CSS modules in `components/Admin` |
| UI Library | None | — | Custom components only, no external icon lib |
| Icons | Custom SVG | — | `src/components/Icons.tsx` (131 icons) |
| 3D | Three.js / R3F / Drei | 0.185.1 / 9.7.0 / 10.7.8 | Galaxy map, system orrery (`lib/orrery3d`) |
| Database | Supabase (self-hosted) | — | PostgreSQL + PostgREST + Realtime + Storage behind Kong |
| Direct Postgres | `pg`, `pg-copy-streams` | 8.x / 7.x | Heavy imports (catalog `COPY`, factions chunks) via `DATABASE_URL`/`SUPABASE_DB_URL` |
| Auth | Supabase Auth + own OAuth | — | Email (confirmed) + Discord (+ opt-in Google/GitHub) + VK ID + Yandex ID; Bearer JWT for Android; `rc_…` API tokens for Helper |
| ORM | None | — | Direct Supabase queries and SQL functions |
| State | React hooks | — | No Redux/Zustand; Realtime for live data |
| Push | web-push | 3.6.7 | Server-side push |
| Markdown | react-markdown | 10.1.0 | + remark-gfm + rehype-sanitize |
| Validation | zod | 4.4.3 | Schema validation |
| Cache | lru-cache | 11.5.2 | In-memory caching |
| i18n | Custom context | — | `lib/i18n/` (ru, en, de, it, ko, zh, ja) |
| Translate | Yandex Cloud Translate | v2 | Jobs `translate`, `galnet-sync` |
| Tests | node:test, jsdom, esbuild, PGlite, libpg-query, Playwright | — / 1.63.0 | `scripts/run-tests.mjs`, `tests/browser/` |

---

## 3. Architecture

### 3.1 App Router Structure
```
src/
  proxy.ts                # session refresh (@supabase/ssr), maintenance stub (app_flags), /api/supabase/* tunnel passthrough
  app/
    layout.tsx            # Root: topbar (SiteStatusBar: System Online/Update) + sidebar + footer
    page.tsx              # Homepage
    atlas/ map/ system/[name]/ systems/ architect/ architect/projects/ outfitting/ engineers/
    station-search/ squadrons/ projects/ cmdr/[name]/ cmdrs/ leaderboard/ forum/ wiki/ news/ galnet/ cg/
    account/ (capi, friends, journal, messages) login/ register/ auth/ forgot-password/ reset-password/
    support/ premium-shop/ offer/ details/ maintenance/
    admin/                # /admin?tab=… (AdminNavigation.tsx: 4 groups)
    m-admin/              # Mobile admin PWA — HUD, bottom nav, 9 tabs
    api/                  # 228 route handlers (section 5)
  components/             # GalaxyMap/, SystemMap/, Atlas/, Architect/, Carriers/, Admin/, Outfitting/, ...
  hooks/                  # useAtlasData, usePowerplayLayer, useFactionsLayer, useAtlasSearchProgress, ...
  lib/                    # server + shared logic (imports, sync, CAPI, BGS, PowerPlay, carriers, architect, outfitting, i18n)
  types/

android-app/              # Native Android monitor app
  app/src/main/java/com/edringcolony/monitor/
    MainActivity.kt       # Scaffold + TopBar + BottomNav + Auth + 20s polling
    data/                 # model (Gson), network (Retrofit), local (EncryptedSharedPrefs), repository
    ui/                   # theme (Color.kt from DESIGN.md), components, screens (9 + Login + WebView), navigation
```

### 3.2 Data Flow
```
Browser → Next.js App Router → API Route → Supabase (service role / user JWT) or direct Postgres
         ↓
    Server Component → supabaseServer.ts → Supabase (direct)
    Client Component → supabaseClient.ts → Supabase (direct + Realtime), via /api/supabase/* when configured
Colonial Helper → /api/* with `Authorization: Bearer rc_…` → server-side validation → Supabase
jobs → http://web:3000/api/cron/* with CRON_SECRET
```

### 3.3 Supabase Clients
| Client | File | Use Case |
|--------|------|----------|
| Browser | `src/lib/supabaseClient.ts` | Client components, Realtime subscriptions, `authFetch` |
| Server | `src/lib/supabaseServer.ts` | Server components, API routes (`createClient`, `authFromRequest`, `createServiceClient`) |
| Admin | `src/lib/supabaseAdmin.ts` | Service role operations (bypass RLS) |
| Request user | `src/lib/requestUser.ts`, `src/lib/helperAuth.ts` | Cookie / Bearer JWT / `x-journal-token`; `resolveRequestUser` also accepts Helper `rc_…` tokens |
| Direct Postgres | `src/lib/pgModule.ts`, `src/lib/pgReachability.ts` | Bulk writers (catalog `COPY`, factions chunks) |

### 3.4 Authentication Flow
1. User opens `/login`: email/password (confirmed email required, SMTP must work)
   or OAuth — Discord (+ Google/GitHub when enabled) through GoTrue, VK ID and
   Yandex ID through the site's own PKCE flows (`/api/auth/vk`, `/api/auth/yandex`).
   Which buttons are shown — Admin → Авторизация (`/api/admin/auth-providers`).
2. Supabase Auth sets the session cookie; `src/proxy.ts` refreshes it on every
   page request (`supabase.auth.getUser()`), skipping the `/api/supabase/*` tunnel.
3. Server code reads the user with `authFromRequest` (cookie or Bearer JWT);
   routes that Colonial Helper calls use `resolveRequestUser` (session **or**
   API token `rc_…`, hashed lookup in `api_tokens`).
4. Roles live in `profiles.role` (`user` / `moderator` / `admin`; billing also
   knows `support_manager`). `profiles` itself is readable only by its owner and
   staff — public reads go through the `public_profiles` view (section 8.22).
5. Android logs in with `POST /api/mobile/auth` (admin only) and sends a Bearer JWT.

### 3.5 Realtime Subscriptions
Tables the browser subscribes to (`postgres_changes`): `messages` (direct chat),
`friends`, `user_notifications`, `forum_notifications`,
`squadron_chat_messages` (filtered by squadron), `squadron_voice_participants`
and `squadron_voice_signals` (WebRTC signalling). Server-side the publication
also contains `construction_depot_snapshots` and `squadron_member_locations`.

### 3.6 System orrery layout engine (site ↔ uploader)
Both map clients share one pure layout model, so the website and the desktop
helper cannot disagree about where a body sits:

| Side | Engine | Renderer |
|------|--------|----------|
| Website `/system/[name]` | `src/lib/systemOrrery.ts` | `src/components/SystemMap/SystemOrrery3D.tsx` (three.js via `src/lib/orrery3d`) |
| Colonial Helper «Карта системы» | `uploader/orrery.py` | `uploader/tk_orrery.py` (Tk canvas scene) + `uploader/system_view.py` (payload: palette, facts, zones) |

Invariants that must stay identical in both languages:

- Scene units, not kilometres: positions are normalised into `SCENE_SPAN = 240`
  (Python `CANVAS_PX = 1000` is the pixel space the same span is projected into).
- Bodies attach to their star by the letter key in the name (`extractStarKey`:
  `Sol A 3` → `A`, `Sol AB 5` → `AB`); each star gets its own radial budget, moons
  stay on their parent planet, rings around their own body.
- Ground structures are anchored to the body sphere:
  `unitsPerPixel = 2 * halfSpan / canvasPx`,
  `bodyDisplayRadiusUnits = max(0.6, markerPx / 2 * unitsPerPixel * 1.25)`,
  station lift = that radius + `0.35`, fanned by the golden angle. The same
  formula re-runs in browser JS (`structurePositions()`) on every relayout, so
  zooming never leaves a station floating off the surface.
- Focus levels are monotonic in `halfSpan`: 0 system → 1 star cluster → 2 body
  neighbourhood → 3 surface, camera `eye = 1.65 / 1.2 / 0.9 / 0.72`, sphere
  fraction `0.14` at level 2 and `0.42` at level 3.
- Decluttering thresholds: labels are suppressed when
  `bodies.length > 28 || extraMarks > 6` or `zoom >= 2`, and re-enabled for the
  selected target or by the explicit "all labels" switch. Marker sizes: sites 5.5 px
  (9 when targeted), stations 5.0, carriers 5.5, label font 9 px.
- Habitable zone is computed per star from luminosity
  (`habitableZoneLs` / `habitable_zone_ls`), not per system.
- **Real orbital elements.** When a body carries elements, both engines draw the
  same physical orbit instead of a decorative circle:
  `parseOrbitalElements` / `has_real_elements` read eccentricity, inclination,
  argument of periapsis, period, mean anomaly and axial tilt; `solveKepler` /
  `solve_kepler` solve `M = E − e·sin E` (Newton, 6 iterations, `e` clamped to
  0.98); `orbitPoint` / `orbit_point` place the star at the **focus**
  (`r = a(1−e²)/(1+e·cos ν)`), not at the centre. The distributed radius is
  treated as the **apoapsis** (`a = radius / (1 + e)`), so an eccentric orbit can
  never leave its cluster budget and the distance ordering stays monotonic.
  Bodies without elements keep the golden-angle fallback, and `fromData` /
  `has_real_elements` is what tells the UI not to label a fallback orbit as real.
- **Playback is absolute, not incremental.** `motion.orbitalDeltas(t)` returns a
  displacement per body (`positionAtTime − scanPosition`, plus the parent's own
  displacement for moons and planets around moving stars), and `viewer.applyMotion`
  writes `base + delta` into every dependent object registered in
  `scene.bodyAttachments` (body group, rings, signal markers, ground structures).
  Nothing accumulates, so `t = 0` is an exact reset and bodies cannot drift off
  their drawn orbits. Coordinates are used verbatim: the root group is already
  rotated (`root.rotation.x = -π/2`), so no extra axis swizzle in the viewer.
- **The camera belongs to the user.** `applyCamera()` runs only on explicit
  selection or focus changes; a click that follows a drag (> 4 px or > 350 ms) is
  ignored, an empty click merely clears emphasis, and the `state` event is
  throttled to 8/s so React re-renders never reset the orbit controls.
- **Element units differ by source** and are disambiguated by field name, never by
  magnitude: the journal's `Scan` gives `SemiMajorAxis` in metres and
  `OrbitalPeriod` in seconds; EDSM `/api-system-v1/bodies` gives `semiMajorAxis`
  in AU, `orbitalPeriod` in days, `orbitalEccentricity` (not `eccentricity`) and
  no mean anomaly at all. A long-period body (> 1e5 days) must not be
  reinterpreted as seconds.
- Star colour comes from surface temperature (blackbody stops shared by
  `starColorFromTemperature` / `star_color_from_temperature`) with the spectral
  class only as a fallback; marker size scales with the star's true radius
  (`starRadiusScale` / `star_radius_scale`, log-scaled and clamped to 0.45–2.6).
  Ring planes follow axial tilt, not orbital inclination.
- Body signals (bio, geo, human, thargoid, guardian, other) live in one module,
  `src/lib/bodySignals.ts`, mirrored by `SIGNAL_ATTRIBUTES` /
  `classify_body_signal` in `uploader/system_map.py`. The journal parser, the
  catalogue API, the orrery payload, the 3D scene and the architect all read
  that module — do not re-derive counts from `raw_data` anywhere else. Version 4
  of the view payload added `body.signals` and `summary.signals`.
- The payload fed to the renderer is versioned: `ORRERY_VIEW_VERSION` (TS) must
  equal `uploader/system_view.py:VIEW_VERSION` and the `contract=` marker of the
  committed bundle; `uploader/tests/test_system_view.py` checks all three.
- Tests pin the parity: `scripts/tests/system-orrery.test.mjs` (28 cases),
  `scripts/tests/system-orrery-3d.test.mjs` (engine: payload, scene, camera,
  picking, bundle freshness) and `uploader/tests/test_orrery_layout.py` +
  `test_system_view.py`.
- The dossier cargo split lives in `src/lib/dossierCargo.ts` (`summarizeCargo`),
  fed by the same rows the leaderboard uses: `totalTons` = every `deliveries`
  row, `siteTons` = rows where `is_construction IS DISTINCT FROM false` never
  holds. `scripts/tests/dossier-cargo.test.mjs` and the end-to-end case in
  `journal-telemetry.test.mjs` assert that the dossier numbers equal the
  parser's own `transportedTons`/`constructionTons` for one and the same
  journal. The leaderboard is deliberately not filtered by the flag: it has
  always summed every delivery, and re-defining it would silently rewrite
  existing commanders' ranks.

---

## 4. Database Schema

128 tables are created by the 89 migrations in `supabase/migrations/` (a few of
them are legacy and empty on fresh installs). Grouped by area — the migration
named in brackets introduced the group; everything else comes from
`000_base_schema.sql` / early migrations. Full schema in one file:
`supabase/full_schema.sql`; operations: [supabase/DATABASE.md](supabase/DATABASE.md).

### 4.1 Tables by area
| Area | Tables |
|---|---|
| Users and access | `profiles` (+ view `public_profiles`), `api_tokens`, `vk_identities`, `yandex_identities`, `profile_avatars`, `location_privacy`, `user_pois`, `app_flags` (maintenance flag) |
| Squadrons | `squadrons`, `squadron_members`, `squadron_ranks`, `squadron_chat_messages`, `squadron_voice_rooms`, `squadron_voice_participants`, `squadron_voice_signals`, `squadron_member_locations`, `squadron_carriers` (legacy) |
| Squadron projects and the ring route | `projects`, `project_members`, `project_systems`, `project_build_plans`, `hubs`, `hub_goals`, `route_systems`, `route_tracks`, `system_progress` (Raven cache), `system_coords`, `colonisation_market_systems` |
| Journals and dossier | `deliveries` (`source`, `is_construction`, `market_id`, `source_hash`), `journal_imports`, `colonisation_sites` (one row per site, `20261009010000`), `construction_depot_snapshots`, `colonisation_events` (legacy), `system_scans`, `pilot_stats` (`stats_source`), `capi_profiles`, `capi_tokens`, `inara_profiles` |
| Achievements | `achievement_ranks`, `achievement_tracks`, `badges`, `hero_badges`, `user_badges`, `user_hero_badges`, `user_achievements` |
| Architect | `system_plans` (`20260929000000`), `system_architects` (`20261006000000`), `architect_systems`, `raven_keys` (`20261010020000`), `raven_sync_log`, `architect_projects`, `architect_project_members`, `architect_project_systems`, `architect_project_carriers` (`20261017120000`) |
| Fleet carriers | `fleet_carriers`, `fleet_carrier_cargo`, `fleet_carrier_events` (`20261017000000`, claims — `20261018000000`) |
| Atlas and the galaxy catalog | `galaxy_systems` (~2×10⁸ rows, GiST `cube` index), `galaxy_systems_meta` (`20260921120000` … `20261009000000`), `atlas_candidates`, `atlas_favorites`, `atlas_routes`, `atlas_searches`, `atlas_ring_system_cache`, `atlas_system_cache`, `atlas_body_cache`, `atlas_ring_sessions` (`20261011000000`), `market_search_jobs`, `market_search_cache` |
| Markets and stations | `eddn_messages`, `market_prices`, `commodity_needs`, `commerce_systems`, `station_commerce`, `station_inventory_snapshots` (`20261014000000`) |
| PowerPlay and minor factions | `powerplay_systems`, `powerplay_sync_state` (`20261018120000`, `20261018180000`; owner basis — `20261021120000`); `bgs_systems`, `bgs_factions`, `bgs_faction_presence`, `bgs_sync_state`, `bgs_updates` (`20261019120000`); live EDDN listener — `eddn_listener_state` (`20261021130000`) |
| Community Goals | `community_goals` |
| Forum, wiki, content | `forum_categories`, `forum_threads`, `forum_posts`, `forum_reactions`, `forum_reports`, `forum_subscriptions`, `forum_notifications`, `forum_moderation_logs`, `forum_post_history`, `forum_tags`, `thread_tags`; `wiki_articles`, `wiki_categories`, `wiki_tags`, `wiki_article_tags`, `wiki_revisions`, `wiki_favorites`, `wiki_redirects`; `news`, `galnet_news`, `galnet_sync_log`, `site_content` (+ `<field>_<lang>` columns), `comments` |
| Messaging | `messages`, `friends`, `notifications`, `user_notifications`, `push_subscriptions` |
| Support | `support_tickets`, `support_messages`, `support_attachments` |
| Billing and shop | `billing_plans`, `billing_transactions`, `billing_settings`, `payment_intents`, `payment_providers`, `payment_webhook_events`, `shop_items`, `user_balances`, `user_inventory`, `user_cosmetics_equipped`, `user_subscriptions` |
| Outfitting | `outfitting_catalog` (admin overrides), `outfitting_builds` (saved builds) |

Heavy logic lives in SQL functions called through PostgREST RPC with the
service role, e.g. `colonisation_sites_write`, `colonisation_retention_prune`,
`apply_fleet_carrier_batch`, `save_station_commerce`, `search_station_catalog`,
`powerplay_apply_batch` / `powerplay_finish_sync` / `powerplay_layer_rows` /
`powerplay_apply_observations`, `bgs_apply_snapshots` / `bgs_layer_rows` /
`bgs_system_detail`, `architect_project_progress_sources` /
`architect_project_contributions`, and the cross-section functions of
`20261020120000_unified_system_data.sql`: `system_overview_sources`,
`system_progress_sources`, `sync_project_systems_from_sites` (section 8.23).
Calls that may return many rows return one JSON value to bypass PostgREST
`max_rows`; long jobs are split into short calls to fit `statement_timeout`.

### 4.2 Key Relationships
```
profiles (1) ──< (N) squadron_members >── (N) squadrons
squadrons (1) ──< (N) squadron_ranks / squadron_chat_messages / projects
projects (1) ──< (N) project_members / project_systems
profiles (1) ──< (N) deliveries / system_scans / api_tokens / user_notifications / comments / friends / messages
profiles (1) ── (1) pilot_stats / capi_tokens / capi_profiles
fleet_carriers (N) >── (1) profiles (owner_id)   fleet_carriers (N) >── (1) squadrons (squadron_id)
fleet_carriers (1) ──< (N) fleet_carrier_cargo / fleet_carrier_events
architect_projects (1) ──< (N) architect_project_members / _systems / _carriers
bgs_systems (1) ──< (N) bgs_faction_presence >── (1) bgs_factions
station_commerce (1) ──< (N) station_inventory_snapshots
forum_categories (1) ──< (N) forum_threads ──< (N) forum_posts ──< (N) forum_reactions
wiki_categories (1) ──< (N) wiki_articles >──< (N) wiki_tags
```

### 4.3 RLS Policies
All tables have Row Level Security enabled. Key policies:
- `profiles`: owner and staff read (`request_is_staff()`), anon has no SELECT;
  public columns through the view `public_profiles`; `role`/`email` change only
  by admins or the server (trigger `protect_profile_privileged_columns`)
- `deliveries`: owner and staff; `pilot_stats`: owner only; the public dossier
  is assembled server-side with the pilot's privacy settings
  (`src/lib/privacy.ts → publicPilotView`)
- `capi_tokens`, `inara_profiles`: service_role only; `api_tokens`: no
  `token_hash` reads, no direct writes
- `squadrons`: public read, creator/officer write; `squadron_chat_messages`:
  members read/write, author/officer delete
- `user_notifications`: self only; `wiki_articles`, `comments`: public read, author/admin write
- Carrier, station, PowerPlay, faction, architect-project tables: writes only
  through service-role functions; Next.js routes decide permissions

### 4.4 Migrations
- Files: `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` (plus the historical
  `000_base_schema.sql`, `001_rls_policies.sql`, early `2025…` files). Applied
  in **alphabetical order**. Every new migration must be idempotent
  (`IF NOT EXISTS`, `CREATE OR REPLACE`, guarded `DO` blocks): the server may
  re-apply a migration, and `full_schema.sql` already contains it.
- Production: `deploy/update-project.sh` (button «Обновить сейчас» with
  «с миграциями», or «Применить только миграции») applies every file that is
  not yet listed in `UPDATE_STATE_DIR/migrations.mark`, after a pg_dump.
- Snapshot: append the new migration as a block to `supabase/full_schema.sql`
  (`-- MIGRATION: <file>` marker, same order) —
  `scripts/tests/migrations-sql.test.mjs` fails otherwise; the same test parses
  every file with libpg-query.
- Hosted Supabase: `npx supabase db push` (README → Database Setup).

---

## 5. API Routes

228 route handlers in `src/app/api/**/route.ts`. «Доступ» is what the handler
checks itself:

| Значение | Смысл |
|---|---|
| `—` | публично; «(с сессией — больше)» — вошедший видит больше (своё, черновики, права) |
| `сессия` | вошедший пользователь: cookie сайта или `Authorization: Bearer <JWT>` |
| `токен` | API-токен Colonial Helper `rc_…` (`Authorization: Bearer rc_…` или в теле) |
| `сессия/токен` | любое из двух (`src/lib/helperAuth.ts → resolveRequestUser`) |
| `участник проекта` | сессия + права в «Проекте систем» (`openProject`, роли — ARCHITECT.md) |
| `модератор` | `profiles.role` ∈ admin, moderator |
| `staff` | admin, moderator, support_manager (`src/lib/billing/auth.ts → requireStaff`) |
| `admin` | только администратор |
| `cron` | `Authorization: Bearer $CRON_SECRET` (`src/lib/cronAuth.ts`) |
| прочее | `секрет EDDN` (`x-eddn-secret`), `токен публикации` (`UPLOADER_PUBLISH_TOKEN`), `подпись провайдера`, `OAuth`/`подписанная cookie` (колбэки), `грант восстановления` |

Таблица собрана по коду обработчиков 18.10.2026; тонкие права (владелец
строки, офицер эскадрильи, архитектор системы) проверяются внутри маршрута.

### 5.1 Atlas, карта и каталог систем

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/atlas/candidates` | GET · — | Кандидаты поиска миров по `search_id` |
| `/api/atlas/favorites` | GET/POST/DELETE · сессия | Избранные системы Atlas |
| `/api/atlas/nearby` | POST · — | Все системы в сфере/кубе 1–50 св. лет вокруг опорной |
| `/api/atlas/ring-route` | GET · —<br>POST · — (с сессией — больше) | Галактическое кольцо: шаговая сессия (POST — шаг/продолжение по `session_id`, GET — состояние) |
| `/api/atlas/ring-route/finalize` | POST · — | Собрать замкнутое кольцо из пройденных сегментов |
| `/api/atlas/ring-route/hubs` | POST · — | Кандидаты в хабы у опорных точек кольца (радиус 14.99 св. лет) |
| `/api/atlas/ring-route/preview` | GET · — | Координаты превью кольца без создания сессии |
| `/api/atlas/ring-route/refine` | POST · — | Заменить расчётные точки кольца реальными системами |
| `/api/atlas/ring-route/replan` | POST · — | Сбросить сессию кольца для прогона с новыми параметрами |
| `/api/atlas/ring-route/save` | POST · сессия | Сохранить кольцо в проект эскадрильи |
| `/api/atlas/route` | POST · — | Маршрут по найденным кандидатам (`atlas_routes`) |
| `/api/atlas/route-finder` | POST · — | Маршрут A→B прыжками ≤ 15 св. лет (каталог проекта, кэш, EDSM) |
| `/api/atlas/search` | GET · —<br>POST · — (с сессией — больше) | Поиск миров: POST — фоновая сессия, GET — прогресс и кандидаты |
| `/api/atlas/sector` | GET · — | Галактические секторы (регионы кодекса) с границами |
| `/api/atlas/sector/[id]` | GET · — | Один сектор |
| `/api/atlas/sessions` | GET · сессия | История поисков пилота |
| `/api/atlas/system-bodies` | GET · —<br>POST · токен | Тела системы из трёх источников со сверкой (`?compare=1`); POST — сканы тел от Helper |
| `/api/cg` | GET · — | Community Goals (`community_goals`) |
| `/api/eddn` | GET · —<br>POST · секрет EDDN | Последние сообщения EDDN (`eddn_messages`, `?system=&event=`); POST — приём сообщения |
| `/api/eddn/ingest` | POST · секрет EDDN | Приём сообщений от EDDN-воркера (`scripts/eddn-worker.ts`) |
| `/api/edsm/batch` | POST · — | Прокси EDSM: несколько систем |
| `/api/edsm/search` | GET · — | Прокси EDSM: поиск систем |
| `/api/edsm/system` | GET · — | Прокси EDSM: система |
| `/api/factions/presence` | GET · — | Системы выбранных фракций (`?ids=`) |
| `/api/factions/search` | GET · — | Поиск фракций (`?q=&player=1`) |
| `/api/factions/sync` | POST · сессия/токен | Состояние фракций из журналов (Helper, загрузчик), ≤ 500 событий |
| `/api/factions/system` | GET · — | Карточка системы со всеми фракциями (`?id64=`) |
| `/api/factions/systems` | GET · — | Слой «Фракции»: все населённые системы компактными кортежами (`?meta=1` — только статус) |
| `/api/galaxy/all-systems` | GET · — | Облако точек «Все системы ⚗» (`edgs-v1`): кэш на диске → storage → сборка из таблицы; 503 + подсказка, пока каталог пуст |
| `/api/galaxy/stats` | GET · — | Статус каталога и импорта (счётчики, прогресс, ошибка) |
| `/api/galaxy/systems/[id64]` | GET · — | Система каталога по ID64 |
| `/api/galaxy/systems/by-name` | GET · — | Система каталога по имени |
| `/api/galaxy/systems/search` | GET/HEAD · — | Автодополнение по каталогу систем |
| `/api/hubs` | GET · — | Хабы колонизации для карты |
| `/api/hubs/resolve` | GET · — | Координаты хабов (EDSM → каталог → Spansh) |
| `/api/map/carriers` | GET · — (сессия — своё/эскадрилья) | Слой «Авианосцы»: публичные отметки (без груза и финансов), отношение к зрителю |
| `/api/map/pilots` | GET · — (с сессией — больше) | Пилоты на карте (только разрешившие показ позиции) |
| `/api/market/find` | GET · — | Старый поиск рынка напрямую по EDSM (`?commodity=&reference_system=&mode=build`) |
| `/api/market/find/start` | POST · — | Поиск рынка (вкладка «Рынок»): создать задание |
| `/api/market/find/status` | GET · — | Поиск рынка: состояние задания |
| `/api/market/find/step` | POST · — | Поиск рынка: следующий шаг (бюджет 35 с на внешние запросы) |
| `/api/market/search` | GET · — | Цены по товару из `market_prices` (EDDN) |
| `/api/powerplay/systems` | GET · — | Слой PowerPlay: компактные кортежи систем, ETag, `meta.progress` |
| `/api/route` | GET · — | Общий маршрут кольца (до 20 000+ систем, полное чтение страницами) |
| `/api/route/progress` | POST · сессия | Отметить прогресс системы маршрута |
| `/api/route/resolve` | POST · — | Координаты систем маршрута (EDSM → каталог → Spansh) |
| `/api/stations/report` | POST · сессия/токен | Станции и рынки от Colonial Helper (`station_commerce`; источник ставит сервер) |
| `/api/stations/search` | GET · — | Поиск товаров по станциям (`/station-search`) |
| `/api/systems/overview` | GET · — (зритель по сессии) | Карточка системы: каталог, стройка (тот же расчёт, что у «Проектов систем»), проекты, кольцо, станции, фракции, PowerPlay, авианосцы, цели, поставки, ссылки (`src/lib/systemOverview.ts`, SQL `system_overview_sources`) |
| `/api/systems/progress` | GET · — | Стройплощадки и прогресс системы (Архитектор, `/systems`) |

### 5.2 Колонизация: Архитектор, проекты, Raven Colonial

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/architect/existing` | GET · — | Фактическая застройка системы: стройплощадки и станции из БД проекта и внешних источников |
| `/api/architect/governance` | GET · — / admin<br>PUT · admin<br>DELETE · admin / архитектор | Архитектор системы: кто назначен (GET — всем; `?search=` — только admin), назначить, снять (admin или сам архитектор) |
| `/api/architect/plans` | GET · — (с сессией — больше)<br>POST · сессия | Планы застройки: свои и опубликованные; POST — сохранить |
| `/api/architect/plans/[id]` | GET · — (с сессией — больше)<br>PUT · сессия<br>DELETE · сессия | Один план (ссылка `/architect?plan=<id>`): открыть, изменить, удалить |
| `/api/architect/projects` | GET/POST · сессия | «Проекты систем»: мои проекты; POST — создать |
| `/api/architect/projects/[id]` | GET/PATCH/DELETE · участник проекта | Проект систем: карточка, правка (создатель/модераторы), удаление (создатель) |
| `/api/architect/projects/[id]/carriers` | POST/PATCH/DELETE · участник проекта | Авианосцы проекта: добавить по Carrier ID/позывному, изменить, убрать |
| `/api/architect/projects/[id]/leaderboard` | GET · участник проекта | Лидеры проекта: кто сколько и куда привёз |
| `/api/architect/projects/[id]/members` | GET/POST/PATCH/DELETE · участник проекта | Участники проекта: подсказка пилотов, приглашение, роли, исключение |
| `/api/architect/projects/[id]/progress` | GET/POST · участник проекта | Прогресс систем проекта; POST — обновить из Raven/снимков |
| `/api/architect/projects/[id]/systems` | POST/PATCH/DELETE · участник проекта | Системы проекта: добавить списком, изменить, убрать |
| `/api/architect/raven-key` | GET/PUT/DELETE · сессия | Ключ Raven Colonial пилота: статус (маска), сохранить, удалить |
| `/api/architect/raven-project` | POST · сессия | Создать проект Raven Colonial для постройки плана от имени пилота |
| `/api/architect/sourcing` | POST · — | «Где купить» материалы плана по рынкам базы EDDN |
| `/api/projects` | GET · —<br>POST · сессия | Проекты эскадрилий: список, создание |
| `/api/projects/[id]` | GET/PATCH/DELETE · сессия | Проект: карточка, правка, удаление |
| `/api/projects/[id]/assign` | POST/DELETE · сессия | Назначить/снять пилота на систему проекта |
| `/api/projects/[id]/members` | GET/POST/PATCH/DELETE · сессия | Участники проекта |
| `/api/projects/[id]/progress` | GET · —; POST · — | GET — прогресс каждой системы проекта тем же расчётом, что у «Проектов систем» (кэш Raven + журналы); POST — обновить прогресс систем проекта из Raven Colonial |
| `/api/projects/[id]/route` | POST · сессия | Построить маршрут проекта |
| `/api/projects/[id]/systems` | GET · —<br>POST · сессия<br>PATCH · сессия<br>DELETE · сессия | Системы проекта |
| `/api/projects/[id]/systems/bulk` | POST · сессия | Добавить системы проекта списком |
| `/api/ravencolonial/[name]` | GET · — | Система из Raven Colonial (прокси) |
| `/api/ravencolonial/sync` | POST · модератор | Синхронизация с Raven Colonial |
| `/api/ravencolonial/sync/log` | GET · — | Журнал синхронизаций Raven |
| `/api/ravencolonial/sync/single` | POST · сессия | Синхронизировать одну систему |

### 5.3 Журналы, Colonial Helper, авианосцы, пилоты

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/carriers` | GET · — (сессия/токен — больше)<br>POST · сессия/токен | Носители эскадрильи (`?squadron_id=`); посторонним — без груза и финансов; POST — привязка эскадренного носителя (как `/bind`) |
| `/api/carriers/[id]` | GET · — (сессия/токен — больше) | Носитель по Carrier ID или позывному; посторонним — без груза и финансов |
| `/api/carriers/bind` | POST/DELETE · сессия/токен | Ручная привязка/отвязка личного или эскадренного носителя |
| `/api/carriers/mine` | GET · сессия/токен | Личный носитель и носители эскадрильи (оверлей Helper) |
| `/api/carriers/sync` | POST · сессия/токен | Журнальные события авианосцев (Helper, загрузчик журналов) |
| `/api/cmdr/stats` | GET · — (с сессией — больше)<br>POST · токен | Сводка пилота для досье; POST — сводка от Helper |
| `/api/inara/sync` | POST · сессия | Синхронизация профиля Inara |
| `/api/journal/import` | POST · сессия | Импорт журнала (страница `/account/journal`, CAPI), многошаговый |
| `/api/journal/parse` | POST · сессия | Разбор журнала без записи (предпросмотр) |
| `/api/journal/reset` | POST · сессия/токен | «Перезагрузить логи с нуля»: очистка ранее загруженных данных пилота (`confirm: true`) |
| `/api/leaderboard` | GET · — | Лидерборд пилотов |
| `/api/leaderboard/stats` | GET · — | Статистика для блоков лидерборда |
| `/api/logs/import` | POST · сессия/токен | Загрузка журналов из кабинета `/account`: доставки, стройки, сканы, сводка |
| `/api/logs/upload` | POST · токен | Доставки и снимки строек от Colonial Helper (по 100 записей) |

### 5.4 Frontier CAPI

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/capi/auth` | GET · сессия | Старт PKCE-авторизации Frontier (`?platform=` → `audience`) |
| `/api/capi/callback` | GET · подписанная cookie | Колбэк Frontier: токены → `capi_tokens` → первая синхронизация → `/account/capi` |
| `/api/capi/journal` | GET · сессия | Журнал CAPI за дату (`204/206` → `empty`/`partial`) |
| `/api/capi/profile` | GET · сессия | Кэш профиля CAPI и состояние привязки |
| `/api/capi/status` | GET · сессия | Диагностика привязки без секретов |
| `/api/capi/sync` | POST · сессия | Ручная синхронизация (профиль + журнал) с отчётом |
| `/api/capi/token` | GET/POST · сессия/токен | Общая привязка CAPI между Helper и сайтом; GET продлевает access-токен |
| `/api/capi/unlink` | DELETE · сессия | Отвязать Frontier |

### 5.5 Сообщество и контент

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/avatars/[id]` | GET · — | Аватар из БД (ETag, immutable-кэш) |
| `/api/comments` | GET · —<br>POST · сессия | Комментарии: список, добавление |
| `/api/comments/[id]` | DELETE · сессия | Удалить комментарий (автор/модерация) |
| `/api/discord/webhook` | POST · модератор | Сообщение в Discord-вебхук проекта |
| `/api/forum/categories` | GET · — | Категории форума |
| `/api/forum/latest` | GET · — | Последние сообщения форума |
| `/api/forum/posts` | GET · —<br>POST · сессия<br>PATCH · сессия | Сообщения темы: список, ответ, правка |
| `/api/forum/reactions` | GET · — | Реакции на сообщения |
| `/api/forum/report` | POST · сессия | Жалоба на сообщение |
| `/api/forum/search` | GET · — | Поиск по форуму |
| `/api/forum/subscribe` | POST · сессия | Подписка на тему |
| `/api/forum/threads` | GET · —<br>POST · сессия | Темы: список, создание |
| `/api/forum/views` | POST · — | Счётчик просмотров темы |
| `/api/friends` | GET/POST/PATCH/DELETE · сессия | Друзья: список, заявка, ответ, удаление |
| `/api/galnet` | GET · —<br>POST · cron<br>PATCH · cron | Статьи Galnet (`?locale=&limit=`); POST — синхронизация + перевод, PATCH — догон переводов |
| `/api/galnet/[nid]` | GET · — | Одна статья Galnet (по `nid`, `guid` или `slug`) |
| `/api/home-data` | GET · — | Данные главной: hero-текст, новости, Galnet, счётчики (`no-store`) |
| `/api/news` | GET · —<br>POST · cron | Новости сайта; POST — создание с переводом (служебный, `CRON_SECRET`) |
| `/api/news/[id]` | GET · — | Одна новость |
| `/api/notifications` | GET/PATCH · сессия | Уведомления пользователя; PATCH — прочитано |
| `/api/push/send` | POST · модератор | Отправить push-уведомление |
| `/api/push/subscribe` | POST/DELETE · сессия | Подписка браузера на push |
| `/api/squadrons` | GET · —<br>POST · сессия | Эскадрильи: список, создание |
| `/api/squadrons/[id]` | GET · —<br>PATCH · сессия<br>DELETE · сессия | Эскадрилья: карточка, правка, удаление |
| `/api/squadrons/[id]/branding` | POST/DELETE · сессия | Оформление эскадрильи: загрузка, сброс |
| `/api/squadrons/[id]/chat` | GET/POST · сессия | Чат эскадрильи (общий/офицерский) |
| `/api/squadrons/[id]/chat/[messageId]` | DELETE · сессия | Удалить сообщение (автор/офицер) |
| `/api/squadrons/[id]/members` | GET · —<br>POST · сессия<br>PATCH · сессия<br>DELETE · сессия | Состав эскадрильи |
| `/api/squadrons/[id]/projects` | GET · —<br>POST · сессия | Проекты эскадрильи |
| `/api/squadrons/[id]/ranks` | GET · —<br>POST · сессия<br>PATCH · сессия<br>DELETE · сессия | Звания и права |
| `/api/squadrons/[id]/voice` | GET/POST · сессия | Голосовые комнаты (WebRTC-сигналинг через Realtime) |
| `/api/squadrons/my` | GET · сессия | Мои эскадрильи |
| `/api/support/tickets` | GET/POST · сессия | Тикеты поддержки: мои (staff — все), создание |
| `/api/support/tickets/[id]` | GET/PATCH · сессия | Тикет: просмотр, смена статуса |
| `/api/support/tickets/[id]/messages` | POST · сессия | Ответ в тикет |
| `/api/support/unread` | GET · — (staff — число) | Счётчик открытых тикетов для staff (остальным — 0) |
| `/api/support/upload` | POST · сессия | Вложение к тикету |
| `/api/wiki/articles` | GET · — (с сессией — больше)<br>POST · сессия | Статьи вики: список, создание |
| `/api/wiki/articles/[slug]` | GET · — (с сессией — больше)<br>PATCH · сессия<br>DELETE · сессия | Статья: чтение, правка, удаление |
| `/api/wiki/articles/[slug]/revisions` | GET · — (с сессией — больше) | Ревизии статьи |
| `/api/wiki/categories` | GET · — (с сессией — больше) | Категории вики |
| `/api/wiki/categories/[slug]` | GET · — (с сессией — больше) | Категория |
| `/api/wiki/favorites` | GET/POST · сессия | Избранные статьи |
| `/api/wiki/favorites/[id]` | DELETE · сессия | Убрать из избранного |
| `/api/wiki/search` | GET · — (с сессией — больше) | Поиск по вики |
| `/api/wiki/tags` | GET · — (с сессией — больше)<br>POST · сессия | Теги вики |
| `/api/wiki/tags/[slug]` | GET · — (с сессией — больше) | Тег |

### 5.6 Вход и аккаунт

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/account/avatar` | POST/DELETE · сессия | Смена аватара: Storage, при 503 — запасное хранение в БД (`profile_avatars`); DELETE — сброс |
| `/api/auth/callback` | GET · OAuth | Колбэк OAuth Supabase (Discord и др.) |
| `/api/auth/desktop` | GET · —<br>POST · — (учётные данные) | Вход Colonial Helper по почте/паролю или refresh-токену (лимит попыток) |
| `/api/auth/email/request` | POST · — | Письмо подтверждения / восстановления пароля |
| `/api/auth/email/verify` | POST · — (ссылка из письма) | Подтверждение ссылки из письма (TokenHash, POST-согласие) |
| `/api/auth/ensure-profile` | POST · сессия | Создать строку `profiles` для вошедшего пользователя |
| `/api/auth/password` | GET/POST · грант восстановления | Новый пароль по гранту восстановления (10 минут) |
| `/api/auth/providers` | GET · — | Какие способы входа включены (без секретов) |
| `/api/auth/register` | POST · — | Регистрация по почте (требует SMTP и подтверждения) |
| `/api/auth/token` | POST · токен | Проверка API-токена Helper'а (лимит попыток) |
| `/api/auth/tokens` | GET/POST/DELETE · сессия | API-токены пилота `rc_…`: список, выпуск, отзыв |
| `/api/auth/vk` | GET/DELETE · сессия | Привязка VK ID: статус, отвязка |
| `/api/auth/vk/callback` | GET · OAuth | Колбэк VK ID (PKCE) |
| `/api/auth/yandex` | GET/DELETE · сессия | Привязка Яндекс ID: статус, отвязка |
| `/api/auth/yandex/callback` | GET · OAuth | Колбэк Яндекс ID (PKCE) |

### 5.7 Магазин и платежи

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/billing/checkout` | POST · сессия | Платёжное намерение для оплаты деньгами → страница провайдера |
| `/api/billing/cosmetics` | GET/POST · — | Надетая косметика пилотов для отрисовки (по `ids`) |
| `/api/billing/intent/[id]` | GET · сессия | Статус своего платёжного намерения (страница возврата) |
| `/api/billing/my-transactions` | GET · сессия | Мои транзакции |
| `/api/billing/plans` | GET · — | Тарифы подписки |
| `/api/billing/providers` | GET · — | Включённые платёжные провайдеры |
| `/api/billing/subscribe` | POST · сессия | Купить подписку за кредиты |
| `/api/billing/webhooks/[provider]` | GET · —<br>POST · подпись провайдера | Вебхук провайдера: проверка подписи драйвером, идемпотентное исполнение |
| `/api/shop/equip` | POST · сессия | Надеть/снять косметику |
| `/api/shop/items` | GET · — (с сессией — больше) | Товары магазина (с отметкой купленного для вошедшего) |
| `/api/shop/purchase` | POST · сессия | Покупка за кредиты |
| `/api/shop/topup` | POST · — | Устарело: 410 — пополнение только через `/api/billing/checkout` |
| `/api/shop/user-state` | GET · — (с сессией — больше) | Баланс, инвентарь и надетое (для гостя — пусто) |

### 5.8 Верфь

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/outfitting/builds` | GET/POST/DELETE · сессия | Сохранённые сборки верфи в профиле |
| `/api/outfitting/catalog` | GET · — | Справочник верфи: `public/data/outfitting.json` + правки админки (`no-store`) |

### 5.9 Обновления Colonial Helper

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/uploader/blob/[hash]` | GET · — | Файл пакета Helper по sha256 (вечный кэш) |
| `/api/uploader/bundle/[file]` | GET · — | Полный пакет версии архивом («Восстановить») |
| `/api/uploader/download` | GET · — | Постоянная ссылка на скачивание Colonial Helper |
| `/api/uploader/launcher` | GET · — | Базовая сборка `ColonialHelper.exe` |
| `/api/uploader/launcher/[platform]` | GET · — | Базовая сборка для платформы (`win64`) |
| `/api/uploader/manifest` | GET · — | Подписанный манифест канала (`?channel=stable`) |

### 5.10 Админка и мобильная админка

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/admin/auth-providers` | GET/PATCH · admin | Кнопки входа (Discord, Google, GitHub, VK, Яндекс): что показывать на сайте |
| `/api/admin/backup` | GET/POST/DELETE · admin | Ручная копия БД через update-agent: статус, запуск, отмена |
| `/api/admin/billing/credits` | POST · admin | Ручное начисление/списание кредитов |
| `/api/admin/billing/export` | GET · staff | Выгрузка транзакций (CSV) |
| `/api/admin/billing/intents` | GET · staff<br>POST · admin | Платёжные намерения; POST — ручное подтверждение/отмена |
| `/api/admin/billing/items` | GET · staff<br>POST · admin<br>PATCH · admin<br>DELETE · admin | Товары магазина: CRUD |
| `/api/admin/billing/plans` | GET · staff<br>POST · admin<br>PATCH · admin<br>DELETE · admin | Тарифы подписки: CRUD |
| `/api/admin/billing/profiles` | GET · staff | Поиск пилотов для операций биллинга |
| `/api/admin/billing/providers` | GET · staff<br>POST · admin<br>PATCH · admin | Платёжные провайдеры (Т-Банк и др.): включение, тестовый режим, настройки |
| `/api/admin/billing/refund` | POST · admin | Возврат по транзакции |
| `/api/admin/billing/settings` | GET · staff<br>PATCH · admin | Настройки биллинга |
| `/api/admin/billing/stats` | GET · staff | Статистика биллинга и счётчики проекта (`?period=7d|30d|90d|1y|all`) |
| `/api/admin/billing/subscriptions` | GET · staff<br>POST · admin<br>DELETE · admin | Подписки пилотов: список, выдача, отмена |
| `/api/admin/billing/transactions` | GET · staff | Журнал транзакций |
| `/api/admin/content` | GET/POST · admin | «Синхронизировать Galnet сейчас» и «Добить переводы» (`?action=sync|translate`) |
| `/api/admin/email-health` | GET · admin | Диагностика почты: SMTP GoTrue, `AUTH_EMAIL_ENABLED`, автоподтверждение |
| `/api/admin/env` | GET/POST/DELETE · admin | Ключи `.env.production` через update-agent: список в маске, правка, удаление |
| `/api/admin/env/apply` | POST · admin | Применить ключи: пересоздать сервисы (тот же слот, что обновление) |
| `/api/admin/factions` | GET/POST · admin | Фракции: сводка БД, архив, куски, прогресс и журнал; POST — `start`/`force`/`download`/`split`/`import`/`cancel`/`cleanup` |
| `/api/admin/factions/upload` | GET/POST/PUT · admin | Загрузка архива `systemsPopulated.json.gz` с компьютера: `start` → `PUT ?offset=` по 8 МиБ → `finish`/`cancel` |
| `/api/admin/galaxy` | GET/POST · admin | Каталог систем: статус импорта; POST — запуск/скачивание/шарды/облако точек |
| `/api/admin/monitor` | GET · admin | Снимок мониторинга: приложение, БД, диск, Docker, задачи, версия (через monitor-agent) |
| `/api/admin/monitor/update` | GET/POST/DELETE · admin | Обновление проекта через update-agent: статус, запуск (`confirm: true`), остановка |
| `/api/admin/outfitting` | GET/POST · admin | Админка верфи: справочник с правками и журналом; POST — пакет CRUD/архив/сброс |
| `/api/admin/powerplay` | GET/POST · admin | PowerPlay: статус и журнал загрузки, архив и куски на сервере, путь записи, слушатель EDDN; POST — `start`/`force`/`download`/`split`/`import` (+ `segments` 1–16) /`cancel`/`cleanup`/`eddn-start`/`eddn-stop` |
| `/api/admin/powerplay/upload` | GET/POST/PUT · admin | Загрузка архива `powerPlay.json.gz` с компьютера: `start` → `PUT ?offset=` по 8 МиБ → `finish`/`cancel` (общий механизм с фракциями) |
| `/api/admin/smtp` | GET/POST/DELETE · admin | Настройки SMTP для GoTrue (через update-agent) |
| `/api/admin/smtp/apply` | POST · admin | Применить SMTP: пересоздать `auth` Supabase и `web` |
| `/api/admin/uploader/build-kit` | GET · admin | Комплект для первой Windows-сборки Helper (ключи встроены в `bundle.py`) |
| `/api/admin/uploader/config` | GET/POST · admin | Канал обновлений Helper: ключи подписи, токен публикации |
| `/api/admin/uploader/publish` | POST · токен публикации | Публикация пакета кода скриптом `uploader/build_bundle.py --publish` |
| `/api/admin/uploader/release` | GET/POST/DELETE · admin | Собрать и выпустить версию из папки `uploader`, загрузить базовый EXE, откат |
| `/api/admin/uploader/versions` | GET/POST/DELETE · admin | Версии канала: список, переключение, переподпись, удаление |
| `/api/mobile/admin-summary` | GET · admin | Агрегатор для `/m-admin` и Android: счётчики, мониторинг, биллинг, списки (`?period=30d`) |
| `/api/mobile/auth` | GET · Bearer JWT<br>POST · — (учётные данные admin) | Android: GET — проверка сессии и роли, POST — вход по почте/паролю (только admin) |
| `/api/translate` | POST · staff | Ручной перевод строк из админки (Yandex) |

### 5.11 Фоновые задачи

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/cron/capi-sync` | GET/POST · cron | Задача `capi-sync` |
| `/api/cron/cg-check` | GET/POST · cron | Задача `cg-check` |
| `/api/cron/colonisation-cleanup` | GET/POST · cron | Задача `colonisation-cleanup` |
| `/api/cron/eddn-cleanup` | GET/POST · cron | Задача `eddn-cleanup` |
| `/api/cron/eddn-listener` | GET/POST · cron | Задача `eddn-listener`: слушатель EDDN в веб-процессе — по флагу из админки |
| `/api/cron/factions-sync` | GET/POST · cron | Задача `factions-sync` (запускает импорт в фоне и сразу отвечает) |
| `/api/cron/galaxy-import` | GET/POST · cron | Задача `galaxy-import` |
| `/api/cron/powerplay-sync` | GET/POST · cron | Задача `powerplay-sync` |
| `/api/cron/translate` | GET/POST · cron | Задача `translate` |
| `/api/cron/update-progress` | GET/POST · cron | Задача `update-progress` |

### 5.12 Служебное

| Маршрут | Методы · доступ | Назначение |
|---|---|---|
| `/api/health` | GET · — | Проверка живости для healthcheck Docker |
| `/api/maintenance` | GET · — | Признак технических работ (`app_flags`) |
| `/api/status` | GET · — | Публичный статус для шапки: System Online / System Update (стадия + процент) |

### 5.13 Ship builder and engineers (client-side pages)

Расчёты обеих страниц работают на клиенте; общий справочник загружается через публичный API с административными правками:

| Страница | Что делает | Данные |
|----------|------------|--------|
| `/outfitting` | Конструктор сборок кораблей (аналог coriolis.io): слоты, модули, переборки, инженерия, вкладки сводка/атака/защита/графики, переключатель показа строк слотов (только названия / масса / энергия / характеристики / цена), управление кораблём (форсаж, пипки, груз, топливо), подсказки по модулям (без прокрутки, при нехватке высоты — в колонки), та же подсказка на строках списка в окне выбора, полная таблица параметров у выбранного модуля, копирование модуля между совместимыми ячейками, обмен сборками с Coriolis/EDSY (SLEF), снаряжение за Merc Coin, ссылка `?b=<код>`, сохранения в `localStorage` и в профиле (`/api/outfitting/builds`, `outfitting_builds`) | `GET /api/outfitting/catalog`: `public/data/outfitting.json` + Supabase-правки, `no-store`, клиентский кеш 30 секунд |
| `/engineers` | Дерево разблокировки инженеров, `?engineer=<id или имя>` | `lib/engineers/data.ts` + тот же API справочника для списка чертежей |
| `/admin?tab=outfitting` | CRUD модулей, групп и брони, заводская настройка, JSON, архив, сброс, массовое удаление, экспорт, журнал | `GET/POST /api/admin/outfitting`, `public.outfitting_catalog`, только admin; [OUTFITTING-ADMIN.md](OUTFITTING-ADMIN.md) |

Справочник пересобирается из открытого набора EDCD:

```bash
git clone --depth 1 https://github.com/EDCD/coriolis-data.git /tmp/coriolis-data
node scripts/build-outfitting-data.mjs /tmp/coriolis-data   # → public/data/outfitting.json
```

Формулы (`lib/outfitting/calc.ts`) повторяют игровые: кривая множителя по массе
для двигателей и генераторов щита, формула прыжка
`(optmass / масса) * (топливо / fuelmul)^(1/fuelpower)`, модификации
`multiplicative` / `additive` / `overwrite` с ползунком качества прогона.
Экспериментальные эффекты применяются наравне с чертежами: числовые
модификаторы лежат в `scripts/data/experimental-effects.json` и сверены с EDSY.

Боевая аналитика вынесена в `lib/outfitting/analysis.ts` — чистые функции без
React и без строк интерфейса, повторяющие модель coriolis.io:

* `rof = burst / (((burst - 1) / burstrof) + fireint)`, `dps = damage * roundspershot * rof`,
  `sdps = clip * damagePerShot / (clip / rof + reload)`, `eps`/`hps` из `distdraw`/`thermload`;
  урон раскладывается по `damagedist` (`A/K/T/E`);
* бустеры щита перемножаются, затем демпфируются `mul < 0.7 → 0.7 - (0.7 - mul) / 2`,
  сверху накладывается `sysDamageResistance(pips.sys)`; «эффективный запас» —
  среднее по кинетике, термике и взрыву, как в coriolis;
* кривые для графиков (`cargoCurve`, `fuelCurve`, `engPipCurve`, `sysPipCurve`,
  `costBreakdown`, `powerBreakdown`) считаются там же, а рисует их свой SVG
  (`components/Outfitting/Charts.tsx`), без графических библиотек.

Обмен сборками — `lib/outfitting/exchange.ts` поверх `lib/outfitting/fdnames.ts`
(в справочнике нет поля `symbol`, поэтому имена Frontier собираются и
разбираются по правилам именования). Наружу отдаются ссылка Coriolis
(`<версия><переборка><id слотов>`, по 2 символа на слот) и SLEF — формат, который
читают EDSY, Inara и Coriolis; внутрь принимаются ссылки Coriolis, свои ссылки
`?b=`, SLEF и сырое событие `Loadout` из журнала. Чего не хватает в данных
(номера чертежей Coriolis, ссылки EDSY собственного формата) — честно
помечается предупреждением в окне обмена.

Снаряжение за Merc Coin (обновление 4.4.0.0) описано в
`lib/outfitting/merccoin.ts`: 15 позиций, цены по данным сообщества, у части
модулей цена неизвестна — так и подписано.

Тесты — `scripts/tests/outfitting.test.mjs` (справочник и формулы),
`outfitting-analysis.test.mjs` (боевая аналитика, обмен, Merc Coin),
`outfitting-i18n.test.mjs` (семь языков) и `outfitting-ui.test.mjs`
(вкладки, фильтр отображения, подсказка, копирование, управление кораблём,
окно обмена, полнота параметров в списке модулей — в jsdom).

---

## 6. Components

### 6.1 Layout Components
| Component | File | Type | Description |
|-----------|------|------|-------------|
| RootLayout | `app/layout.tsx` | Server | Topbar, sidebar, footer wrapper |
| Sidebar | `components/Sidebar.tsx` | Client | Navigation sidebar (200px desktop, hidden on mobile) |
| Topbar | `app/layout.tsx` | Server | Brand, status (System Online/Update), clock, notifications, user menu |
| Footer | `components/Footer.tsx` | Server | Site footer |
| UserMenu | `components/UserMenu.tsx` | Client | Auth dropdown |
| NotificationBell | `components/NotificationBell.tsx` | Client | Notification dropdown + real-time |
| LanguageSwitcher | `components/LanguageSwitcher.tsx` | Client | Locale selector |
| MobileAdminLayout | `app/m-admin/layout.tsx` | Server | PWA metadata + viewport themeColor #1e2022 + manifest-mobile.json |
| MobileAdminPage | `app/m-admin/page.tsx` | Client | **Mobile admin PWA**: 9 tabs (dashboard/monitor/billing/systems/content/users/support/backup/auth), HUD cards, StatusPill, StatCard, bottom nav 64px, auto-refresh 20s, uses authFetch + supabase |
| Android MainActivity | `android-app/.../MainActivity.kt` | Android | Scaffold + TopBar + BottomNav (9 HUD icons) + Auth (TokenManager) + 20s polling + NavHost |

### 6.2 Feature Components
| Component | File | Type | Description |
|-----------|------|------|-------------|
| SquadronChat | `components/SquadronChat.tsx` | Client | Dual-channel chat with @mentions |
| DirectChat | `components/DirectChat.tsx` | Client | P2P messaging |
| GalaxyMap | `components/GalaxyMap/GalaxyMap.tsx` | Client | 3D interactive map |
| ProjectCard | `components/Projects/ProjectCard.tsx` | Server | Project list card |
| ProjectRoutePlanner | `components/Projects/ProjectRoutePlanner.tsx` | Client | Route planning UI |
| ProjectSystemPanel | `components/Projects/ProjectSystemPanel.tsx` | Client | System management |
| ForumReplyBox | `components/Forum/ForumReplyBox.tsx` | Client | Markdown reply editor |
| ForumReactions | `components/Forum/ForumReactions.tsx` | Client | Post reactions |
| ForumSearch | `components/Forum/ForumSearch.tsx` | Client | Forum search |
| ForumAdmin | `components/Forum/ForumAdmin.tsx` | Client | Forum moderation |
| WikiArticleContent | `components/Wiki/WikiArticleContent.tsx` | Server | Wiki article renderer |
| WikiSearchBox | `components/Wiki/WikiSearchBox.tsx` | Client | Wiki search |
| WikiSidebar | `components/Wiki/WikiSidebar.tsx` | Server | Wiki navigation |
| AtlasSearchPanel | `components/Atlas/AtlasSearchPanel.tsx` | Client | Atlas search |
| AtlasFavorites | `components/Atlas/AtlasFavorites.tsx` | Client | Atlas favorites |
| AtlasRouteFinder | `components/Atlas/AtlasRouteFinder.tsx` | Client | Route finder; publishes corridor/beam/results to the shared search-progress channel |
| AtlasRingRouteFinder | `components/Atlas/AtlasRingRouteFinder.tsx` | Client | Galactic ring: step loop, resume after a broken connection, refine, CSV |
| SearchProgressLayer | `components/GalaxyMap/SearchProgressLayer.tsx` | Client | 3D layer of any Atlas search: ring, corridor, cube, path, points, scan beam |
| CarrierMarkers | `components/GalaxyMap/CarrierMarkers.tsx` | Client | 3D carrier layer: in-game style icon per system (constant screen size, count badge), jump trails, hover label |
| CarrierLayerControls | `components/GalaxyMap/CarrierLayerControls.tsx` | Client | Carrier layer panel on `/map` and `/atlas`: toggle, own/squadron/other and Drake/Javelin filters, "which systems" list |
| CarrierSystemCard | `components/GalaxyMap/CarrierSystemCard.tsx` | Client | HUD card of a system with carriers: owner (privacy-aware), squadron (site binding; an unbound Javelin shows its in-game squadron tag — the callsign), docking, services, jump |
| AtlasCandidateList | `components/Atlas/AtlasCandidateList.tsx` | Client | Candidate systems |
| CommentSection | `components/Comments/CommentSection.tsx` | Client | Comments |
| FriendsPanel | `components/FriendsPanel.tsx` | Client | Friend list |
| Starfield | `components/Starfield.tsx` | Client | Canvas starfield background |
| Leaderboard | `components/Leaderboard.tsx` | Server | Leaderboard table |
| CmdrDossier | `components/CmdrDossier.tsx` | Server | Player profile — cargo totals, construction-site tonnage, achievements, squadron |
| SystemOrrery3D | `components/SystemMap/SystemOrrery3D.tsx` | Client | 3D orrery of one system: focus fly-to, clusters, layers, tooltips, orbit motion |
| SystemBodyRail | `components/SystemMap/SystemBodyRail.tsx` | Client | Body list rail of the system map: search, filters, grouping by star |
| AdminComments | `app/admin/components/AdminComments.tsx` | Client | Admin moderation |
| RavenSyncTab | `components/Admin/RavenSyncTab.tsx` | Client | Raven sync UI |
| SiteStatusBar | `components/SiteStatusBar.tsx` | Client | Topbar «System Online» ↔ «System Update» (clock, percent) from `/api/status` |
| SquadronVoiceChat | `components/SquadronVoiceChat.tsx` | Client | Squadron voice rooms: WebRTC peers, signalling through Realtime (`squadron_voice_signals`) |
| AtlasMarketSearch | `components/Atlas/AtlasMarketSearch.tsx` | Client | Atlas «Рынок»: market job (start/step/status), construction site materials |
| AtlasNearbySearch | `components/Atlas/AtlasNearbySearch.tsx` | Client | Atlas «Поблизости»: sphere/cube 1–50 ly |
| AtlasPowerplayPanel | `components/Atlas/AtlasPowerplayPanel.tsx` | Client | Atlas «PowerPlay»: status card, power/state filters, list, CSV, «Чья зона?» (`usePowerplayLayer`) |
| AtlasFactionsPanel | `components/Atlas/AtlasFactionsPanel.tsx` | Client | Atlas «Фракции»: allegiance filter, faction search, up to 12 selected factions (`useFactionsLayer`) |
| PowerplayPoints / FactionPoints | `components/GalaxyMap/PowerplayPoints.tsx`, `FactionPoints.tsx` | Client | Shader point clouds of the two layers; picking through `MapClickLayer` |
| PowerplaySystemCard / FactionSystemCard | `components/GalaxyMap/PowerplaySystemCard.tsx`, `FactionSystemCard.tsx` | Client | System cards of the layers (influence zones / all factions with influence) |
| CarrierPanel / CarrierCard | `components/Carriers/` | Client | Carrier tab of the profile and the squadron page: services, location, cargo (owner/officers), manual binding |
| ArchitectWorkspace | `components/Architect/ArchitectWorkspace.tsx` | Client | Architect planner: body cards, table and analytics views, side panels (share, progress, sourcing, governance, data quality, Raven, system projects) |
| Architect projects | `components/Architect/projects/` | Client | «Проекты систем»: list, project page, members, systems, carriers, progress, leaders |
| OutfittingWorkspace | `components/Outfitting/OutfittingWorkspace.tsx` | Client | Ship builder (see 5.13) |
| EngineerTree | `components/Engineers/EngineerTree.tsx` | Client | Engineer unlock tree |

### 6.3 Admin tabs
`/admin?tab=<id>` — navigation in `components/Admin/AdminNavigation.tsx`, page `app/admin/page.tsx`.

| Group | Tab id → component |
|---|---|
| Контент сайта | `content`, `news` (inline in the page) |
| Сообщество | `manage` (users, roles, delivery moderation), `forum` → `ForumAdmin`, `comments` → `AdminComments`, `support` → `SupportAdmin` |
| Игровые данные | `outfitting` → `OutfittingAdmin`, `hubs`, `route` (+ `RoutePagination`), `sync` → `RavenSyncTab`, `galaxy` → `GalaxyCatalogTab`, `powerplay` → `PowerplayAdminTab`, `factions` → `FactionsAdminTab` |
| Система и сервисы | `billing` → `BillingDashboard`, `monitor` → `ServerMonitorTab` (incl. update and env keys), `backup` → `BackupTab`, `auth` → `AuthProvidersTab` + `MailSettingsCard`, `helper` → `HelperUpdatesTab` |

Most game-data and system tabs render only for `role = admin`; billing also
opens for staff.

### 6.4 Icon Components
All 131 icons are in `src/components/Icons.tsx`. See DESIGN.md → «Icons» for the list by purpose.

---

## 7. State Management

### 7.1 Server State
- Fetched in Server Components via `supabaseServer.ts`
- Cached with `revalidate` (ISR) where appropriate; many API answers are `no-store`
- No client-side caching library (layers keep small in-memory/`localStorage` caches, e.g. Atlas filters)

### 7.2 Client State
- React `useState` / `useReducer` for local UI state
- Supabase Realtime for live data (chat, notifications)
- No global state manager (Redux, Zustand, Jotai)

### 7.3 URL State
- `useSearchParams` for filters, tabs, pagination (`/atlas?tab=…`, `/admin?tab=…`, `/outfitting?b=…`)
- `usePathname` for active navigation

---

## 8. External Integrations

### 8.1 EDSM (Elite Dangerous Star Map)
- Proxy API: `/api/edsm/system`, `/api/edsm/batch`, `/api/edsm/search`
- Used for: system coordinates (first step of `src/lib/systemCoordinates.ts`),
  body data (Architect body sync), station and market info (Atlas «Рынок»)
- Nightly dumps (`https://www.edsm.net/dump/`): `powerPlay.json.gz` → PowerPlay
  layer (8.16), `systemsPopulated.json.gz` → minor factions (8.17). EDSM sits
  behind Cloudflare; from Russian networks long TCP sessions can be frozen by
  the ISP — see FACTIONS.md for the stall/short-request downloader.

### 8.2 EDDN (Elite Dangerous Data Network)
- **Live listener (web 2.23.0, opt-in from Admin → «Игровые данные» →
  «PowerPlay»):** `src/lib/eddn/listener.ts` runs inside `web`, subscribes to
  `tcp://eddn.edcd.io:9500` through a dependency-free ZMTP 3.0 client
  (`src/lib/eddn/zmtp.ts`), keeps FSDJump / Location / CarrierJump of the live
  game (`gameversion` 4.x / CAPI-Live; Legacy 3.8 has PowerPlay 1.0 fields) and
  every minute feeds them to `applySystemObservations` with source `eddn` —
  PowerPlay owner (`ControllingPower`) + state and minor factions. A silence
  watchdog (30 s) reopens the session (ISP «freeze» protection + diagnostics in
  the log), errors back off up to 5 min. Flag and state — `eddn_listener_state`;
  job `eddn-listener` (5 min, default-enabled, no-op when off), the admin page
  and the PowerPlay layer (≤ 1 check / 5 min) restart it after a redeploy.
  `EDDN_LISTENER=off` forbids it; `EDDN_RELAY`, `EDDN_STALL_MS`, `EDDN_FLUSH_MS`.
  ~2–5 GB/day of traffic.
- Older market subscriber (optional, not part of the default Compose stack — the
  `eddn-worker` service in `docker-compose.yml` is a commented-out example):
  `scripts/eddn-worker.ts` (ZeroMQ) → `POST /api/eddn/ingest` with
  `x-eddn-secret` (`EDDN_INGEST_SECRET`, `EDDN_INGEST_URL`); the older
  `scripts/eddn_listener.py` writes to Supabase directly
- Stores `eddn_messages`, `market_prices` (pruned after 7 days by the
  `eddn-cleanup` job) and complete station snapshots (`station_commerce`, 8.20)
- Colonial Helper can also *publish* exploration events (Docked, FSDJump, Scan,
  Location, SAASignalsFound, CarrierJump; schema `journal/1`) to EDDN — off by
  default (`eddn_enabled`), `uploader/eddn_api.py`; Spansh takes its data from
  EDDN, colonisation events have no EDDN schema

### 8.3 Discord
- OAuth login through Supabase Auth (GoTrue PKCE → `/api/auth/callback`);
  provider credentials live in the Supabase auth stack, not in the site env
  (`deploy/selfhost/supabase-auth.override.yml`); buttons — Admin → «Авторизация»
- Webhook: `POST /api/discord/webhook` (admin/moderator), `DISCORD_WEBHOOK_URL`

### 8.4 Spansh
- Route planning API client: `src/lib/spanshClient.ts`
- Used for: Neutron highway routes
- Full catalog: `galaxy_systems`. Two importers share one parser and one SQL
  (`src/lib/galaxySpanshStream.ts`, `src/lib/galaxyImport.ts`): the in-app job
  (`src/lib/galaxyImportJob.ts` → `/api/admin/galaxy`, `/api/cron/galaxy-import`,
  admin tab «Каталог систем») and the CLI `scripts/import-spansh-systems.mjs`.
  The in-app one exists because the standalone image has no `scripts/`. It runs
  in two phases: (1) download the dump to disk — `GALAXY_ARCHIVE_DIR` (default
  `data/spansh`; in compose a bind mount of a separate disk,
  `GALAXY_DATA_HOST_DIR` → `/app/data/spansh`), in several parallel HTTP Range
  connections (`GALAXY_DOWNLOAD_SEGMENTS`, per-segment progress in
  `<file>.parts.json`), with retry/backoff on dropped connections (undici's
  `terminated`), CRC-verified, state in `galaxy_systems_meta` (key `archive`),
  downloadable on demand via `{"action":"download"}`; (2) import from that
  local file (never over the network again), writing in batches (pg or
  PostgREST), resume point in `galaxy_systems_meta` (key `import`), point cloud
  uploaded to storage. The full 5.9 GiB file is downloaded ONCE: afterwards
  `planGalaxyImport()` (`src/lib/galaxyDumpVariants.ts`) picks the cheapest
  Spansh delta covering the gap since `stats.dump_generated_at`
  (`systems_1day` ~4 MiB … `systems_6months` ~617 MiB).
  `GALAXY_IMPORT_MODE=shards` unpacks the archive once into gzipped TSV shards
  (`src/lib/galaxyShards.ts`) so a resumed import costs O(1) instead of
  re-parsing 2×10⁸ JSON objects. Disk housekeeping lives in
  `src/lib/galaxyArchiveStore.ts`: previous archives and stale shards are
  deleted before a new download, the archive itself after a successful import
  (`GALAXY_ARCHIVE_KEEP=1`, `GALAXY_SHARDS_KEEP=1` opt out), and a download
  that cannot fit is refused up front (`GALAXY_DISK_CHECK=0` disables).
  `GALAXY_IMPORT_FILE` pins a hand-placed dump (nothing is downloaded),
  `GALAXY_IMPORT_URL`/`GALAXY_DUMP_BASE_URL` point the download at a mirror.
  See SPANSH-IMPORT.md.
  Atlas star candidates and the route finder prefer this table.
  `/system/[name]` falls back to the catalog when there is no construction row.
  The map layer «Все системы» reads `edgs-v1` from `public/data`, storage bucket
  `galaxy-data`, Postgres or paged PostgREST, and asks `/api/galaxy/stats` first
  so an empty catalog is a message, not a 404; it does not raycast the cloud.
  Migration `20260924000000_galaxy_systems_finish.sql`.
  Atlas searchers write everything they find back into the project DB
  (`atlas_system_cache`, `atlas_body_cache`, ring sessions) — repeat searches in
  the same area never touch EDSM/Spansh again. Search progress is shared with the
  3D map through `src/lib/atlasSearchProgress.ts`
  (`useAtlasSearchProgress`). Migration `20261011000000_atlas_search_caches.sql`,
  details in ATLAS-SEARCH-REWORK.md.

### 8.5 Raven Colonial
- Progress of hubs and route systems: job `update-progress` (every 30 min,
  `scripts/lib/progress-sync.mjs` → `system_progress`), manual
  `POST /api/ravencolonial/sync` (admin/moderator), `/sync/single`, log
  `/sync/log`, proxy `/api/ravencolonial/[name]`
- Architect: per-pilot RCC key (`raven_keys`, `/api/architect/raven-key`),
  creating a Raven project from a plan (`/api/architect/raven-project`),
  progress of «Проекты систем» (8.19)
- Colonial Helper: project cycle in the «Колонизатор» tab and fleet carrier
  cargo — since 2.14.0 only live deltas for carriers Raven knows, corrected by
  set-values from the carrier market (8.18, FLEET-CARRIERS.md)

### 8.6 Colonial Helper (uploader) 2.17.0
- Source: `uploader/colonial_helper.py` (`VERSION = "2.17.0"`), launcher
  `uploader/launcher.py` (`LAUNCHER_VERSION = "1.0.0"`), parser
  `uploader/journal_parser.py` (`PARSER_VERSION = 5`). Release notes —
  `uploader/CHANGES.md`, user docs — `uploader/README.md`, update channel —
  UPLOADER-UPDATE-STRUCTURE.md.
- Auth: personal API token `rc_…` (`/account?tab=tokens`), sent as
  `Authorization: Bearer rc_…` or in the body; checked by
  `src/lib/helperAuth.ts` (`resolveRequestUser`: session or token).
- Endpoints: `POST /api/logs/upload` (deliveries + construction snapshots),
  `POST /api/atlas/system-bodies` (body scans), `POST /api/cmdr/stats`,
  `POST /api/carriers/sync` + `GET /api/carriers/mine` (2.14.0),
  `POST /api/stations/report` (station commerce), `POST /api/factions/sync`
  (2.16.0; since 2.17.0 the same projection carries PowerPlay 2.0 fields —
  one system observation feeds factions and PowerPlay), `POST /api/journal/reset`,
  `GET/POST /api/capi/token`.
- Sends personal deliveries through `persistImportedDeliveries` into `deliveries`.
- Sends `ColonisationConstructionDepot` snapshots through the same endpoint
  into `colonisation_sites` (one row per site) and `construction_depot_snapshots`.
- Delivery semantics:
  - `ColonisationContribution` is a direct per-event construction delta (the
    Journal `Amount` is per event, not cumulative — subtracting the previous
    value dropped every delivery after the first);
  - Fleet Carrier `MarketSell` is FC cargo `+Count`;
  - Fleet Carrier `MarketBuy` is FC cargo `-Count` and is not a project delivery;
  - ordinary station sales are not construction deliveries.
- Every delivery carries why it exists, so the dossier can separate "all cargo
  transported" from "delivered to construction sites" without guessing:
  `source` (`colonisation_contribution` | `cargo_depot` | `cargo_delta` |
  `carrier_delivery` | `mission_delivery` | `powerplay_delivery` |
  `rescue_delivery`) and `is_construction`. A `cargo_delta` counts as a site
  delivery only while the commander is docked at a market that published a
  `ColonisationConstructionDepot`; `MarketSell` no longer suppresses the next
  `Cargo` snapshot. Historical rows keep `is_construction IS NULL` = site, so
  existing dossiers never shrink. `PARSER_VERSION = 5` forces a re-import of
  already-cached journals after the expanded body-scan payload.
- The website log importer (`/account` → `POST /api/logs/import`) parses with
  the same rules (`src/lib/journalParser.ts`) and, through the same pass, the
  same telemetry (`src/lib/journalTelemetry.ts`): construction snapshots,
  body scans and pilot stats. If the transport columns are not migrated yet,
  `deliveryImport.ts` retries the batch without them and remembers that the
  schema lags, so a journal upload never fails because of a pending migration.
- The uploader never sends raw Journal files to the website. It sends structured
  delivery/snapshot records and keeps local byte offsets in
  `.colonial_helper_journal_offsets.json`.
- Startup reconciliation processes unhandled bytes and shows byte/file progress
  in the desktop progress bar. Rotation is detected when file size decreases.
- `source_hash` and server upsert keys make retries idempotent (deliveries since
  `20260911010000_delivery_import_idempotency.sql`). Since #142 the browser
  parser and the Python parser produce **byte-identical** `source_hash` values
  for the same journal line (isomorphic SHA-256, prefix `journal-v2-`, the
  same commodity normalisation), so one journal uploaded through the site and
  through Helper does not duplicate deliveries. Any parser change must keep
  that parity (8.21).
- Scan batches sent by Colonial Helper use the same API token as deliveries and
  include `cmdr`, body physics, atmosphere/composition, rings, signals and
  `semi_major_axis_ls`; the server rejects more than 500 bodies and the helper
  requeues a failed batch.
- EDSM and Inara are independent external integrations and do not use the ED
  Ring Colony token.
- EDSM requires `fromSoftware`, `fromSoftwareVersion`, `fromGameVersion` and
  `fromGameBuild`, and reports per-event status in the JSON body (`msgnum`,
  100-104 accepted, >= 200 rejected) even when HTTP is 200.
- Inara endpoint is `https://inara.cz/inapi/v1/` with Inara event names
  (`addCommanderTravelFSDJump`, `setCommanderTravelLocation`,
  `addCommanderInventoryCargoItem`, ...) and Inara-style property names
  (`starsystemName`, `stationName`, `marketID`); per-event status arrives in
  `events[].eventStatus`.
- Fleet carrier cargo: since 2.14.0 the site keeps the books (8.18) and the
  CARRIER block reads `GET /api/carriers/mine`; Raven Colonial receives only
  **live** `MarketSell`/`MarketBuy`/`CargoTransfer` deltas for carriers Raven
  knows, and set-values (`POST /api/fc/{id}/cargo`) from the carrier market
  snapshot or an empty hold. The carrier is detected by MarketID in
  3 700 000 000-3 800 000 000, by `CarrierID`, or by station type (a squadron
  Javelin — by the `squadronBank` service / `CarrierType`); commodity names are
  normalised to lower-case FDNames.
- API credentials are also mirrored to the local runtime-only file
  `.colonial_helper_credentials.json` in the user's home directory. This
  protects them from HUD settings saves and EXE upgrades; no credentials belong
  in source control.
- Third-party APIs (EDSM, Inara, Raven Colonial FC cargo) are dispatched from a
  background queue in `uploader/event_dispatch.py`: one bounded queue with a
  small worker pool, so journal parsing never waits on the network.
- Game detection lives in `uploader/game_monitor.py`: it finds the game process
  (`EliteDangerous64.exe` and legacy names), its window rectangle and the work
  area of the monitor the game runs on. The UI header, the STATUS overlay and
  the HUD auto-hide all read this single cached state (1 s TTL); outside
  Windows it reports `unsupported platform` instead of a false negative.
- HUD layout in `uploader/overlay.py`: blocks snap to edges/corners of a layout
  area (screen, or the monitor with the game window when "attach to game" is
  on) via `compute_anchored_position()`, with a configurable margin and
  clamping. Named layout profiles (positions, sizes, visibility, alpha, font,
  per-block behaviour, hotkeys) are stored in `config.json` under `profiles`.
- HUD block management (since 2.3.0): each of the eight blocks (`route`,
  `status`, `ship`, `cargo`, `session`, `events`, `exobio`, `carrier`; one
  strict visual system since 2.13.2) has its own visibility,
  position lock (since 2.15.0 a locked block is always click-through, Ctrl+F12
  locks/unlocks all:
  `WS_EX_TRANSPARENT` via ctypes, applied on `<Map>` to the real top-level
  HWND), detach from the game / move to another monitor (`screens.py`), alpha, font
  size, size preset (XS/S/M/L/XL), auto-show rule and hotkey. Everything is
  pushed into the **live** windows (`apply_block_style()`), so changing the
  font, alpha or profile never recreates the overlay. Behaviour rules
  (`auto_rule_matches()`) and the idle timeout decide visibility together with
  the user's checkboxes in `evaluate_block_visibility()`.
- Global hotkeys live in `uploader/hotkeys.py`: `RegisterHotKey` in a dedicated
  message-loop thread (Tk bindings only fire while the app window is focused,
  which is useless in game). Callbacks are marshalled back through
  `master.after(0, ...)`; outside Windows the manager stays inert.
- Exobiology lives in `uploader/exobiology.py`: journal-only tracking (Scan,
  SAAScanComplete, FSSBodySignals, ScanOrganic, CodexEntry) plus a genus
  prediction model (`GENUS_RULES`) written from public in-game occurrence rules
  (atmosphere category and gas list, planet class, volcanism, gravity cap,
  temperature window) — nothing was copied from SrvSurvey (GPL-3.0), which this
  repo may not link against; the overlay states the model is an estimate.
  - Hard exclusions (a genus cannot appear): atmosphere category, missing
    required gas, wrong planet class, `geology: "require"` while volcanism is
    known to be absent. Soft penalties (they lower the percentage only):
    gravity caps and temperature windows. Unknown atmosphere ⇒ no prediction.
  - `species_candidates()` adds per-species windows inside a genus; candidates
    below `MIN_PREDICTION_PERCENT = 25` are not shown at all.
  - `GENUS_ALIASES`/`normalize_genus` reconcile short Journal genus names with
    reference names (`Shards` → `Crystalline Shards`, `Tubers` →
    `Sinuous Tubers`, `Concha` → `Conchas`) — this also fixed zero-valued
    `estimate_value()` payouts, and `GENUS_VALUE_CR` is calibrated against the
    published sample values (mapping bonus divided out).
  - Galactic-sector restrictions are known to exist in game but are
    intentionally not modelled as hard exclusions.
  - `ExobiologyOverlay` (HUD block `exobio`) renders samples, predictions,
    bodies and planets either as a list or, by default, as a monospace table
    (`overlay.format_table`, `exobio_layout` setting, automatic list fallback on
    non-monospace fonts).
- The "Колонизатор" tab drives the full Raven Colonial project cycle through
  `uploader/raven_colonial_api.py`: `GET /api/cmdr/{cmdr}/active`,
  `PUT /api/project` (create), `PATCH /api/project/{buildId}` (update),
  `POST /api/project/{buildId}/complete`, `PUT|DELETE /api/cmdr/{cmdr}/primary`,
  link/assign/ready. Write calls need the RCC key; every call runs in a worker
  thread and never raises.
- Journal history (initial reconciliation and manual file import) is parsed with
  `live=False` and is **not** forwarded to EDSM/Inara/Raven by default. Only
  live watcher ticks are. Users may opt in per UI toggle
  (`backfill_send_third_party` in the config).
- Journal files are parsed once per pass: `iter_journal_events()` +
  `parse_events(..., hooks=[...])` feed deliveries, construction snapshots, ship
  tracking and third-party dispatch from the same stream.
- Repeated `ColonisationConstructionDepot` snapshots with an unchanged state are
  dropped before upload (`ConstructionSnapshotCollector`). The collector lives
  for the whole watcher session (`_construction_collector`), and each tick sends
  only what `drain()` returns: a per-tick collector used to lose the signature
  set, so an unchanged state was uploaded again every 5 seconds.
- Every path that stores construction state (`/api/logs/import`,
  `/api/logs/upload`, `/api/journal/import`, `/api/capi/sync`,
  `/api/cron/capi-sync`) writes through `src/lib/colonisationEvents.ts` into
  `colonisation_sites` via the RPC `colonisation_sites_write` (migration
  `20261009010000_colonisation_sites.sql`): one row per site (key — MarketID
  as text), the newer journal timestamp wins, the resource list is compacted
  on the client and again on the server. Progress snapshots go to
  `construction_depot_snapshots` and are pruned by the `colonisation-cleanup`
  job (`COLONISATION_RETENTION_DAYS`). The old event table
  `colonisation_events` is legacy (see COLONISATION-SITES-REWORK.md and
  `supabase/maintenance/colonisation_sites_cutover.sql`).
- Site uploads are chunked and parallel: 100 deliveries per request / 100
  snapshots per request (server limit), up to 4 concurrent requests, with a
  progress callback. Startup reconciliation defers uploads and flushes them once
  at the end instead of per file.
- Uploaded-file cache `.colonial_helper_imported_files.json` stores
  `path -> {size, mtime, parser}` so repeated imports skip unchanged files. The
  parser version (`PARSER_VERSION` in `journal_parser.py`) invalidates the cache
  when extraction rules change.
- Architect progress reads Uploader snapshots and Raven Colonial in parallel:
  Raven supplies the aggregate multi-pilot progress, while the latest journal
  snapshot can provide exact resource totals. The UI marks the dual-source
  state explicitly and warns when no Uploader snapshot exists.
- Architect body data is compared across three sources (project DB, EDSM,
  Spansh dump by `id64`) in `src/lib/architect/bodySync.ts`; duplicates inside
  a single source are merged, and `/api/atlas/system-bodies?compare=1` reports
  per-source status in `sync` (`ok` / `empty` / `unavailable` / `skipped`).
- Body names coming from third-party services are resolved against the system
  catalogue (`src/lib/architect/bodyNames.ts`), so structures adopted from
  Raven Colonial land on the right body card instead of silently disappearing.

### 8.7 Pilot infographic tab
- The uploader has a `Пилот` tab with a **reworked infographic** (2.3.0): a KPI
  row (session tons, deliveries, cargo, systems) plus a responsive grid of six
  tiles — session dynamics with a Canvas sparkline, ship state bars, route,
  top systems by tonnage, status/connections, journals/economy.
- Layout is adaptive: column count is derived from window width (1-3, up to 4 in
  compact mode) and rebuilt on a debounced `<Configure>`; compact mode persists
  as `pilot_compact` in the config. Charts are drawn on plain `tk.Canvas`
  (no matplotlib), series are sampled every 2 s into deques of 180 points.
- It displays commander/connection state, current system and ship, route
  progress, hull/shields/fuel/power, modules, cargo, balance/rebuy/legal state,
  session delivery totals, visited systems, per-system tonnage and last journal
  event.
- Refresh runs on the Tk main loop every second (a single `after()` chain, so
  manual refreshes cannot spawn parallel timers) and never performs network
  requests. It is deliberately tolerant of incomplete state while the first
  Journal reconciliation is running.

### 8.8 Yandex Translate
- Общий клиент: `scripts/lib/translate.mjs` (ESM, используется и сайтом, и скриптами)
- Обёртка для Next.js: `src/lib/translate.ts`
- API: Yandex Cloud Translate v2, `POST /translate/v2/translate`
- Авторизация: `Authorization: Api-Key <YANDEX_TRANSLATE_API_KEY>`
  (альтернатива — IAM-токен через `Bearer`)
- Языки: ru, en, de, it, ko, zh, ja
- Cron endpoints: `/api/cron/translate`, `PATCH /api/galnet`
- Поведение: повторы при 429/5xx, нарезка длинных текстов (< 8000 символов
  на запрос), изоляция ошибок по языкам (статус `partial` вместо потери статьи)

### 8.9 Локализованный контент сайта (admin → сайт)
- Единый слой чтения: `src/lib/localizedContent.ts` — `safeContentLocale`
  (белый список ru, en, de, it, ko, zh, ja), `localizedValue` (колонка локали →
  базовая колонка → пусто) и `missingTranslationLangs`. Публичные `GET`
  (`/api/home-data`, `/api/galnet`, `/api/news`) выбирают `select('*')` и НИКОГДА
  не перечисляют `title_ru, body_de, …` руками: непроменённая миграция иначе
  роняет весь запрос, а обработчик молча отдаёт пустой список (именно так
  «правки в админке не применялись» и «на главной нет Galnet»).
- `site_content`: базовые колонки = русский, переводы = `<field>_<lang>`
  (`kicker_*`, `title1_*`, `title2_*`, `manifest_*`, `footer_copyright_*`,
  `footer_discord_*`, `footer_edsm_*`, `footer_inara_*` —
  миграция `20260926000000_site_content_footer_translations.sql`).
  Админка пишет и `<field>_<lang>`, и базовую колонку
  (`buildSiteContentPayload` в `src/lib/siteFooter.ts`): базовую читают старые
  пути и фоллбэки. Если колонок переводов в базе нет, upsert повторяется
  только базовыми полями, а ответ содержит
  `saved-without-translations: примените миграцию …` — правка не теряется.
- Ответ `/api/home-data` отдаёт `Cache-Control: no-store, max-age=0`, поэтому
  кровка/прокси не держат старую версию после сохранения.
- Перевод статей: `scripts/lib/galnet-sync.mjs::translateArticleRow`. Язык
  оригинала — из `source_lang` строки, иначе по таблице
  (`news` → `ru`, `galnet_news` → `en`); в API он не отправляется, оригинал
  кладётся в свою колонку как есть. Заполненные языки НЕ перезапрашиваются и
  не затираются: повторный запуск добивает только пустые блоки (`force` /
  «перезаписать» в админке — отдельный переключатель). `translation_status`
  честный: `completed` только когда закрыты все поля; частичный успех —
  `partial`, и такая строка остаётся в очереди (`RETRY_STATUSES =
  pending,failed,partial`). Ручные действия: `POST /api/admin/content?action=sync`
  и `?action=translate` (кнопки в Админка → Мониторинг).
- `src/lib/translate.ts::translateAndSaveArticle` (используется `POST /api/news`)
  обязан получать язык оригинала по таблице: новости пишутся по-русски.

### 8.10 Ручное обновление развёрнутой версии
- Привилегированный агент: `scripts/update-agent.mjs` (Node, HTTP на
  `UPDATE_AGENT_HOST:UPDATE_AGENT_PORT`, по умолчанию 127.0.0.1:8092, Bearer
  `UPDATE_AGENT_TOKEN`; вне loopback без токена не стартует). Контракт:
  `GET /health`, `GET /status[?full=1]`, `POST /update`, `POST /backup`,
  `POST /abort`. Обновление и резервная копия делят один процессный слот:
  состояние различается полем `kind` (`update` | `backup`).
- Фактическую работу делает `deploy/update-project.sh` (git fetch/merge,
  pg_dump, недостающие миграции по `migrations.mark`, пересборка
  Compose-профиля или standalone-выкладка, проверка живости). Отставание 0 от
  ветки не отменяет прогон: кнопка всегда донашивает миграции и пересобирает.
  Ручную копию базы делает `deploy/db-backup.sh`
  (`pg_dump -Fc` без `public.galaxy_systems`, проверка `pg_restore --list`,
  ротация `UPDATE_BACKUP_KEEP`); на время дампа сайт закрыт заглушкой
  «Ведутся технические работы» — признак лежит в `public.app_flags`,
  читает его прокси (`src/proxy.ts`), страница — `src/app/maintenance`. Прогресс — машиночитаемой строкой
  `::edrc::{"stage":…,"percent":…}` в stdout; формат и стадии описаны в
  `scripts/lib/update-state.mjs` (`UPDATE_STAGES`). Всё остальное в stdout —
  журнал, который показывается админу после сокрытия похожих на секрет значений.
- Состояние переживает рестарт сайта: `UPDATE_STATE_DIR/update-state.json` +
  `update.log`. У живого полного обновления нет wall-clock лимита;
  `UPDATE_TIMEOUT_MINUTES` устарела и игнорируется. Оставшийся без дочернего
  процесса «залипший» `running` снимается защитным шестичасовым порогом.
- Веб-слой: `src/lib/updateAgent.ts` → `GET/POST/DELETE
  /api/admin/monitor/update` (все три — под `requireAdmin`; `POST` требует
  `confirm: true`) и публичный `GET /api/status` (только `publicUpdateView`:
  стадия + процент, без путей, ревизий и журнала; серверный кэш 2 с).
- Шапка сайта: `src/components/SiteStatusBar.tsx` — «System Online» ↔ «System
  Update» с анимированными часиками, процентом и полосой под шапкой; видно всем
  посетителям, в т. ч. на мобильном.
- Включение: `deploy/start-update-agent.sh` (Docker-профиль `monitoring` с
  сервисом `update-agent` или хостовый unit `ed-ring-colony-update.service`).
  `deploy/start-monitoring.sh` остаётся ответственным за read-only
  `monitor-agent`; сокет Docker на запись есть только у апдейтера.

### 8.11 Frontier Galnet
- Источник: официальный Drupal JSON:API Frontier,
  `https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article`
  (`Accept: application/vnd.api+json` обязателен)
- Парсер: `scripts/lib/galnet-source.mjs`
- Оркестрация: `scripts/lib/galnet-sync.mjs` (лента → БД → перевод)
- CLI: `scripts/galnet-sync.mjs` (ручная диагностика); расписание — `scripts/server-jobs.mjs`
- Next.js endpoints: `GET/POST/PATCH /api/galnet`, `GET /api/galnet/[nid]`
- Stored in `galnet_news` table (колонки переводов — миграция
  `20260915000000_galnet_translations.sql`)
- Displayed on homepage and `/galnet`
- Расписание: задачи `galnet-sync` (раз в сутки, 06:20 UTC) и `translate`
  (раз в 6 часов, догон очереди) сервиса `jobs` (раздел 9)
- Дедупликация по `nid` (UUID Drupal) и `guid`; изменение текста Frontier
  помечает статью к повторному переводу
- ВАЖНО: поле `field_galnet_date` («11 SEP 3312») — внутриигровая дата,
  в колонку `published_at` (TIMESTAMPTZ) не попадает

### 8.12 Frontier CAPI (account binding → dossier)
- Flow: `/api/capi/auth` (PKCE, no FDEV Shared Key) → Frontier login →
  `/api/capi/callback`. The callback **saves `capi_tokens` first** and only then
  pulls data, so a CAPI outage degrades to `status=partial` instead of losing
  the binding. See [CAPI-BINDING-FIX.md](CAPI-BINDING-FIX.md) for the root-cause
  analysis of the earlier "OAuth succeeds but nothing is linked" behaviour.
- Modules in `src/lib/capi/`: `oauth.ts` (auth/token/decode, `audience`),
  `client.ts` (HTTP, `EDCD-EDRingColony-<version>` User-Agent, `204/206/418`
  handling), `profile.ts` (the only place the CAPI payload is mapped:
  `commander.credits`, `commander.debt`, `commander.rank.*`, `lastSystem.name`,
  `lastStarport.name` only while docked, `ship.shipName`), `journal.ts` (NDJSON),
  `persist.ts` (writes survive a database that misses a migration),
  `linkState.ts` (flow cookies, 30-minute TTL, HMAC-signed owner),
  `syncPilot.ts` (shared by callback, manual sync and cron), `messages.ts` (UI text).
- Storage: `capi_tokens` (binding + `platform`, `linked_at`, `last_error`),
  `capi_profiles` (cache), `pilot_stats` (dossier source of truth for
  `/api/cmdr/stats` and `/cmdr/[name]`), plus colonisation events and member
  location from the journal.
- Rate limit: roughly one CAPI request per minute per account; `/journal` is not
  realtime. Cron `/api/cron/capi-sync` processes a small batch per run.

### 8.13 Avatars and the account tabs
- Upload path: browser → `POST /api/account/avatar` → Supabase Storage, with a
  database fallback (`profile_avatars`) when Storage is down. A direct
  browser → Storage upload used to surface the gateway's raw `503`; see
  [ACCOUNT-AVATAR-SQUADRON-FIX.md](ACCOUNT-AVATAR-SQUADRON-FIX.md).
- `src/lib/avatarUrl.ts` rewrites storage objects left on the pre-migration
  host to the configured `NEXT_PUBLIC_SUPABASE_URL`; `src/components/Avatar.tsx`
  falls back to initials instead of a broken image.
- Account tabs are Profile and "Сообщения и друзья" (`/account/friends`);
  `/account/messages` redirects there.
- Squadron creation normalises the form in `src/lib/squadronForm.ts` (empty
  strings mean "not provided", `[rcv]` → `RCV`, a tag is derived from the name)
  and translates database failures into readable causes.

### 8.14 Frontier CAPI: platform (`audience`) and HTTP 400
- Frontier's `400` on `/profile` means "this account does not own the game"
  (body: `Please Visit the store to purchase Elite: Dangerous`), not a
  malformed request. It happens when the token was issued for the Frontier
  store account while the game was bought on Steam/Epic.
- Both the site and Colonial Helper now request `audience=frontier,steam,epic`
  by default (the EDMC list); an explicit platform is still available on
  `/account/capi` and in the uploader's "Где куплена игра" selector.
- `CapiError` kind `no_entitlement` carries the explanation; the uploader shows
  the same hint and only turns the status green after `/profile` answers.
- Details and the user-facing checklist: [CAPI-400-FIX.md](CAPI-400-FIX.md).

### 8.15 Fleet Carrier cargo in the Helper overlay: reconciliation with `CarrierStats`
> Since Helper 2.14.0 the itemized list comes first from the site
> (`GET /api/carriers/mine` every 90 s and right after a send, 8.18); the Raven
> snapshot is only a fallback. The reconciliation rules below still guard the
> overlay state.
- The CARRIER overlay block mixes two sources: the itemized list (Raven
  Colonial snapshot `GET /api/fc/{marketId}/cargo` plus journal deltas) and the
  authoritative tonnage `CarrierStats.SpaceUsage.Cargo`. Only the tonnage is
  trustworthy — other commanders take cargo and buy from the FC market without
  producing a single journal event for the owner.
- `CarrierState.reconcile()` (`uploader/carrier.py`) keeps the two consistent:
  `Cargo == 0` clears the list, an overstated list is trimmed back to the
  tonnage (excess is taken from positions we never hauled ourselves first,
  then proportionally), a list overstated by more than
  `RECONCILE_DROP_RATIO` (50%) is dropped entirely, and the leftover tonnage is
  exposed as `untracked` ("прочее N t").
- Freshness decides who wins: data newer than the tonnage by more than
  `RECONCILE_GRACE_SECONDS` (300 s) is never trimmed, so a `CarrierStats` read
  from an old journal during startup cannot erase today's cargo. Event age
  comes from the journal `timestamp` (`carrier.event_time`).
- Between `CarrierStats` events the tonnage is advanced by our own deltas
  (`stored_estimated: true`, shown as `≈` in the block).
- Raven snapshots are addressed (`merge_remote(..., market_id=...)`) and an
  empty snapshot only clears the list when confirmed (`Cargo == 0`, or Raven
  previously reported a non-empty list and no local delta happened since).
- State dict additions consumed by the overlay: `untracked`,
  `stored_estimated`, `reconciled` (`""|emptied|trimmed|dropped`),
  `cargo_source` (`remote|journal|estimate`), `stats_age` (minutes).

### 8.16 PowerPlay layer in Atlas (EDSM nightly dump)
Full description: **POWERPLAY.md**.
- **Owner of a system (web 2.23.0).** An EDSM dump record is «a system + ONE of
  the powers present» — one row per power from the journal's `Powers` (every
  power whose zone covers the system), all with the same state and date;
  `ControllingPower` is not stored (EDSM-NET/EDDN-Events `System/PowerPlay.php`),
  and the dump is sorted by EDSM power id. The old parser kept the last record,
  so contested systems went to the highest id (Nakato Kaine 13): 3144 vs 1819 in
  game, Aisling Duval (3) 1580 vs 3121. Now `powerplayDump.ts` groups a system's
  records (`power` only when one power is listed, `powers` = all), the table has
  `power_basis` — `journal` (ControllingPower), `sole`, `kept` (an earlier exact
  owner still listed), `unknown` (`power` NULL — not '' so the 20261020120000
  CHECK passes on replays). The layer tuple gains `basisIdx` and present-power
  indexes, owner index −1 = unknown (old clients skip it); the UI shows grey
  «Держава не определена» points, a filter row and «+N?» per power. An older
  journal (≤ 7 days before the dump observation) names an unknown owner that is
  among the listed powers (`resolved`). A run stored by the old parser
  (`stats.parser` ≠ 2) is re-read even if EDSM did not change the file.
- Atlas tab «PowerPlay» (7th, `?tab=powerplay`, Alt+7) + a 3D layer: every system
  controlled by a PowerPlay 2.0 power (Stronghold / Fortified / Exploited). Colour =
  power (`POWERPLAY_POWERS` in `src/lib/powerplay.ts`), shape = state. Filter by
  power and state, list with search, CSV, map card with influence zones, and
  «Чья зона?» for any system (Stronghold 30 ly, Fortified 20 ly).
- Source: EDSM `https://www.edsm.net/dump/powerPlay.json.gz` (~3.6 MB, daily,
  systems reported via EDDN in the last ~30 days). Unoccupied rows are dropped
  (EDSM lists the contenders there). Spansh has `controllingPower` only in the
  `galaxy*` dumps with bodies (1.2–4.3 GiB) — too big for the production link;
  its light `systems_*` dumps carry no PowerPlay. The live EDDN listener (8.2) is
  opt-in.
- Pilot journals (web 2.22.0, Helper 2.17.0): the system observation that
  updates factions (`POST /api/factions/sync`, browser loader, CAPI daily
  journal) also carries `ControllingPower` / `Powers` / `PowerplayState` /
  control progress / reinforcement / undermining. `src/lib/systemObservations.ts`
  splits it into both layers (`src/lib/powerplayJournal.ts` →
  `powerplay_apply_observations`): the fresher observation wins, a new system is
  added only if it is newer than the last dump, `Unoccupied` is stored as a
  marker row the layer hides (an older dump cannot bring the system back),
  pre-PP2 journals (< 2024-10-29) are rejected. The dump import no longer
  overwrites fresher pilot rows and `powerplay_finish_sync` keeps pilot rows
  observed after the dump was generated. New columns `powers`,
  `control_progress`, `reinforcement`, `undermining`; the layer rebuilds at most
  once a minute after pilot updates; the admin tab shows how many systems are
  fresher than the dump.
- Table `powerplay_systems` + singleton `powerplay_sync_state`; RPCs
  `powerplay_apply_batch`, `powerplay_finish_sync` (deletes rows the new dump
  lacks, in one transaction with the state), `powerplay_layer_rows` (one JSON —
  bypasses PostgREST `max_rows`). Migration `20261018120000_powerplay_systems.sql`.
- Import `src/lib/powerplaySync.ts` (web 2.24.0 — the same pipeline as the
  minor factions, shared modules `dumpArchive.ts` / `dumpShards.ts` /
  `dumpUpload.ts` / `importProgress.ts`): HEAD probe (the dump already imported
  by the current parser = «без изменений») → the archive is downloaded to the
  server in full (`data/spansh/powerplay`, `POWERPLAY_DOWNLOAD_SEGMENTS` = 4
  ordered 256 KiB pieces, resumable, stall detection and short requests on a
  ТСПУ-frozen link, a dump regenerated mid-transfer restarts) → split into
  `pp-NNNNN.ndjson.gz` chunks of 2000 systems (the whole archive is parsed,
  because one system's records are spread across the file; gzip by magic
  bytes) → guards before any write (< `POWERPLAY_MIN_ROWS` = 100 rows / < 50 %
  of the previous total never touch the table, `?force=1` accepts a shrunken
  dump; a broken archive is deleted) → chunks written by direct Postgres (one
  call per chunk) or PostgREST (batches of 2000, halved on statement_timeout),
  a chunk is the resume unit → `powerplay_finish_sync`, archive and chunks
  removed (`POWERPLAY_ARCHIVE_KEEP=1` keeps them). Step-by-step runs
  (`download` / `split` / `import` without EDSM), offline fallback to the archive
  on disk, archive upload from the admin's computer (`/api/admin/powerplay/upload`,
  8 MiB chunks, 409 resume, gzip + PowerPlay records check, adopts EDSM's ETag
  when the size matches). One run per process (`globalThis` single-flight —
  route bundles have separate module copies).
- Triggers: job `powerplay-sync` (12 h, default-enabled) and lazy refresh from
  `GET /api/powerplay/systems` when the table is empty or unchecked for 26 h
  (≤ 1 attempt / 30 min). The API answers compact tuples
  `[id64, name, x, y, z, powerIdx (−1 = unknown), stateIdx, observedSec, basisIdx?,
  presentPowerIdx[]?]` plus `bases`, ETag = import + meta, cached in memory until
  the next import.
- Progress (`src/lib/powerplayProgress.ts` on the shared `importProgress.ts`,
  web 2.24.0): five weighted stages like the factions (probe, download to the
  server, split, chunk import, finish), run modes (`full` / `download` / `split`
  / `import` — stages outside the mode are «не нужен» and not counted), an
  overall percent and a log; the live run lives in `globalThis`, a copy goes to
  `powerplay_sync_state.progress` / `.log` (migration
  `20261018180000_powerplay_sync_progress.sql`, which also adds the
  `powerplay_admin_summary()` RPC); a saved run of the old six-stage format is
  read with `request/parse/write` mapped to `probe/split/import`, and a
  «running» copy without a live run is shown as interrupted. Admin → «Игровые
  данные» → «PowerPlay» (`PowerplayAdminTab.tsx`) has the archive and chunk
  cards (download / split / import / cleanup, connections 1–16, «Загрузить
  архив с компьютера» via the shared `ArchiveUploadControl.tsx`), stage
  progress bars and the process log. The public layer API exposes only
  `meta.progress` (stage + percent) so the Atlas tab can say «сервер загружает
  данные EDSM — 64 %».
- Atlas tab: a status card (loading bytes via `X-Content-Bytes` / server import /
  loaded N systems / no data / error) and an always-visible power filter (all 12
  powers before data arrives, faction quick filter). Map points are clickable with
  a hover tooltip (`MapClickLayer` `extraPoints.onHover`); the Sol landmark glow
  (120 ly sprite) no longer swallows clicks in the bubble and landmarks are not
  clickable while the PowerPlay layer is shown.

### 8.17 Minor factions (BGS) in Atlas — web 2.19.0 (pipeline 2.20.0, sequential + upload 2.21.0), Helper 2.16.0
Full description: **FACTIONS.md**.
- Atlas tab «Фракции» (8th, `?tab=factions`, Alt+8) + a 3D layer: without a
  selection — every populated system with minor factions, colour = allegiance,
  allegiance filter; faction search (`/api/factions/search`, PMF-only toggle) and
  up to 12 selected factions (`/api/factions/presence`): their systems only,
  colour = faction, star = controls, ring = several selected, dot = present;
  «controls only» and «others as background» toggles. Clickable points with a
  hover tip and a system card (`/api/factions/system`) listing every faction
  with influence/states and «+» to put it on the map. PowerPlay and faction
  points share one `MapClickLayer` pick cloud (`layerPick` in `GalaxyScene`).
- Data lives in the project DB (migration `20261019120000_minor_factions.sql`):
  `bgs_systems`, `bgs_factions`, `bgs_faction_presence`, `bgs_sync_state`,
  `bgs_updates`; RPCs `bgs_apply_snapshots` (newer `observed_at` wins, the faction
  set of an applied system is replaced, known factions are not re-inserted so the
  id sequence is not burnt), the finish in short looped calls —
  `bgs_delete_missing`, `bgs_recount_factions_batch`, `bgs_prune_factions`,
  `bgs_finish_sync` — plus `bgs_layer_rows`, `bgs_search_factions`,
  `bgs_faction_presence_rows`, `bgs_system_detail`, `bgs_admin_summary`. Every call
  fits PostgREST's short `statement_timeout` (a timed-out batch is halved).
- Bulk source: EDSM `systemsPopulated.json.gz` (~0.5 GB). Since 2.20.0 the import
  is the catalog-style pipeline «archive on the server → chunks → DB»; since
  2.21.0 the steps run one after another (download the whole archive, then
  split, then write — `src/lib/bgsSync.ts`): galaxy `downloadDump` in ordered
  piece mode (`FACTIONS_DOWNLOAD_SEGMENTS`=8 connections take 8 MiB pieces in
  file order, `strictSource` compares every response with the probed dump — a
  dump regenerated mid-transfer restarts the download, a server refusing extra
  connections gets fewer), `.meta.json` + `.parts.json` for resume. EDSM is
  behind Cloudflare and Russian ISPs (TSPU) freeze TCP sessions to foreign CDNs
  after ~16 KB (seen in production: every connection got ~14 KB, then
  `read ETIMEDOUT` after Node's 70 s keep-alive): `stallTimeoutMs`
  (`FACTIONS_STALL_SECONDS`=15) aborts a silent attempt, and after two freezes
  under 1 MiB `shortRequests: 'auto'` (`FACTIONS_REQUEST_KB`) switches to Range
  requests of ~70 % of the smallest freeze point (≥ 4 KiB), each over a new
  connection (`src/lib/freshFetch.ts`: node:https, `keepAlive: false`, shared TLS
  session cache, redirects; `FACTIONS_FRESH_CONNECTIONS=0` = plain fetch).
  Fallback: «Загрузить архив с компьютера» (`src/lib/bgsUpload.ts`,
  `/api/admin/factions/upload`: start → `PUT ?offset=` 8 MiB chunks, 409 returns
  the real offset, resume by name+size+lastModified → finish checks gzip + EDSM
  array, adopts EDSM's ETag when the size matches, `.meta.json` `uploaded: true`);
  `full` mode takes an uploaded, not-yet-imported archive instead of probing
  EDSM; a gzip placed by hand (no meta, no plan) is adopted too.
  `bgsShards.ts` splits the downloaded archive into
  `shards/bgs-NNNNN.ndjson.gz` (1000 systems, ready RPC rows, `manifest.json`
  with the dump, run id, records read, imported flags); `bgsWriter.ts` writes the
  chunks — direct Postgres
  (`DATABASE_URL`/`SUPABASE_DB_URL`, one call per chunk, no statement timeout;
  `FACTIONS_DB_DIRECT=0` disables) or PostgREST (250-system batches halved on
  57014). A chunk is the resume unit (same run id, no re-download/re-split).
  Modes `full` / `download` / `split` / `import` (offline). Guards
  (< `FACTIONS_MIN_SYSTEMS`, < 50 % of the previous total) skip the deletion of
  missing systems; broken gzip drops archive + chunks. Stages probe / download /
  split / import / finish (`bgsProgress.ts`, one after another).
- Updates: Colonial Helper 2.16 (`uploader/bgs_sync.py`) and the site journal
  uploader (`BgsSnapshotCollector` in `src/lib/bgsJournal.ts`) send projected
  FSDJump/Location/CarrierJump with `Factions` to `POST /api/factions/sync`; both
  projections are checked against `scripts/tests/fixtures/bgs-journal.expected.json`.
  No personal fields, `SystemAddress` as a string, `source_hash` untouched.
- Admin → «Игровые данные» → «Фракции» (`FactionsAdminTab.tsx`,
  `/api/admin/factions`: start / force / download / split / import (+`segments`)
  / cancel / cleanup): DB summary, archive and chunk cards like «Каталог систем»,
  upload from computer (progress, stop, resume, discard), connection count
  selector, stage bars, pilots' updates, process log. Job `factions-sync` (daily
  07:10 UTC, default-enabled) never makes the first import; it refreshes data older
  than `FACTIONS_REFRESH_DAYS` and resumes an interrupted import.

### 8.18 Fleet carriers on the site (#143, #146 web 2.16.0, #147 web 2.16.1; Helper 2.14.0)
Full description: **FLEET-CARRIERS.md**.
- Tables (migrations `20261017000000_fleet_carriers.sql`,
  `20261018000000_fleet_carrier_squadron_claims.sql`): `fleet_carriers` (one row
  per CarrierID = MarketID; owner, squadron + `squadron_source`/`squadron_rejected`,
  location, jump, status, services, orders, finances; every field is updated only
  by a newer observation), `fleet_carrier_cargo`
  (`quantity = max(0, baseline + Σ later deltas)`), `fleet_carrier_events`
  (`event_hash UNIQUE`). All writes go through
  `apply_fleet_carrier_batch(user, source, ops)` (service_role only, row locks).
- Binding: the personal carrier binds itself from `CarrierStats`/`CarrierBuy`
  (only the owner receives them); a squadron Javelin binds to the pilot's
  squadron only from `SQUADRON_PROOF_EVENTS` (`CarrierLocation` with
  `CarrierType: SquadronCarrier`, `CarrierStats`, `CarrierBuy`) — never from
  docking; a 4-character callsign that differs from the squadron tag blocks the
  binding (`src/lib/carrierTags.ts`); events older than 30 days do not bind.
  Manual binding by Carrier ID / callsign — profile tab «Авианосец» and the
  squadron page.
- The delta hash is computed **on the server** (`src/lib/fleetCarriers.ts →
  carrierDeltaHash`); the site collector (`src/lib/fleetCarrierCollector.ts`)
  and Helper (`uploader/carrier_sync.py`) select the same events, so a journal
  uploaded both ways does not double the cargo.
- Map layer «Авианосцы» (`/map` and Atlas): `GET /api/map/carriers` (public
  markers without cargo or finances, relation own/squadron/other for the
  viewer), `CarrierMarkers`/`CarrierLayerControls`/`CarrierSystemCard`.
- Carrier markets move with the carrier: `move_fleet_carrier_station` re-homes
  the `station_commerce` row and drops stale `market_prices` of the old system.

### 8.19 Architect: «Проекты систем» (#145, web 2.15.0)
Full description: **ARCHITECT.md → «Проекты систем»**.
- `/architect/projects`: a project is a group of systems built together —
  members with roles (creator / moderator / member / responsible for a system),
  systems with an architect plan, carriers, progress and leaders.
- Tables (`20261017120000_architect_projects.sql`): `architect_projects`,
  `architect_project_members`, `architect_project_systems`,
  `architect_project_carriers`; RLS — read for members and admins only; SQL
  functions `architect_project_create`, `architect_project_transfer`,
  `architect_project_progress_sources`, `architect_project_contributions`,
  `architect_project_activity` (service_role).
- Rules live in `src/lib/architect/projects.ts` (`projectPermissions` …);
  routes `/api/architect/projects/**` apply them through
  `src/lib/architect/projectRouteKit.ts` (`openProject`: 401 for guests, 404
  for strangers). Limits: 100 systems, 200 members, 50 carriers per project,
  20 projects per creator.
- Progress merges the Raven cache (`system_progress`), journal site state
  (`colonisation_sites`) and the plan; the leaderboard counts site deliveries
  and carrier loading separately (`canonicalCommodity` unifies commodity names).

### 8.20 Stations and commerce (`/station-search`)
Full description: **STATION-COMMERCE.md**.
- Tables (`20261014000000_station_commerce.sql`, `20261014010000_station_search.sql`):
  `commerce_systems`, `station_commerce`, `station_inventory_snapshots` (one
  complete current snapshot per station and kind: market / outfitting /
  shipyard). Writes — `save_station_commerce(report)`; newer observation wins,
  equal timestamps: Helper → EDDN → EDSM → Spansh; `items: []` means observed
  empty, an absent service means unknown.
- Sources: Colonial Helper (`POST /api/stations/report`, `Market.json`,
  `Outfitting.json`, `Shipyard.json` while docked, outbox
  `.station_commerce_outbox.json`), EDDN, Atlas EDSM requests, rich Spansh dumps.
- `/station-search` (commodities, modules, ships, services) →
  `GET /api/stations/search` → RPC `search_station_catalog`; never calls
  EDSM/Spansh itself. Atlas «Рынок» reads the same snapshots first (freshness
  1 hour) and only then refreshes from EDSM.

### 8.21 Journal reset and cross-path deduplication (#141, #142)
- «Перезагрузить логи с нуля»: `POST /api/journal/reset` (session or Helper
  token, `confirm: true`, optional sections) → `src/lib/journalReset.ts`
  deletes the pilot's `deliveries`, `journal_imports`, legacy
  `colonisation_events`, `pilot_stats`, `system_scans` in batches and detaches
  authorship from `colonisation_sites`; `/api/logs/import`, `/api/logs/upload`
  and `/api/journal/import` accept `reset`/`full_reimport` to do it as the first
  batch. Buttons — account page and Helper («Очистить логи на сервере», which
  also clears the local import cache).
- `source_hash` parity: the browser parser (`src/lib/journalParser.ts`) and the
  Helper parser (`uploader/journal_parser.py`) hash the same fields with
  SHA-256 and the same `journal-v2-` prefix and commodity normalisation —
  comments mark every place that must stay in sync. Faction data goes through
  its own route (`/api/factions/sync`) and does not touch `source_hash`.

### 8.22 Security hardening (#135, #139)
Details: **PROFILES-PII-RLS-FIX.md** and
`supabase/migrations/20261016000000_credentials_and_views_hardening.sql`.
- `profiles` is readable only by its owner and staff (`request_is_staff()`);
  public reads of other pilots go through the view `public_profiles` (no email,
  role, privacy settings); the trigger `protect_profile_privileged_columns` lets
  only admins and the server change `role`/`email`; `deliveries` — owner and
  staff only.
- `capi_tokens` and `inara_profiles` — service_role only; `api_tokens` hides
  `token_hash` and forbids direct writes (tokens are issued and revoked through
  `/api/auth/tokens`); `delivery_scope_summary` is `security_invoker`;
  `squadron_member_detail` joins `public_profiles`.
- Gateway `/api/supabase/*` (`next.config.mjs` rewrites to
  `SUPABASE_INTERNAL_URL`), nginx templates, Helper and the Android client do
  not leak credentials — `scripts/tests/credentials-and-gateway-hardening.test.mjs`,
  `scripts/tests/profiles-rls-hardening.test.mjs`.

---

### 8.23 One mechanism for system data (web 2.22.0) — see ARCHITECTURE.md
Analysis of all sections, the gaps found (G1–G17) and the plan live in
**ARCHITECTURE.md**. What the code now shares:
- **System identity** — `src/lib/systemIdentity.ts`: `systemKey` (the old
  `systemNameKey`, `carrierSystemKey`, `coordinateNameKey`, `normalizeSystemKey`,
  `nearbyNameKey`, Architect `systemKey` are aliases; `system-identity.test.mjs`
  guards it), `systemId64`, and the cross-section links `systemPageHref`,
  `atlasSystemHref` (`?tab=factions|powerplay&focus_id64=…` opens the system on
  the layer), `stationSearchHref` (`/station-search?reference=…`),
  `externalSystemLinks`.
- **Journal ingest** — `src/lib/journalIngest.ts` is the single body of
  `/api/logs/upload` (Helper) and `/api/logs/import` (browser): reset, nickname,
  deliveries, telemetry, then reactions. Responses are unchanged plus `projects`.
- **System observations** — `src/lib/systemObservations.ts`: one FSDJump /
  Location / CarrierJump → factions + PowerPlay (section 8.16); used by
  `/api/factions/sync` and CAPI (`observationEventsFromJournalText`).
- **Reactions** — `src/lib/projects/projectSync.ts` +
  SQL `sync_project_systems_from_sites`: construction sites from any journal
  path (Helper, browser, `/account/journal`, CAPI) move squadron project systems
  forward only (planned → building → done) and notify project members through
  `src/lib/notify.ts` (`user_notifications` + web push when VAPID is set). CAPI
  no longer calls `updateProjectProgress` per event.
- **System card** — SQL `system_overview_sources(key, id64, names, viewer)` +
  `src/lib/systemOverview.ts` + `GET /api/systems/overview` +
  `src/components/System/SystemOverviewSections.tsx` on `/system/[name]`:
  catalog, colonisation through the same `buildSystemProgress` as «Проекты
  систем» (Raven cache + journal sites + plan), squadron projects, the viewer's
  architect projects (strangers' projects are not revealed even as a count),
  ring route/hub, stations with inventory freshness, factions, PowerPlay,
  carriers (`carrierMapStore.loadSystemCarriers`, same privacy as the map layer),
  community goals, delivery totals, scans, per-source freshness and links.
  `system_progress_sources(keys)` gives the same progress inputs for any set of
  systems (`systemOverview.loadSystemsProgress`); `GET /api/projects/[id]/progress`
  serves it per system of a squadron project, and `/projects/[id]` shows the
  percentage next to each system.

## 9. Background jobs (`jobs`)

Schedule: `scripts/job-schedule.mjs` (shared with the monitor agent), runner:
`scripts/server-jobs.mjs` in the Compose service `jobs` (exactly one instance,
read-only container). It POSTs to `http://web:3000<path>` with
`Authorization: Bearer $CRON_SECRET`; state (last success, next slot, last
error) goes to `/data/jobs-state.json` and is shown in Admin → Мониторинг.
`JOBS_ENABLED` lists the enabled jobs (empty = all off); missing Inara/Yandex
keys are logged as skips. Manual run: `node scripts/server-jobs.mjs --once <job>`.

| Job | Period · offset (UTC) | Path | Timeout | Default |
|---|---|---|---|---|
| `capi-sync` | 5 min | `/api/cron/capi-sync` | 15 min | on |
| `update-progress` | 30 min | `/api/cron/update-progress` | 20 min | on |
| `cg-check` | 6 h | `/api/cron/cg-check` | 5 min | on |
| `eddn-cleanup` | 6 h · :30 | `/api/cron/eddn-cleanup` | 5 min | on |
| `colonisation-cleanup` | 24 h · 03:40 | `/api/cron/colonisation-cleanup` | 10 min | on |
| `galnet-sync` | 24 h · 06:20 | `/api/galnet` | 15 min | on |
| `translate` | 6 h · :40 | `/api/cron/translate` | 15 min | on |
| `powerplay-sync` | 12 h · 05:20 | `/api/cron/powerplay-sync` | 10 min | on |
| `factions-sync` | 24 h · 07:10 | `/api/cron/factions-sync` | 5 min | on (refresh/resume only; the first import is the admin's) |
| `galaxy-import` | 24 h · 02:00 | `/api/cron/galaxy-import` | 10 min | **off** (opt-in; nightly Spansh delta) |

Long imports (catalog, PowerPlay, factions) start in `web` and answer at once;
their progress lives in the admin tabs, not in the job timeout.

---

## 10. Environment Variables

The full, commented reference is **[.env.example](.env.example)** (local:
`.env.local`, server: `.env.production`; the admin panel edits the server file
through update-agent — Admin → Мониторинг → «API-ключи сайта»). `NEXT_PUBLIC_*`
values are baked in at build time — rebuild `web` after changing them.

| Group | Variables |
|---|---|
| Required | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET` |
| Supabase gateway / direct DB | `SUPABASE_INTERNAL_URL` (same-origin gateway), `SUPABASE_DB_URL` / `DATABASE_URL` (direct Postgres), `SUPABASE_NETWORK`, `SUPABASE_NET_WATCH_*`, `MONITOR_DB_URL`; CLI only: `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` |
| Jobs | `JOBS_ENABLED`, `JOBS_TRANSLATE_PASSES`, `COLONISATION_RETENTION_DAYS`, `GALNET_FEED_LIMIT`, `GALNET_TRANSLATE_LIMIT` |
| Galaxy catalog | `GALAXY_IMPORT_URL`, `GALAXY_DUMP_BASE_URL`, `GALAXY_DOWNLOAD_SEGMENTS` (4), `GALAXY_IMPORT_MODE` (stream/shards), `GALAXY_DATA_HOST_DIR`, `GALAXY_ARCHIVE_DIR`, `GALAXY_SHARDS_*`, `GALAXY_ARCHIVE_KEEP`, `GALAXY_DISK_CHECK`, `GALAXY_IMPORT_FILE`, `GALAXY_COPY_MERGE_TIMEOUT_S`, `GALAXY_POINTS_*` |
| PowerPlay / factions | `POWERPLAY_DUMP_URL`, `POWERPLAY_ARCHIVE_DIR`, `POWERPLAY_ARCHIVE_KEEP`, `POWERPLAY_DOWNLOAD_SEGMENTS` (4), `POWERPLAY_PIECE_KB` (256), `POWERPLAY_SHARD_SYSTEMS` (2000), `POWERPLAY_DB_DIRECT` (1), `POWERPLAY_STALL_SECONDS` (15), `POWERPLAY_REQUEST_KB` (auto), `POWERPLAY_FRESH_CONNECTIONS` (1), `POWERPLAY_BATCH_SIZE` (2000), `POWERPLAY_MIN_ROWS` (100); `FACTIONS_DUMP_URL`, `FACTIONS_REFRESH_DAYS` (7), `FACTIONS_ARCHIVE_DIR`, `FACTIONS_ARCHIVE_KEEP`, `FACTIONS_DOWNLOAD_SEGMENTS` (8), `FACTIONS_PIECE_MB` (8), `FACTIONS_SHARD_SYSTEMS` (1000), `FACTIONS_DB_DIRECT` (1), `FACTIONS_STALL_SECONDS` (15), `FACTIONS_REQUEST_KB` (auto), `FACTIONS_FRESH_CONNECTIONS` (1), `FACTIONS_BATCH_SIZE` (250), `FACTIONS_MIN_SYSTEMS` (1000) |
| Monitoring and updates | `MONITOR_AGENT_TOKEN`, `UPDATE_AGENT_TOKEN`, `UPDATE_AGENT_URL`, `PROJECT_REPOSITORY`, `PROJECT_UPDATE_BRANCH`, `PROJECT_DEPLOY_MODE`, `UPDATE_APPLY_MIGRATIONS`, `UPDATE_BACKUP_DIR`, `UPDATE_BACKUP_KEEP`, `BACKUP_TIMEOUT_MINUTES`, `RUN_TESTS`, `UPDATE_*` cache/retry knobs, `APP_GIT_*` |
| Auth and mail | `AUTH_OAUTH_PROVIDERS`, `AUTH_EMAIL_ENABLED`, `VK_ID_CLIENT_ID`/`_SECRET`, `YANDEX_ID_CLIENT_ID`/`_SECRET` (SMTP itself lives in the Supabase auth stack) |
| Frontier CAPI | `FRONTIER_REDIRECT_URI`, `FRONTIER_CLIENT_ID` (optional, built-in key), `FRONTIER_CLIENT_SECRET`, `CAPI_STATE_SECRET` |
| Integrations | `YANDEX_TRANSLATE_API_KEY` / `_IAM_TOKEN` / `_FOLDER_ID`, `INARA_API_KEY`, `DISCORD_WEBHOOK_URL`, `RAVEN_API_BASE`, `RAVEN_KEY_SECRET`, `EDDN_INGEST_SECRET`, `EDDN_INGEST_URL` |
| Push | `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| Billing | `BILLING_STORAGE`, `BILLING_PREVIEW_ADMIN` (providers and keys are configured in the admin panel) |
| Colonial Helper releases | `UPLOADER_STORE_DIR`, `UPLOADER_STORE_HOST_DIR`, `UPLOADER_SOURCE_DIR`, `UPLOADER_PUBLISH_TOKEN`, `UPLOADER_SIGN_PUBLIC_KEYS`, `UPLOADER_SIGN_KEY`, `UPLOADER_SIGN_KEY_ID` |

---

## 11. Development Workflow

### 11.1 Local Development
```bash
npm ci
cp .env.example .env.local     # fill in Supabase values
npm run dev                    # http://localhost:3000
npm run typecheck              # next typegen + tsc --noEmit
npm run test:quick             # ~1278 checks; npm test — all 1536
```
`next dev` rewrites `next-env.d.ts` and may touch `data/billing_store.json` —
do not commit those changes by accident.

### 11.2 Database Changes
1. Add `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql` — idempotent (it can be
   applied twice: by the server and by `full_schema.sql`).
2. Append the same SQL as a `-- MIGRATION: <file>` block to the end of
   `supabase/full_schema.sql` (order = file order).
3. `npm test` — `migrations-sql.test.mjs` parses every migration with
   libpg-query and checks the snapshot; feature tests run the SQL in PGlite
   (`scripts/tests/helpers/pgliteSupabase.mjs`).
4. Document the tables in supabase/DATABASE.md and section 4 here.
5. Production applies it on the next «Обновить сейчас» with «с миграциями».

### 11.3 Build & Deploy
```bash
npm run build                  # standalone build (the Docker image runs npm test first)
# Production: Admin → Мониторинг → «Обновить сейчас» (deploy/update-project.sh).
# Manual equivalent on the server:
docker compose --env-file .env.production --profile monitoring up -d --build web jobs
```

### 11.4 Git Workflow
Work in a branch (`arena/<id>-ed-ring-colony` for agent sessions), open a pull
request, merge into `main`; the server pulls `PROJECT_UPDATE_BRANCH` (default
`main`) when the admin presses «Обновить сейчас». Bump `package.json` →
`version` for user-visible web changes and `uploader/colonial_helper.py` →
`VERSION` (+ a new top section of `uploader/CHANGES.md`) for Helper releases;
add a line to CHANGELOG.md.

---

## 12. Common Patterns

### 12.1 Server Component with Data
```tsx
export default async function Page() {
  const supabase = await createClient();
  const { data } = await supabase.from('table').select('*');
  return <Component data={data} />;
}
```

### 12.2 Client Component with Realtime
```tsx
'use client';
useEffect(() => {
  const channel = supabase
    .channel('name')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'table' }, callback)
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, []);
```

### 12.3 API Route with Auth
```tsx
import { authFromRequest } from '@/lib/supabaseServer';      // cookie or Bearer JWT
import { resolveRequestUser } from '@/lib/helperAuth';        // … or Colonial Helper `rc_…` token
export async function POST(request: Request) {
  const { user } = await authFromRequest(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // ...handle request
}
// Cron routes: return runCronTask(request, 'job-name', async () => { ... })  (src/lib/cronAuth.ts)
// Admin routes: requireAdmin / requireStaff from src/lib/billing/auth.ts
```

### 12.4 Icon Usage
```tsx
import { IconSquadron, IconSend } from '@/components/Icons';
<IconSquadron size={16} color="#e67e22" />
```

### 12.5 i18n Usage
```tsx
import { useI18n } from '@/lib/i18n/I18nContext';
const { t, locale, setLocale } = useI18n();
<div>{t('nav.home')}</div>
```

---

## 13. Troubleshooting

### Build fails with TypeScript error
- Run `npm run typecheck` and `npm run build` locally before push
  (`next.config.mjs` does not ignore TypeScript errors)
- The Docker build also runs `npm test`; a failing test stops the update at
  stage `build` — the log is in Admin → Мониторинг

### Supabase connection fails
- Verify `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Check RLS policies allow the operation

### Realtime not working
- Verify channel name is unique per subscription
- Check filter syntax: `table=eq.value`
- Ensure table has realtime enabled in Supabase dashboard

### Migration fails
- Migrations run in file-name order; a failed one stays unmarked in
  `migrations.mark` and is retried on the next run — make it idempotent
- The update log names the file and the SQL error; «Применить только миграции»
  re-runs them without a rebuild
- Hosted Supabase CLI: `npx supabase migration repair --status applied <version>`

### Translation not working
- Verify `YANDEX_TRANSLATE_API_KEY` is set
- Check `CRON_SECRET` for cron endpoint auth
- Очередь видна в Админка → Мониторинг («Контент и переводы») и там же
  добивается кнопкой; `translation_status = partial` означает «переведено не
  всё», а не «готово»
- Язык оригинала для `news` — русский, для `galnet_news` — английский; если
  переводы вышли мусором, проверьте `source_lang` строки, а не только ключ

### Админка меняет текст, а сайт — нет
- Применены ли миграции переводов (`supabase/migrations/`); панель показывает
  предупреждение, а `select('*')` не даёт всему блоку упасть из-за этого
- Открыта ли главная с `?_r`/без кэша прокси: `/api/home-data` отвечает
  `no-store`, но статическая страница может жить в CDN-кэше
- Проверьте, что редактор сохраняет нужную локаль: базовая колонка = `ru`

### Update button says the agent is unreachable
- `docker compose --env-file .env.production --profile monitoring ps update-agent`
  или `systemctl status ed-ring-colony-update`
- `UPDATE_AGENT_TOKEN` в `.env.production` должен совпадать у сайта и агента;
  после правки — пересоздайте `web`
- Подробности: `MONITORING.md`, раздел «Ручное обновление проекта»

### Imports (catalog, PowerPlay, factions) stall or fail
- Catalog: SPANSH-IMPORT.md → diagnostics; `node scripts/import-spansh-systems.mjs --check-db`
  checks the direct Postgres path (DNS and TCP separately)
- PowerPlay / factions: the admin tabs show stage bars and the process log;
  EDSM connections frozen by the network → FACTIONS.md (short requests,
  «Загрузить архив с компьютера», `FACTIONS_DUMP_URL` mirror)

---

## 14. Key Decisions

1. **No UI library** — Custom components for full control over the HUD aesthetic
2. **No global state** — Server Components + Realtime cover 95% of needs
3. **Direct Supabase queries + SQL functions** — No ORM; heavy work in service-role RPCs, bulk imports over direct Postgres
4. **App Router only** — No Pages Router, no hybrid approach
5. **Global CSS first** — `globals.css` is the source of truth (+ `src/styles/forum-extra.css`; CSS modules only for the admin shell/outfitting editor)
6. **Custom icons** — No Lucide, no Heroicons — consistent stroke width and style
7. **TypeScript strict** — No `any`, no implicit returns
8. **Custom i18n** — No react-i18next, lightweight context-based solution (7 locales)
9. **The server deploys itself** — no CI: tests run inside the Docker build, the update-agent applies migrations and switches containers
10. **One parser contract** — the browser journal parser and the Python Helper parser must produce identical `source_hash` values; the orrery layout is mirrored the same way (3.6)

---

*End of Context Document. Design — DESIGN.md, setup — README.md, all documents — DOCS.md.*
