# ED Ring Colony

> Elite Dangerous colonization coordination platform.
> https://ed-ring-colony.vercel.app

---

## About

ED Ring Colony is a web platform for coordinating colonization efforts in the game Elite Dangerous. It provides tools for squadron management, project planning, system atlas, community forum, and real-time communication.

## Features

- **Galaxy Map** — Interactive 3D visualization of the colonization ring
- **Squadrons** — Create and manage player squadrons with ranks, permissions, and chat
- **Projects** — Plan and track colonization projects with route optimization
- **Forum** — Community discussions with markdown support and reactions
- **Leaderboard** — Player statistics and achievements
- **Atlas** — System search, favorites, and route finder
- **Notifications** — Real-time in-app and push notifications
- **Direct Chat** — Peer-to-peer messaging between players
- **Journal Import** — Parse Elite Dangerous Player Journal for colonisation events
- **Frontier CAPI** — OAuth sync of CMDR profile, ranks, ships, and location
- **Live Squadron Map** — Real-time member tracking on the Galaxy Map
- **Market Search** — Find best commodity prices via EDDN integration
- **Community Goals** — Track active CGs with colonisation filter
- **Fleet Carriers** — Manage squadron fleet carriers and their markets

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript 5 (strict mode)
- **Styling**: Tailwind CSS 4 + custom CSS
- **Database**: Supabase (PostgreSQL + Realtime)
- **Auth**: Supabase Auth (Email + Discord OAuth)
- **3D**: Three.js + React Three Fiber
- **Push**: web-push
- **Markdown**: react-markdown + remark-gfm

## Elite Dangerous API Integration

The platform integrates with multiple Elite Dangerous APIs:

| API | Purpose | Setup |
|-----|---------|-------|
| **Frontier CAPI** | CMDR profile, journal, fleet carrier sync | [Get credentials](https://auth.frontierstore.net/client/request) |
| **Inara** | Community Goals, CMDR lookup | [Get API key](https://inara.cz) → Profile → Settings → API |
| **EDDN** | Real-time market prices | Runs as standalone worker |
| **EDSM** | System coordinates, bodies | Already integrated |

### Required Environment Variables

Copy `.env.example` to `.env.local` and fill in:

```bash
# Frontier CAPI (required for profile sync)
FRONTIER_CLIENT_ID=your-frontier-client-id
FRONTIER_CLIENT_SECRET=your-frontier-client-secret
FRONTIER_REDIRECT_URI=https://ed-ring-colony.vercel.app/api/capi/callback

# Inara (required for Community Goals)
INARA_API_KEY=your-inara-api-key

# Security (generate with: openssl rand -hex 32)
CRON_SECRET=random-64-char-hex
EDDN_INGEST_SECRET=random-64-char-hex
```

### GitHub Actions Cron Jobs

Cron jobs are configured via GitHub Actions (see `.github/workflows/`):

| Workflow | Schedule | Purpose |
|----------|----------|---------|
| `cron-capi-sync.yml` | Every 5 min | Sync connected CMDR profiles |
| `cron-cg-check.yml` | Every 6 hours | Update Community Goals from Inara |
| `cron-eddn-cleanup.yml` | Every 6 hours | Clean old market price data |

Add these secrets to your GitHub repository:
- `CRON_SECRET` — same as in Vercel env
- `VERCEL_URL` — `https://ed-ring-colony.vercel.app`

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

# Run development server
pnpm dev
```

Open http://localhost:3000

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
```

## Database Setup

### Using Supabase CLI

```bash
# Link your project
npx supabase link --project-ref your-project-ref

# Apply migrations
npx supabase db push
```

### Using SQL Editor

1. Open Supabase Dashboard → SQL Editor
2. Run migrations from `supabase/migrations/` in order (000-022)
3. Enable Realtime for tables: `squadron_chat_messages`, `user_notifications`

## Project Structure

```
ed-ring-colony/
  src/
    app/                    # Next.js App Router pages
      layout.tsx            # Root layout
      page.tsx              # Homepage
      [route]/              # Route pages
      api/                  # API routes
    components/             # React components
      Icons.tsx             # Custom SVG icons
      SquadronChat.tsx      # Squadron chat
      NotificationBell.tsx  # Notifications
      Sidebar.tsx           # Navigation
      ...
    types/                  # TypeScript types
    lib/                    # Utilities
      supabaseClient.ts     # Browser Supabase client
      supabaseServer.ts     # Server Supabase client
    hooks/                  # Custom React hooks
  supabase/
    migrations/             # SQL migrations (000-022)
  public/                   # Static assets
  DESIGN.md                 # Design system documentation
  CONTEXT.md                # Architecture documentation
```

## Development

```bash
# Development server
pnpm dev

# Production build
pnpm build

# Type check
pnpm type-check

# Lint
pnpm lint
```

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

## API Documentation

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

### Other Endpoints
- `GET /api/leaderboard` — Player stats
- `GET /api/atlas/search` — System search
- `GET /api/notifications` — User notifications
- `POST /api/push/subscribe` — Push subscription

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit changes: `git commit -m "feat: my feature"`
4. Push to branch: `git push origin feat/my-feature`
5. Open a Pull Request

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
- Spanh for route planning
- Raven Colonial for colonial data

---

*For questions or issues, open a GitHub issue or contact the maintainers.*
