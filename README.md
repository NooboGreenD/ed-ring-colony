# ED Ring Colony — The Galaxy Ring Project

> Elite Dangerous colonization coordination platform.
> Live: https://edringcolony.ru
> Repo: https://github.com/NooboGreenD/ed-ring-colony

---

## После переезда на собственный сервер

**Команда для Ubuntu 20.04: [UBUNTU20-UPGRADE.md](UBUNTU20-UPGRADE.md).**
Подробности изменений: [POST-MIGRATION.md](POST-MIGRATION.md).
Сайт и Supabase работают на `edringcolony.ru` / `supabase.edringcolony.ru`.
Для всех шести фоновых задач подготовлен Docker-сервис `jobs`; в этой ветке GitHub Actions оставлен
только для EXE Uploader. В инструкции — Discord, дополнительные способы входа,
порядок переключения без двойных расписаний, подтверждение почты и откат.
Next.js 16 / React 19; существующие пароли и UUID сохраняются. Само изменение
ветки не обновляет production и не отключает расписания на default branch.

## About

ED Ring Colony is a web platform for coordinating colonization efforts in the game Elite Dangerous. It provides tools for squadron management, project planning, system atlas, community forum, wiki, real-time communication, and multi-language support.

## Features

- **Galaxy Map** — Interactive 3D visualization of the colonization ring (Three.js + React Three Fiber)
- **System Map** — 3D orrery of one system (`/system/[name]`, `components/SystemPlotlyMap.tsx`): орбиты строятся
  по настоящим элементам из журнала/EDSM — уравнение Кеплера, эллипс со звездой в фокусе, наклонение и аргумент
  перицентра, положение тела по средней аномалии; цвет звезды считается по её температуре, размер — по
  настоящему радиусу. Плюс планета-сфера с постройками на поверхности, фокус-зум по телам (кластер →
  окрестность → поверхность), LOD подписей для систем с десятками звёзд, карточка фокуса с фактами тела и
  списком станций/строек. Общая раскладка живёт в `lib/systemOrrery.ts` и зеркалится в `uploader/orrery.py`,
  чтобы сайт и десктоп рисовали одинаково
- **Pilot Dossier** — раздельные блоки «весь перевозимый груз» и «тоннаж на стройплощадки», а внутри —
  структура перевозок по назначению: стройплощадки и колонизационные корабли отдельно от авианосцев, миссий,
  powerplay, спасательных рейсов и продаж на рынке. Видимость блоков (баланс, ранги, груз, доставки, позиция)
  пилот настраивает сам
- **Frontier CAPI** — досье заполняется из Companion API по потоку **PKCE**, поэтому Shared Key от FDEV не
  требуется: нужен только `FRONTIER_REDIRECT_URI`, а `FRONTIER_CLIENT_ID` опционален (по умолчанию — ключ
  приложения «ED Ring Colony» `0d6027a7-2561-4e1b-af2e-2fe71b296bdd`, общий для сайта и Colonial Helper). Десктопный Colonial Helper авторизуется сам и присылает
  профиль на сайт
- **Log Import** — разбор журналов и в браузере (`/account`), и в десктопном uploader'е идёт по одним и тем же
  правилам и в одни и те же таблицы: доставки, snapshots строек, сканы тел, сводка пилота
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

- **Framework**: Next.js 16.3.5 / React 19.2.8 (App Router)
- **Language**: TypeScript 5 (strict mode)
- **Styling**: Tailwind CSS 4.3.3 + custom CSS (`globals.css`, `forum-extra.css`)
- **Database**: Supabase (PostgreSQL + Realtime)
- **Auth**: Supabase Auth (verified Email + Discord; opt-in Google/GitHub) + VK ID (собственный OAuth 2.1/PKCE-поток, см. SELFHOST.md)
- **3D**: Three.js 0.185.1 + React Three Fiber 9.7.0 + Drei 10.7.8
- **Push**: web-push 3.6.7
- **Markdown**: react-markdown 10.1.0 + remark-gfm + rehype-sanitize
- **Validation**: zod 4.4.3
- **Cache**: lru-cache 11.5.2
- **i18n**: Custom React context (`lib/i18n/`)

## Quick Start

### Prerequisites
- Node.js 22.18+
- npm (в репозитории есть package-lock.json)
- Supabase CLI (optional, for database management)

### Installation

```bash
# Clone repository
git clone https://github.com/NooboGreenD/ed-ring-colony.git
cd ed-ring-colony

# Install dependencies
npm ci

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your Supabase credentials
```

### Environment Variables

