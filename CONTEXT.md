# ED Ring Colony — Project Context & Architecture

> **Living document for developers and AI assistants.**
> Last updated: 2026-09-21.
> Uploader release: 2.10.25.
> Project: https://github.com/NooboGreenD/ed-ring-colony
> Live: https://edringcolony.ru

---

## Current deployment

Production already uses self-hosted Docker and Supabase at
`https://supabase.edringcolony.ru`. This branch prepares `web` + `jobs`; it has NOT
been deployed. Start with **UBUNTU20-UPGRADE.md** (existing-install updater and
rollback); details in POST-MIGRATION.md. Six scheduled workflow files are removed
on this branch, but remote main schedules must remain until server handoff.
The only retained workflow builds the Windows uploader (main stable / arena prerelease).
Continue development on `arena/01a0c073-ed-ring-colony` through its PR; do not merge
or deploy automatically. UBUNTU20-UPGRADE.md downloads source directly from GitHub,
not from the temporary chat archive. Check the branch Windows workflow for EXE
build status; preparing a PR alone is not proof that an EXE has been published.

Next 16.3.5 + React 19.2.8, Fiber 9.7.0 / Drei 10.7.8, Supabase SSR 0.12.7;
Previously tracked generated node_modules entries are removed from Git; use npm ci and the lockfile.
Node >=22.18. Request cookies/params are async; `proxy.ts` replaces middleware.
SSR cookie refreshes preserve no-store headers. Browser URL autologin is disabled.
OAuth link/login shares a signed, UUID-bound PKCE flow for Discord and opt-in
Google/GitHub. Provider credentials belong in GoTrue, not just site env.

Email signup now uses anonymous signUp, requires GoTrue autoconfirm=false and
AUTH_EMAIL_ENABLED=true. No SMTP means new signups are closed; existing passwords
are untouched. New email links carry TokenHash in the fragment, then require POST
consent. Recovery has a signed 10-minute user/session-bound grant and revokes
refresh sessions + uploader tokens; it does not silently unlink social methods.
Legacy auto-confirmed email claims need targeted review, not mass account mutation.

Realtime troubleshooting: see REALTIME-FIX.md and the standalone read-only
`deploy/selfhost/realtime-check.py` (Kong vs direct Realtime vs public WSS,
validated Upgrade + Phoenix heartbeat, no keys/env/logs in the report).
NotificationBell/UnreadBadge must never subscribe for guests or with eq.undefined;
subscriptions follow the current auth UUID and clean up on logout/account change.
Fresh nginx templates include a dedicated /realtime/v1/ upgrade route; existing
production TLS configs require a reviewed merge, not rerunning install.sh.

## 1. Project Overview

**ED Ring Colony** is a web platform for coordinating colonization efforts in the game Elite Dangerous. It serves as a command center for player squadrons, project management, system atlas, forum, wiki, and leaderboard.

### Core Features
- **Homepage** — Hero with starfield, stats, news feed, Galnet feed
- **Galaxy Map** — Interactive 3D map of colonization ring (Three.js)
- **Squadrons** — CRUD for player squadrons, member management, ranks, dual-channel chat
- **Projects** — Colonization project management with route planning
- **Forum** — Community forum with categories, threads, reactions, search, moderation
- **Wiki** — Full wiki with categories, tags, revisions, favorites, colonization guides
- **Leaderboard** — Player statistics and achievements
- **Atlas** — System search, favorites, route finder, candidate lists
- **News** — Admin-managed news feed + auto-synced Galnet
- **Notifications** — Real-time push + in-app notification bell
- **Direct Chat** — Peer-to-peer messaging between players
- **Friends** — Friend list with online status
- **Comments** — Comment system on profiles and content
- **Admin Panel** — Raven Colonial sync, content management, moderation
- **i18n** — 100+ languages with Yandex Translate integration

---

## 2. Tech Stack

