# ED Ring Colony — Project Context & Architecture

> **Living document for developers and AI assistants.**
> Last updated: 2026-09-12.
> Uploader release: 2.2.0.
> Project: https://github.com/NooboGreenD/ed-ring-colony
> Live: https://ed-ring-colony.vercel.app

---

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
| Framework | Next.js | 14.2.5 | App Router only |
| Language | TypeScript | 5.x | Strict mode |
| Styling | Tailwind CSS | 4.3.3 | + custom CSS in globals.css, forum-extra.css |
| UI Library | None | — | Custom components only |
| Icons | Custom SVG | — | src/components/Icons.tsx |
| 3D | Three.js + R3F | 0.185.1 | Galaxy map only |
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
| CmdrDossier | `components/CmdrDossier.tsx` | Server | Player profile |
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

### 8.5 Raven Colonial
- Sync API: `/api/ravencolonial/sync`
- Used for: Colonial data synchronization

### 8.6 Colonial Helper uploader 2.2
- Source: `uploader/colonial_helper.py`
- Version: `2.2.0`
- Desktop token endpoint: `POST /api/logs/upload`
- Sends personal deliveries through `persistImportedDeliveries` into `deliveries`.
- Sends `ColonisationConstructionDepot` snapshots through the same endpoint
  into `colonisation_events` and `construction_depot_snapshots`.
- Delivery semantics:
  - `ColonisationContribution` is a direct per-event construction delta;
  - Fleet Carrier `MarketSell` is FC cargo `+Count`;
  - Fleet Carrier `MarketBuy` is FC cargo `-Count` and is not a project delivery;
  - ordinary station sales are not construction deliveries.
- The uploader never sends raw Journal files to the website. It sends structured
  delivery/snapshot records and keeps local byte offsets in
  `.colonial_helper_journal_offsets.json`.
- Startup reconciliation processes unhandled bytes and shows byte/file progress
  in the desktop progress bar. Rotation is detected when file size decreases.
- `source_hash` and server upsert keys make retries idempotent.
- EDSM and Inara are independent external integrations and do not use the ED
  Ring Colony token.
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
  clamping. Named layout profiles (positions, sizes, visibility, alpha, font)
  are stored in `config.json` under `profiles`.
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
- The uploader has a `Пилот` tab with local, live-updating cards.
- It displays commander/connection state, current system and ship, route
  progress, hull/shields/fuel/power, modules, cargo, balance/rebuy/legal state,
  session delivery totals, visited systems and last journal event.
- Refresh runs on the Tk main loop every second and never performs network
  requests. It is deliberately tolerant of incomplete state while the first
  Journal reconciliation is running.

### 8.8 Yandex Translate
- API: `src/lib/translate.ts`
- Used for: Automatic content translation
- Cron endpoint: `/api/cron/translate`

### 8.7 Frontier Galnet
- RSS/API ingestion
- Stored in `galnet_news` table
- Displayed on homepage and `/galnet`

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
CRON_SECRET=...

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
# Vercel auto-deploys on git push to main
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
