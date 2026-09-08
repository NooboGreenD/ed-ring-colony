# ED Ring Colony — The Galaxy Ring Project

> Elite Dangerous colonization coordination platform.
> Live: https://ed-ring-colony.vercel.app
> Repo: https://github.com/NooboGreenD/ed-ring-colony

---

## About

ED Ring Colony is a web platform for coordinating colonization efforts in the game Elite Dangerous. It provides tools for squadron management, project planning, system atlas, community forum, wiki, real-time communication, and multi-language support.

## Features

- **Galaxy Map** — Interactive 3D visualization of the colonization ring (Three.js + React Three Fiber)
- **Squadrons** — Create and manage player squadrons with ranks, permissions, and dual-channel chat
- **Projects** — Plan and track colonization projects with route optimization
- **Forum** — Community discussions with markdown support, reactions, search, and moderation
- **Wiki** — Full wiki system with categories, tags, revisions, favorites, and colonization guides
- **Galnet** — Automatic sync of Frontier's Galnet news
- **Leaderboard** — Player statistics and achievements
- **Atlas** — System search, favorites, route finder, and candidate lists
- **Notifications** — Real-time in-app and push notifications (web-push)
- **Direct Chat** — Peer-to-peer messaging between players
- **Friends** — Friend list with online status
- **Comments** — Comment system on profiles and content
- **Admin Panel** — Raven Colonial sync, site content management, moderation
- **i18n** — Multi-language support (RU, EN, DE, IT, KO, ZH, JA, FR, ES, PT, PL, UK, NL, TR, AR, HE, HI, TH, VI, ID, CS, RO, HU, BG, SK, SL, HR, SR, LT, LV, ET, DA, SV, NO, FI, EL, GA, WA, CY, MT, IS, FO, AF, MS, SW, ZU, XH, SO, AM, OM, TI, HA, IG, YO, SN, RW, MG, ML, TA, TE, KA, MR, GU, PA, UR, FA, PS, KU, SD, NE, BO, DZ, LO, MY, KM, TG, UZ, KK, TG, KY, MN, MK, AL, SQ, MO, BE, UK, BA, TT, CV, CRH, KRC, ADY, KBD, CE, AV, LBE, LEZ, TAB, AB, KI, LAG, MG, MFE, SG, BI, TO, FJ, HO, MI, RAP, RAR, TVL, KI, PW, MH, FM, NA, NR, TO, TK, SM, AS, TV, NG, CK, PN, WF, NU, TK, KI, WS, TO, FJ, VU, SB, PG, TL, ID, MY, PH, VN, LA, KH, MM, BD, NP, BT, LK, MV, AF, PK, IN, LK, MV, BD, NP, BT, MM, LA, KH, VN, PH, MY, ID, TL, PG, SB, VU, FJ, WS, TO, TK, KI, NU, PN, CK, NG, TV, AS, SM, TK, TO, NR, NA, FM, MH, PW, KI, TVL, RAR, RAP, MI, HO, FJ, TO, BI, SG, MFE, MG, LAG, KI, AB, TAB, LEZ, LBE, AV, CE, KBD, ADY, KRC, CRH, CV, TT, BA, UK, BE, MO, SQ, AL, MK, MN, KY, TG, KK, UZ, TG, KM, MY, LO, DZ, BO, NE, SD, PS, FA, UR, PA, GU, MR, KA, TE, TA, ML, MG, RW, SN, YO, IG, HA, TI, OM, AM, SO, XH, ZU, SW, MS, AF, FO, IS, MT, CY, WA, GA, EL, FI, NO, SV, DA, ET, LV, LT, HR, SR, SL, SK, BG, HU, RO, CS, ID, VI, TH, HI, HE, AR, TR, NL, PL, PT, ES, FR, IT, DE, EN, RU)
- **Yandex Translate** — Automatic content translation via cron jobs

## Tech Stack

- **Framework**: Next.js 14.2.5 (App Router)
- **Language**: TypeScript 5 (strict mode)
- **Styling**: Tailwind CSS 4.3.3 + custom CSS (`globals.css`, `forum-extra.css`)
- **Database**: Supabase (PostgreSQL + Realtime)
- **Auth**: Supabase Auth (Email + Discord OAuth)
- **3D**: Three.js 0.185.1 + React Three Fiber 8.18.0 + Drei 9.122.0
- **Push**: web-push 3.6.7
- **Markdown**: react-markdown 10.1.0 + remark-gfm + rehype-sanitize
- **Validation**: zod 4.4.3
- **Cache**: lru-cache 11.5.2
- **i18n**: Custom React context (`lib/i18n/`)

## Quick Start

### Prerequisites
- Node.js 20+
- pnpm
- Supabase CLI (optional, for database management)

### Installation

```bash
# Clone repository
git clone https://github.com/NooboGreenD/ed-ring-colony.git
cd ed-ring-colony

# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your Supabase credentials
```

### Environment Variables