| Layer | Technology | Version | Notes |
|-------|-----------|---------|-------|
| Framework | Next.js / React | 16.3.5 / 19.2.8 | App Router; async cookies/params, proxy.ts |
| Language | TypeScript | 5.x | Strict mode |
| Styling | Tailwind CSS | 4.3.3 | + custom CSS in globals.css, forum-extra.css |
| UI Library | None | — | Custom components only |
| Icons | Custom SVG | — | src/components/Icons.tsx |
| 3D | Three.js / R3F / Drei | 0.185.1 / 9.7.0 / 10.7.8 | WebGL2 browser smoke tested |
| Database | Supabase | latest | PostgreSQL + Realtime |
| Auth | Supabase Auth | latest | Email + Discord OAuth |
| ORM | None | — | Direct Supabase queries |
| State | React hooks | — | No Redux, no Zustand |
| Push | web-push | 3.6.7 | Server-side push notifications |
| Markdown | react-markdown | 10.1.0 | + remark-gfm + rehype-sanitize |
| Validation | zod | 4.4.3 | Schema validation |
| Cache | lru-cache | 11.5.2 | In-memory caching |
| i18n | Custom context | — | lib/i18n/ |
| Translate | Yandex API | v2 | Cron-driven auto-translation |

---

## 3. Architecture

### 3.1 App Router Structure
```
src/app/
  layout.tsx              # Root: topbar + sidebar + footer
  page.tsx                # Homepage (Client Component)
  
  [route]/
    page.tsx              # Route pages
    layout.tsx            # Optional nested layouts
    
  api/
    [endpoint]/
      route.ts            # API routes (Route Handlers)
```

### 3.2 Data Flow
```
Browser → Next.js App Router → API Route (if needed) → Supabase
         ↓
    Server Component → supabaseServer.ts → Supabase (direct)
    Client Component → supabaseClient.ts → Supabase (direct + Realtime)
```

### 3.3 Supabase Clients
| Client | File | Use Case |
|--------|------|----------|
| Browser | `src/lib/supabaseClient.ts` | Client components, Realtime subscriptions |
| Server | `src/lib/supabaseServer.ts` | Server components, API routes |
| Admin | `src/lib/supabaseAdmin.ts` | Service role operations (bypass RLS) |

### 3.4 Authentication Flow
1. User clicks "Login" → `/login` page
2. Email/Password or Discord OAuth
3. Supabase Auth sets cookie
4. Middleware (`src/middleware.ts`) refreshes session
5. Server components read session via `supabaseServer.ts`
6. Client components read session via `supabaseClient.ts`

### 3.5 Realtime Subscriptions
- **Squadron chat**: `squadron_chat_messages` table, filtered by `squadron_id`
- **Notifications**: `user_notifications` table, filtered by `user_id`
- **Forum**: Thread views, new posts

### 3.6 System orrery layout engine (site ↔ uploader)
Both map clients share one pure layout model, so the website and the desktop
helper cannot disagree about where a body sits:

| Side | Engine | Renderer |
|------|--------|----------|
| Website `/system/[name]` | `src/lib/systemOrrery.ts` | `src/components/SystemPlotlyMap.tsx` (Plotly WebGL) |
| Colonial Helper «Карта системы» | `uploader/orrery.py` | `uploader/system_map.py` (Tk canvas) + `uploader/plotly_map.py` (2D/3D HTML export) |

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
- Tests pin the parity: `scripts/tests/system-orrery.test.mjs` (28 cases) and
  `uploader/tests/test_orrery_layout.py` + `test_plotly_map_cards.py`.
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