The repository includes a safe, placeholder-only [`.env.example`](.env.example). Copy it to the ignored `.env.local` file and keep all real or temporary credentials there. Never expose a service-role, CLI access token, or database password through a `NEXT_PUBLIC_` variable.

```env
# Required
NEXT_PUBLIC_SITE_URL=https://edringcolony.ru
NEXT_PUBLIC_SUPABASE_URL=https://supabase.edringcolony.ru
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Optional
AUTH_OAUTH_PROVIDERS=discord
# OAuth client secrets belong in the Supabase Auth stack, not the website.
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

For the existing self-hosted installation, preserve `auth.users`, identities,
profiles and API tokens. This update adds **no SQL migrations**; do not re-run
`full_schema.sql`. See [POST-MIGRATION.md](POST-MIGRATION.md).
The CLI linking example below is for a **hosted Supabase project**; a self-hosted
DB uses a direct connection (`--db-url`) or reviewed SQL via local `psql`.

For a remote migration deployment, set these temporary, **server-only** values in `.env.local` in addition to the application values:

```env
SUPABASE_PROJECT_REF=your-project-ref
SUPABASE_ACCESS_TOKEN=temporary-cli-access-token
SUPABASE_DB_PASSWORD=temporary-database-password
# Or use SUPABASE_DB_URL for a direct, percent-encoded connection URL.
```

Load the ignored local configuration into the current shell without printing it, then link and push:

```bash
set -a
. ./.env.local
set +a

# Link your project (only needed once per checkout)
npx supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"

# Preview pending migrations first
npx supabase db push --dry-run --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"

# Apply migrations only after reviewing the dry run
npx supabase db push --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
```

If using a direct database connection instead, use `npx supabase db push --db-url "$SUPABASE_DB_URL"`. Migrations are in `supabase/migrations/`. Enable Realtime for: `squadron_chat_messages`, `user_notifications`, `forum_threads`, `forum_posts`.

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
      SystemPlotlyMap.tsx   # 3D system orrery for /system/[name]
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
      journalParser.ts      # ED journal parser (deliveries + construction flag)
      journalTelemetry.ts   # Journal telemetry: depot snapshots, body scans, pilot stats
      dossierCargo.ts       # Pure cargo math for the pilot dossier (all cargo vs site tonnage)
      systemOrrery.ts       # Pure system-map layout engine (mirrored by uploader/orrery.py)
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

### Galnet Endpoints
- `GET /api/galnet` — Список статей Galnet (`?locale=ru&limit=100`)
- `POST /api/galnet` — Синхронизация ленты + перевод новых статей (cron)
- `PATCH /api/galnet` — Догон очереди переводов (cron)
- `GET /api/galnet/[nid]` — Одна статья (по `nid`, `guid` или `slug`)

### Other Endpoints
- `GET /api/leaderboard` — Player stats
- `GET /api/atlas/search` — System search
- `GET /api/news` — Site news
- `GET /api/notifications` — User notifications
- `POST /api/push/subscribe` — Push subscription
- `POST /api/eddn` — EDDN ingestion
- `POST /api/ravencolonial/sync` — Raven sync
- `POST /api/logs/upload` — token-authenticated uploader deliveries and construction snapshots
- `POST /api/journal/import` — authenticated browser/CAPI Journal import
- `POST /api/translate` — Translate content
- `POST /api/cron/translate` — Cron translation job

## Galnet Sync

Новости Galnet забираются с официального JSON:API Frontier
(`https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article`), складываются
в таблицу `galnet_news` и автоматически переводятся через
Yandex Cloud Translate API v2 на ru/en/de/it/ko/zh/ja.

Расписание на своём сервере (`scripts/server-jobs.mjs`, Docker-сервис `jobs`):

| Задача | Расписание | Что делает |
|--------|------------|------------|
| `galnet-sync` | раз в сутки, 06:20 UTC | синхронизация ленты + догон переводов |
| `translate` | раз в 6 часов, на 40-й минуте | очередь переводов (`news`, `galnet_news`) |

Scheduler вызывает защищённые API внутри Docker-сети с `CRON_SECRET`.
Для ручной диагностики остался CLI, работающий с БД напрямую:

```bash
node scripts/galnet-sync.mjs                  # синхронизация + перевод
node scripts/galnet-sync.mjs --dry-run        # только разбор ленты, без записи в БД
node scripts/galnet-sync.mjs --translate-only # только очередь переводов
node scripts/galnet-sync.mjs --no-translate   # только синхронизация
```

Нужные серверные переменные для CLI: `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `YANDEX_TRANSLATE_API_KEY`
(опционально `YANDEX_TRANSLATE_FOLDER_ID`, `YANDEX_TRANSLATE_IAM_TOKEN`).