```env
# Required
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Optional
DISCORD_CLIENT_ID=your-discord-client-id
DISCORD_CLIENT_SECRET=your-discord-client-secret
DISCORD_WEBHOOK_URL=your-discord-webhook-url
NEXT_PUBLIC_VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key

# Translation
YANDEX_TRANSLATE_API_KEY=your-yandex-key
CRON_SECRET=your-cron-secret-min-32-chars

# External APIs
RAVEN_API_BASE=https://ravencolonial...
```

### Run

```bash
pnpm dev        # localhost:3000
pnpm build      # Production build
```

## Database Setup

```bash
# Link your project
npx supabase link --project-ref your-project-ref

# Apply migrations
npx supabase db push
```

Migrations are in `supabase/migrations/`. Enable Realtime for: `squadron_chat_messages`, `user_notifications`, `forum_threads`, `forum_posts`.

## Project Structure

```
ed-ring-colony/
  src/
    app/                    # Next.js App Router pages
      layout.tsx            # Root layout (topbar + sidebar + footer)
      page.tsx              # Homepage
      [route]/              # Route pages
      api/                  # API routes
    components/             # React components
      Icons.tsx             # Custom SVG icons
      SquadronChat.tsx      # Squadron chat
      DirectChat.tsx        # P2P messaging
      NotificationBell.tsx  # Notifications
      Sidebar.tsx           # Navigation
      Starfield.tsx         # Canvas starfield
      GalaxyMap/            # 3D map components
      Forum/                # Forum components
      Wiki/                 # Wiki components
      Atlas/                # Atlas components
      Projects/             # Project components
      Admin/                # Admin components
      Comments/             # Comment components
    lib/                    # Utilities
      supabaseClient.ts     # Browser Supabase client
      supabaseServer.ts     # Server Supabase client
      supabaseAdmin.ts      # Service role client
      i18n/                 # i18n context & translations
      translate.ts          # Yandex Translate API
      ravenColonial.ts      # Raven Colonial API
      spanshClient.ts       # Spansh route planning
      eddnClient.ts         # EDDN ingestion
      pushNotifications.ts  # Push notification utils
      routeEngine.ts        # Route engine
      journalParser.ts      # ED journal parser
    types/                  # TypeScript types
  supabase/
    migrations/             # SQL migrations
  public/                   # Static assets
  scripts/                  # Utility scripts
  DESIGN.md                 # Design system documentation
  CONTEXT.md                # Architecture documentation
```

## API Routes

### Squadron Endpoints
- `GET /api/squadrons` — List squadrons
- `POST /api/squadrons` — Create squadron
- `GET /api/squadrons/[id]` — Get squadron
- `PATCH /api/squadrons/[id]` — Update squadron
- `GET /api/squadrons/[id]/members` — List members
- `POST /api/squadrons/[id]/members` — Add member
- `GET /api/squadrons/[id]/chat` — Get chat messages
- `POST /api/squadrons/[id]/chat` — Send message
- `DELETE /api/squadrons/[id]/chat/[msgId]` — Delete message

### Project Endpoints
- `GET /api/projects` — List projects
- `POST /api/projects` — Create project
- `GET /api/projects/[id]` — Get project
- `PATCH /api/projects/[id]` — Update project

### Forum Endpoints
- `GET /api/forum/categories` — List categories
- `GET /api/forum/threads` — List threads
- `POST /api/forum/threads` — Create thread
- `GET /api/forum/posts` — List posts
- `POST /api/forum/posts` — Create post
- `POST /api/forum/reactions` — Add reaction

### Wiki Endpoints
- `GET /api/wiki/articles` — List articles
- `POST /api/wiki/articles` — Create article
- `GET /api/wiki/articles/[slug]` — Get article
- `GET /api/wiki/categories` — List categories
- `GET /api/wiki/tags` — List tags
- `GET /api/wiki/search` — Search wiki

### Other Endpoints
- `GET /api/leaderboard` — Player stats
- `GET /api/atlas/search` — System search
- `GET /api/galnet` — Galnet news
- `GET /api/news` — Site news
- `GET /api/notifications` — User notifications
- `POST /api/push/subscribe` — Push subscription
- `POST /api/eddn` — EDDN ingestion
- `POST /api/ravencolonial/sync` — Raven sync
- `POST /api/translate` — Translate content
- `POST /api/cron/translate` — Cron translation job

## Deployment

### Vercel (Recommended)

1. Connect GitHub repository to Vercel
2. Set environment variables in Vercel dashboard
3. Deploy on every push to `main`

### Manual

```bash
pnpm build
# Upload .next/ folder to your hosting
```

## Design System

See [DESIGN.md](DESIGN.md) for:
- Color palette
- Typography
- Component specifications
- Layout rules
- Animation guidelines

## Architecture

See [CONTEXT.md](CONTEXT.md) for:
- Tech stack details
- Database schema
- API route documentation
- Component hierarchy
- State management patterns
- External integrations

## License

MIT

## Credits

- Elite Dangerous by Frontier Developments
- EDSM for system data
- EDDN for real-time data
- Spansh for route planning
- Raven Colonial for colonial data
- Yandex Translate for i18n

---

*For questions or issues, open a GitHub issue or contact the maintainers.*