### 4.1 Core Tables
| Table | Purpose |
|-------|---------|
| `profiles` | User profiles (cmdr_name, avatar, faction, language, etc.) |
| `squadrons` | Squadron data (name, tag, allegiance, settings) |
| `squadron_members` | Membership links (user_id, squadron_id, rank_id) |
| `squadron_ranks` | Rank definitions with permissions |
| `squadron_chat_messages` | Chat messages (general + officer channels) |
| `projects` | Colonization projects |
| `project_members` | Project membership |
| `project_systems` | Systems in a project |
| `hubs` | Colonized systems (status, coords, progress) |
| `forum_categories` | Forum category tree |
| `forum_threads` | Forum threads |
| `forum_posts` | Forum posts (replies) |
| `forum_reactions` | Post reactions |
| `user_notifications` | In-app + push notifications |
| `news` | News articles |
| `galnet_news` | Auto-synced Frontier Galnet |
| `site_content` | Editable homepage content |
| `site_content_translations` | Translated site content |
| `wiki_articles` | Wiki articles with revisions |
| `wiki_categories` | Wiki category tree |
| `wiki_tags` | Wiki tags |
| `wiki_favorites` | User wiki favorites |
| `comments` | Comments on profiles/content |
| `friends` | Friend relationships |
| `direct_messages` | P2P messages |
| `push_subscriptions` | Web push subscriptions |
| `deliveries` | Per-commander cargo events (see 8.6); `source`, `is_construction`, `market_id` split "all cargo" from "delivered to construction sites" |
| `colonisation_events` | Shared `ColonisationConstructionDepot` records (system, market, progress, required resources) |
| `construction_depot_snapshots` | Progress snapshots per construction market, deduplicated by state signature |
| `system_scans` | One row per body: orbit, radius, gravity, temperature, atmosphere, volcanism, rings, biosignals, discovery records |
| `pilot_stats` | Balance, Odyssey ranks and exobiology counters mirrored into the pilot dossier |
| `galaxy_systems` | Full Spansh catalog (~1.3M): coords, main star class, permit. Public read. |

### 4.2 Key Relationships
```
profiles (1) ──< (N) squadron_members >── (N) squadrons
squadrons (1) ──< (N) squadron_ranks
squadrons (1) ──< (N) squadron_chat_messages
squadrons (1) ──< (N) projects
projects (1) ──< (N) project_members
projects (1) ──< (N) project_systems
profiles (1) ──< (N) user_notifications
profiles (1) ──< (N) comments
profiles (1) ──< (N) friends
profiles (1) ──< (N) direct_messages
forum_categories (1) ──< (N) forum_threads
forum_threads (1) ──< (N) forum_posts
forum_posts (1) ──< (N) forum_reactions
wiki_categories (1) ──< (N) wiki_articles
wiki_articles (N) ──< (N) wiki_tags
```

### 4.3 RLS Policies
All tables have Row Level Security enabled. Key policies:
- `profiles`: Public read, self write
- `squadrons`: Public read, creator/officer write
- `squadron_members`: Members read, officer manage
- `squadron_chat_messages`: Members read/write, author/officer delete
- `user_notifications`: Self only
- `wiki_articles`: Public read, author/admin write
- `comments`: Public read, author/admin write

### 4.4 Migrations
Located in `supabase/migrations/`. Sequential numbering.
Applied via `npx supabase db push`.

---

## 5. API Routes

### 5.1 Squadron API
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/squadrons` | GET | None | List all squadrons |
| `/api/squadrons` | POST | Auth | Create squadron |
| `/api/squadrons/[id]` | GET | None | Get squadron details |
| `/api/squadrons/[id]` | PATCH | Officer | Update squadron |
| `/api/squadrons/[id]/members` | GET | Member | List members |
| `/api/squadrons/[id]/members` | POST | Officer | Add member |
| `/api/squadrons/[id]/ranks` | GET | Member | List ranks |
| `/api/squadrons/[id]/ranks` | POST | Officer | Create rank |
| `/api/squadrons/[id]/projects` | GET | Member | List projects |
| `/api/squadrons/[id]/chat` | GET | Member | Get chat messages |
| `/api/squadrons/[id]/chat` | POST | Member | Send message |
| `/api/squadrons/[id]/chat/[msgId]` | DELETE | Author/Officer | Delete message |

### 5.2 Project API
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/projects` | GET | None | List projects |
| `/api/projects` | POST | Auth | Create project |
| `/api/projects/[id]` | GET | Member | Get project |
| `/api/projects/[id]` | PATCH | Officer | Update project |
| `/api/projects/[id]/members` | GET | Member | List members |
| `/api/projects/[id]/systems` | GET | Member | List systems |
| `/api/projects/[id]/systems` | POST | Officer | Add systems |
| `/api/projects/[id]/route` | GET | Member | Get route |
| `/api/projects/[id]/progress` | GET | Member | Get progress |