### Если переводы не появляются

Перевод выполняет контейнер `web` (по запросу планировщика `jobs`), поэтому
ключ Yandex должен быть в окружении именно сервиса `web`. Порядок проверки:

```bash
# 1. Ключ виден внутри web? (после deploy/selfhost/upgrade.py env_file не используется —
#    ключ должен быть в `environment` сервиса web в docker-compose.yml)
docker compose exec web sh -c 'env | grep -c YANDEX_TRANSLATE'

# 2. Что говорит планировщик: event:"skipped"/"warning" = нет ключа, event:"failure" = ошибка API
docker compose logs --since 48h jobs | grep -E '"job":"(translate|galnet-sync)"'

# 3. Размер очереди и конфигурация переводчика
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  'http://127.0.0.1:3000/api/galnet?limit=1' | jq '{translateConfigured, pendingGalnetTranslations, errors}'

# 4. Ручной догон очереди с подробными ошибками Yandex (401/403 — ключ, 429 — квота)
docker compose exec web node scripts/galnet-sync.mjs --translate-only
```

Типичные причины: ключ был только в `.env.production` и потерялся при обновлении
(теперь `upgrade.py` переносит его из работающего контейнера); для API-ключа
сервисного аккаунта нужна роль `ai.translate.user`; исчерпана квота символов
(429 — статьи остаются `failed` и будут повторно взяты следующим запуском —
свежие статьи обрабатываются первыми).

Тесты парсера и синхронизации (сеть не нужна):

```bash
npm test
```

## Colonial Helper uploader 2.10.25

В репозитории находится Windows/Python uploader `uploader/colonial_helper.py`
для загрузки данных Elite Dangerous на ED Ring Colony.

### Какие данные принимает сайт

- персональные доставки для leaderboard: прямые
  `ColonisationContribution`, `CargoDepot`, доставка на Fleet Carrier и
  подтверждённые уменьшения корабельного Cargo;
- общие события `ColonisationConstructionDepot`: состояние стройки,
  требования ресурсов, прогресс, construction ID, MarketID, система и время;
- повторные доставки не дублируются благодаря `source_hash`, а события
  стройки используют серверную дедупликацию.

Каждая доставка несёт объяснение своего происхождения, поэтому досье может
делить «весь груз» и «груз на стройплощадки» без догадок (`source`,
`is_construction`, `market_id` — миграция
`supabase/migrations/20260917000000_deliveries_transport_scope.sql`).
`is_construction` выставляет парсер журнала: `ColonisationContribution` и
`CargoDepot` — всегда стройка, `cargo_delta` — только если игрок стоял у рынка,
про который журнал показывал `ColonisationConstructionDepot`, а отгрузка на
авианосец, грузовые миссии, Powerplay и Search-and-Rescue — просто перевозка.
Исторические строки имеют `is_construction IS NULL` и считаются стройкой,
иначе старые профили обнулились бы. Если колонки ещё не применены, сервер
откатывается к базовому набору полей и загрузка продолжается.

Браузерная загрузка (`/account` → `POST /api/logs/import`) и десктопный
uploader отправляют один и тот же набор данных: помимо доставок это snapshots
строек, сканы тел (`system_scans`) и сводка пилота (`pilot_stats`). Разбор
делается одним проходом по журналу — `lib/journalParser.ts` считает доставки и
одновременно кормит событиями `lib/journalTelemetry.ts`.

`MarketBuy` с Fleet Carrier уменьшает его запас и не считается доставкой на
проект. Обычные продажи на станции не загружаются как construction delivery.
Ключи Raven Colonial, EDSM и Inara хранятся только локально у пользователя.

Для Journal reconciliation uploader хранит только локальные byte offsets:
`.colonial_helper_journal_offsets.json`. Сырые журналы на сайт не передаются;
передаются только необходимые структурированные данные. При первичной загрузке
progress bar показывает процент по байтам, файлы, объём и текущий журнал.

## Deployment

### Собственный сервер (Docker Compose)

```bash
# При обновлении существующего сервера НЕ перезаписывайте рабочий env-файл.
docker compose --env-file .env.production build web jobs
docker compose --env-file .env.production up -d web jobs
docker compose --env-file .env.production logs --tail=100 jobs
```

Перед первым запуском `jobs` отключите старые Actions/cron, сохранив задания
резервного копирования. Подробности и Supabase Auth override —
[POST-MIGRATION.md](POST-MIGRATION.md). Vercel git deployment отключён в
`vercel.json`. Для нового сервера см. `SELFHOST.md`.

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