### 5.3 Forum API
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/forum/categories` | GET | None | List categories |
| `/api/forum/threads` | GET | None | List threads |
| `/api/forum/threads` | POST | Auth | Create thread |
| `/api/forum/posts` | GET | None | List posts |
| `/api/forum/posts` | POST | Auth | Create post |
| `/api/forum/reactions` | POST | Auth | Add reaction |
| `/api/forum/search` | GET | None | Search |
| `/api/forum/report` | POST | Auth | Report content |

### 5.4 Wiki API
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/wiki/articles` | GET | None | List articles |
| `/api/wiki/articles` | POST | Auth | Create article |
| `/api/wiki/articles/[slug]` | GET | None | Get article |
| `/api/wiki/articles/[slug]` | PATCH | Auth | Update article |
| `/api/wiki/articles/[slug]/revisions` | GET | None | Get revisions |
| `/api/wiki/categories` | GET | None | List categories |
| `/api/wiki/categories/[slug]` | GET | None | Get category |
| `/api/wiki/tags` | GET | None | List tags |
| `/api/wiki/tags/[slug]` | GET | None | Get tag |
| `/api/wiki/search` | GET | None | Search wiki |
| `/api/wiki/favorites` | GET | Auth | List favorites |
| `/api/wiki/favorites/[id]` | DELETE | Auth | Remove favorite |

### 5.5 Other API
| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/leaderboard` | GET | None | Player stats |
| `/api/atlas/search` | GET | None | System search |
| `/api/atlas/route-finder` | GET | Auth | Route planning |
| `/api/atlas/favorites` | GET | Auth | Atlas favorites |
| `/api/edsm/system` | GET | None | EDSM proxy |
| `/api/edsm/batch` | POST | None | EDSM batch |
| `/api/galnet` | GET | None | Galnet news |
| `/api/galnet/[nid]` | GET | None | Galnet article |
| `/api/news` | GET | None | Site news |
| `/api/news/[id]` | GET | None | News article |
| `/api/notifications` | GET | Auth | User notifications |
| `/api/notifications` | PATCH | Auth | Mark read |
| `/api/push/subscribe` | POST | Auth | Push subscription |
| `/api/push/send` | POST | Admin | Send push |
| `/api/eddn` | POST | None | EDDN ingestion |
| `/api/ravencolonial/sync` | POST | Admin | Raven sync |
| `/api/ravencolonial/sync/log` | GET | Admin | Sync log |
| `/api/logs/upload` | POST | API token | Deliveries and construction snapshots from Colonial Helper |
| `/api/journal/import` | POST | Auth | Browser/CAPI Journal import |
| `/api/translate` | POST | Auth | Translate content |
| `/api/cron/translate` | POST | Cron | Auto-translation job |
| `/api/galnet` | POST | Cron | Galnet sync + translate new articles |
| `/api/galnet` | PATCH | Cron | Drain translation queue |
| `/api/comments` | GET | None | List comments |
| `/api/comments` | POST | Auth | Create comment |
| `/api/comments/[id]` | DELETE | Auth | Delete comment |
| `/api/friends` | GET | Auth | List friends |
| `/api/friends` | POST | Auth | Add friend |
| `/api/home-data` | GET | None | Homepage data |

---

## 6. Components

### 6.1 Layout Components
| Component | File | Type | Description |
|-----------|------|------|-------------|
| RootLayout | `app/layout.tsx` | Server | Topbar, sidebar, footer wrapper |
| Sidebar | `components/Sidebar.tsx` | Client | Navigation sidebar |
| Topbar | `app/layout.tsx` | Server | Brand, status, clock, notifications, user menu |
| Footer | `components/Footer.tsx` | Server | Site footer |
| UserMenu | `components/UserMenu.tsx` | Client | Auth dropdown |
| NotificationBell | `components/NotificationBell.tsx` | Client | Notification dropdown + real-time |
| LanguageSwitcher | `components/LanguageSwitcher.tsx` | Client | Locale selector |

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
| AtlasRouteFinder | `components/Atlas/AtlasRouteFinder.tsx` | Client | Route finder |
| AtlasCandidateList | `components/Atlas/AtlasCandidateList.tsx` | Client | Candidate systems |
| CommentSection | `components/Comments/CommentSection.tsx` | Client | Comments |
| FriendsPanel | `components/FriendsPanel.tsx` | Client | Friend list |
| Starfield | `components/Starfield.tsx` | Client | Canvas starfield background |
| Leaderboard | `components/Leaderboard.tsx` | Server | Leaderboard table |
| CmdrDossier | `components/CmdrDossier.tsx` | Server | Player profile — cargo totals, construction-site tonnage, achievements, squadron |
| SystemPlotlyMap | `components/SystemPlotlyMap.tsx` | Client | 3D/2D orrery of one system: focus fly-to, star clusters, isolate, body card with ground structures |
| AdminComments | `app/admin/components/AdminComments.tsx` | Client | Admin moderation |
| RavenSyncTab | `components/Admin/RavenSyncTab.tsx` | Client | Raven sync UI |

### 6.3 Icon Components
All in `src/components/Icons.tsx`. See DESIGN.md for full list.

---

## 7. State Management

### 7.1 Server State
- Fetched in Server Components via `supabaseServer.ts`
- Cached with `revalidate` (ISR) where appropriate
- No client-side caching library

### 7.2 Client State
- React `useState` / `useReducer` for local UI state
- Supabase Realtime for live data (chat, notifications)
- No global state manager (Redux, Zustand, Jotai)

### 7.3 URL State
- `useSearchParams` for filters, tabs, pagination
- `usePathname` for active navigation

---

## 8. External Integrations

### 8.1 EDSM (Elite Dangerous Star Map)
- Proxy API: `/api/edsm/system`, `/api/edsm/batch`
- Used for: System coordinates, body data, station info

### 8.2 EDDN (Elite Dangerous Data Network)
- Ingestion endpoint: `/api/eddn`
- Used for: Real-time market, system status data

### 8.3 Discord
- OAuth login via `/api/auth/desktop`
- Webhook integration for notifications

### 8.4 Spansh
- Route planning API client: `src/lib/spanshClient.ts`
- Used for: Neutron highway routes
- Full catalog: `galaxy_systems` (import `scripts/import-spansh-systems.mjs`,
  see SPANSH-IMPORT.md). Atlas star candidates and the route finder prefer
  this table. `/system/[name]` falls back to the catalog when there is no
  construction row. The map layer «Все системы» reads `edgs-v1` from
  `public/data` or storage bucket `galaxy-data`; it does not raycast 1.3M
  points. Migration `20260924000000_galaxy_systems_finish.sql`.

### 8.5 Raven Colonial
- Sync API: `/api/ravencolonial/sync`
- Used for: Colonial data synchronization

### 8.6 Colonial Helper uploader 2.2
- Source: `uploader/colonial_helper.py`
- Version: `2.3.0`
- Desktop token endpoint: `POST /api/logs/upload`
- Sends personal deliveries through `persistImportedDeliveries` into `deliveries`.
- Sends `ColonisationConstructionDepot` snapshots through the same endpoint
  into `colonisation_events` and `construction_depot_snapshots`.
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
  existing dossiers never shrink. `PARSER_VERSION = 3` forces a re-import of
  already-cached journals.
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
- `source_hash` and server upsert keys make retries idempotent.
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
- Fleet carrier cargo is reported to Raven Colonial from both `MarketSell`/
  `MarketBuy` and `CargoTransfer` (loading via the Transfer screen). The carrier
  is detected by MarketID in 3 700 000 000-3 800 000 000, by `CarrierID`, or by
  station type; commodity names are normalised to lower-case FDNames.
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
- HUD block management (2.3.0): each of the seven blocks (`route`, `status`,
  `ship`, `cargo`, `session`, `events`, `exobio`) has its own visibility,
  position lock, click-through (`WS_EX_TRANSPARENT` via ctypes), alpha, font
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
  dropped before upload (`ConstructionSnapshotCollector`).
- Site uploads are chunked and parallel: 100 deliveries per request / 100
  snapshots per request (server limit), up to 4 concurrent requests, with a
  progress callback. Startup reconciliation defers uploads and flushes them once
  at the end instead of per file.
- Uploaded-file cache `.colonial_helper_imported_files.json` stores
  `path -> {size, mtime, parser}` so repeated imports skip unchanged files. The
  parser version (`PARSER_VERSION` in `journal_parser.py`) invalidates the cache
  when extraction rules change.

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

### 8.7 Frontier Galnet
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
- Расписание: `galnet-sync.yml` — раз в сутки (06:20 UTC),
  `auto-translate.yml` — раз в 6 часов (догон очереди)
- Дедупликация по `nid` (UUID Drupal) и `guid`; изменение текста Frontier
  помечает статью к повторному переводу
- ВАЖНО: поле `field_galnet_date` («11 SEP 3312») — внутриигровая дата,
  в колонку `published_at` (TIMESTAMPTZ) не попадает

---

## 9. Environment Variables

```env
# Required
NEXT_PUBLIC_SUPABASE_URL=https://sgukfplhxdhmkqponwft.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIs...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIs...

# Optional
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_WEBHOOK_URL=...
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...

# Translation
YANDEX_TRANSLATE_API_KEY=...
YANDEX_TRANSLATE_FOLDER_ID=...
CRON_SECRET=...

# Galnet sync (scripts/galnet-sync.mjs)
GALNET_FEED_LIMIT=30
GALNET_TRANSLATE_LIMIT=10

# External APIs
RAVEN_API_BASE=...
```

---

## 10. Development Workflow

### 10.1 Local Development
```bash
pnpm install
pnpm dev        # localhost:3000
```

### 10.2 Database Changes
```bash
# Create migration
npx supabase migration new migration_name

# Edit migration in supabase/migrations/

# Apply to local
npx supabase db reset

# Apply to production
npx supabase db push
```

### 10.3 Build & Deploy
```bash
pnpm build      # Production build
# Build and deploy on the server; do not enable duplicate cron schedules.
docker compose --env-file .env.production up -d --build web jobs
```

### 10.4 Git Workflow
```bash
git add -A
git commit -m "feat: description"
git push origin main
```

---

## 11. Common Patterns

### 11.1 Server Component with Data
```tsx
export default async function Page() {
  const supabase = await createClient();
  const { data } = await supabase.from('table').select('*');
  return <Component data={data} />;
}
```

### 11.2 Client Component with Realtime
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

### 11.3 API Route with Auth
```tsx
import { createClient } from '@/lib/supabaseServer';
export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  // ...handle request
}
```

### 11.4 Icon Usage
```tsx
import { IconSquadron, IconSend } from '@/components/Icons';
<IconSquadron size={16} color="#e67e22" />
```

### 11.5 i18n Usage
```tsx
import { useI18n } from '@/lib/i18n/I18nContext';
const { t, locale, setLocale } = useI18n();
<div>{t('nav.home')}</div>
```

---

## 12. Troubleshooting

### Build fails with TypeScript error
- Check `next.config.js` has `typescript.ignoreBuildErrors: false`
- Run `pnpm build` locally before push

### Supabase connection fails
- Verify `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Check RLS policies allow the operation

### Realtime not working
- Verify channel name is unique per subscription
- Check filter syntax: `table=eq.value`
- Ensure table has realtime enabled in Supabase dashboard

### Migration fails
- Check migration order (sequential numbering)
- Use `npx supabase migration repair --status applied [version]`
- Verify no conflicting constraints

### Translation not working
- Verify `YANDEX_TRANSLATE_API_KEY` is set
- Check `CRON_SECRET` for cron endpoint auth

---

## 13. Key Decisions

1. **No UI library** — Custom components for full control over the HUD aesthetic
2. **No global state** — Server Components + Realtime cover 95% of needs
3. **Direct Supabase queries** — No ORM overhead, full SQL power
4. **App Router only** — No Pages Router, no hybrid approach
5. **Single CSS file** — `globals.css` is the single source of truth
6. **Custom icons** — No Lucide, no Heroicons — consistent stroke width and style
7. **TypeScript strict** — No `any`, no implicit returns
8. **Custom i18n** — No react-i18next, lightweight context-based solution

---

*End of Context Document. For design details, see DESIGN.md. For setup, see README.md.*
