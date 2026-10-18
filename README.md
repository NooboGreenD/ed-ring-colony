# ED Ring Colony — The Galaxy Ring Project

> Elite Dangerous colonization coordination platform.
> Live: https://edringcolony.ru · Supabase: https://supabase.edringcolony.ru
> Repo: https://github.com/NooboGreenD/ed-ring-colony
>
> **Сайт 2.21.0 · Colonial Helper 2.16.0** · документация сверена с кодом 18.10.2026.
> Карта всех документов — **[DOCS.md](DOCS.md)**, устройство проекта — [CONTEXT.md](CONTEXT.md),
> история изменений — [CHANGELOG.md](CHANGELOG.md).

---

## Состояние проекта

* Сайт и Supabase работают на собственном сервере (Docker Compose): сервисы
  `web`, `jobs`, а в профиле `monitoring` — `monitor-agent` и `update-agent`.
  Vercel отключён (`vercel.json` → `deploymentEnabled: false`).
* **Обновление сервера** — Админка → Мониторинг → «Обновить сейчас»: git, бэкап
  БД, недостающие миграции, пересборка, переключение и проверка живости делает
  `deploy/update-project.sh` через `update-agent`. Подробно — [MONITORING.md](MONITORING.md).
* **Фоновые задачи** — сервис `jobs`: 10 задач, 9 включены по умолчанию (таблица
  ниже). GitHub Actions в проекте нет.
* **Colonial Helper** собирается, подписывается Ed25519 и публикуется самим
  сервером (Админка → Обновления Helper); установленные программы обновляются
  пакетом кода, а не новым EXE — [UPLOADER-UPDATE-STRUCTURE.md](UPLOADER-UPDATE-STRUCTURE.md).
* Существующие пароли, UUID пользователей и API-токены сохранены при переезде
  (сентябрь 2026) — [POST-MIGRATION.md](POST-MIGRATION.md).

## About

ED Ring Colony is a web platform for coordinating colonization efforts in the game Elite Dangerous. It provides tools for squadron management, project planning, a galaxy atlas with search, a system architect, fleet carrier tracking, PowerPlay and minor-faction maps, a ship builder, a community forum and wiki, real-time communication, and a desktop companion (Colonial Helper) that uploads journal data.

## Возможности

### Карта и Atlas

- **Galaxy Map** (`/map`) — 3D-карта кольца колонизации (Three.js + React Three Fiber): хабы, общий
  маршрут, пилоты, туманности, 42 региона, «Все системы ⚗» из каталога Spansh. Слой «Авианосцы» (и на
  `/map`, и в Atlas): носители значком как в игре, фильтр «мой / эскадрилья / другие» и «Drake / Javelin»,
  список «в каких системах», карточка системы и пунктир запланированного прыжка —
  [FLEET-CARRIERS.md](FLEET-CARRIERS.md#карта-галактики-и-atlas-web-2160). Устройство слоёв —
  [src/components/GalaxyMap/INTEGRATION.md](src/components/GalaxyMap/INTEGRATION.md)
- **Atlas** (`/atlas`) — восемь вкладок рядом с той же 3D-картой (Alt+1…Alt+8):
  «Поиск» миров по типам, «Маршрут» проекта, «Маршрут A→B», «Кольцо», «Рынок», «Поблизости»,
  «PowerPlay», «Фракции»; плюс «Галактические секторы» (`/atlas/sector`). Найденное сохраняется в базе
  проекта (`atlas_system_cache`, `atlas_body_cache`), поэтому повторный поиск в том же районе не ходит в
  EDSM/Spansh, а прогресс любого поиска виден на карте —
  [ATLAS-SEARCH-REWORK.md](ATLAS-SEARCH-REWORK.md).
  - Поиск галактического кольца идёт шагами с продолжением после обрыва связи, найденное кольцо остаётся
    на 3D-карте (контур, опорные точки, маршрут) до явной уборки; ключевые системы, наклон и центр кольца,
    уточнение реальными системами, поиск хабов у опор; маршрут сохраняется в проект эскадрильи вместе с
    координатами или выгружается в CSV — [ATLAS-RING-RESULT-FIX.md](ATLAS-RING-RESULT-FIX.md),
    [ATLAS-RING-LIMITS-FIX.md](ATLAS-RING-LIMITS-FIX.md).
  - «Рынок» — где купить материалы стройки, с выбором стройплощадки —
    [ATLAS-MARKET-FIX.md](ATLAS-MARKET-FIX.md); «Поблизости» — все системы в сфере/кубе 1–50 св. лет —
    [ATLAS-NEARBY-SEARCH.md](ATLAS-NEARBY-SEARCH.md).
  - «PowerPlay»: все системы под контролем держав PowerPlay 2.0 на 3D-карте (цвет — держава, форма —
    оплот / укреплённая / эксплуатируемая), фильтр по державам и состояниям, список с поиском и CSV,
    карточка системы с зонами влияния и проверка «чья зона?» для любой системы. Данные — ночной дамп EDSM,
    задача `powerplay-sync`, управление — Админка → Игровые данные → PowerPlay — [POWERPLAY.md](POWERPLAY.md).
  - «Фракции»: все населённые системы с минорными фракциями на 3D-карте (цвет — принадлежность), поиск
    фракций и показ систем одной или нескольких выбранных (у власти / несколько / присутствует), карточка
    системы со всеми фракциями и их влиянием. Данные — в базе проекта: дамп EDSM `systemsPopulated`
    (по очереди: архив скачивается на сервер целиком, затем разбивается на куски, затем куски пишутся в
    базу; соединения, которые «замораживает» сеть сервера, переходят на короткие запросы, а архив можно
    загрузить и с компьютера; управление и журнал — Админка → Игровые данные → Фракции, задача
    `factions-sync`) и обновления от Colonial Helper и загрузчика журналов — [FACTIONS.md](FACTIONS.md).
- **System Map** — 3D orrery of one system (`/system/[name]`, `components/SystemMap/SystemOrrery3D.tsx`):
  орбиты строятся по настоящим элементам из журнала/EDSM — уравнение Кеплера, эллипс со звездой в фокусе,
  наклонение и аргумент перицентра, положение тела по средней аномалии; цвет звезды считается по её
  температуре, размер — по настоящему радиусу. Движок three.js (`lib/orrery3d/`): сферы тел, кольца, полоса
  обитаемой зоны, постройки с дугой прогресса на поверхности, фокус-зум по телам (кластер → окрестность →
  поверхность), LOD подписей, подсказки наведением, фильтры и список тел, движение по орбитам на любую дату.
  Общая раскладка живёт в `lib/systemOrrery.ts` и зеркалится в `uploader/orrery.py`; пакет данных
  версионируется одним контрактом (`ORRERY_VIEW_VERSION` ↔ `uploader/system_view.py`), а Colonial Helper
  рисует ту же сцену прямо во вкладке «Карта системы» — холстом Tk (`uploader/tk_orrery.py`). Страница
  открывается и для систем без стройки, если они есть в каталоге. Сводный прогресс строек — `/systems`.
- **Каталог систем** — вся исследованная галактика (`galaxy_systems`, ~2×10⁸ строк) из дампа Spansh:
  опорные координаты и звёздные кандидаты Atlas, страница любой системы, облако точек карты —
  [SPANSH-IMPORT.md](SPANSH-IMPORT.md) и раздел ниже.

### Колонизация

- **System Architect** — `/architect` (тестовый режим): планировщик застройки системы по образцу
  инструмента проектирования из Raven Colonial. Считает наземные слоты тел (радиус, атмосфера, вулканизм,
  терраформирование, потолок 7), очки системы T2/T3 с «налогом» на дополнительные порты, цепочки
  предшественников, порядок стройки, сводный тоннаж грузов, оценку системы, эффекты и открываемые сервисы.
  Постройки привязаны к карточкам тел, где наземные и орбитальные разделены; орбитальные слоты планет и лун
  явно задаются по карте системы. В плане указывается ответственный архитектор системы, а любую запись можно
  отредактировать на месте; порт — дополнительно пометить «основным»: он не тратит очки системы, но требует
  собственный список материалов. План показывается на той же 3D-карте системы, выгружается в JSON и
  копируется сводкой; его можно сохранить на сервере (`system_plans`), опубликовать и поделиться ссылкой
  `/architect?plan=<id>`. Рядом — фактические стройплощадки системы (`/api/systems/progress`) и расчёт «где
  купить» по рынкам из собственной базы EDDN; прогресс сверяется параллельно со снимками Colonial Helper и
  Raven Colonial. Три вида — «Тела», «Таблица» и «Аналитика»; панель источников показывает, кто ответил:
  база проекта, EDSM, Spansh и Raven Colonial. Движок — `lib/architect/` (каталог из 55 построек + правила),
  подробности — [ARCHITECT.md](ARCHITECT.md)
- **Проекты систем** — `/architect/projects`: группы систем одного замысла, участники и модераторы,
  авианосцы проекта, прогресс по системам и лидеры по доставкам (`architect_projects*`) —
  [ARCHITECT.md](ARCHITECT.md)
- **Авианосцы** — учёт носителей на сайте (`fleet_carriers`): личный носитель привязывается сам по журналу
  (`CarrierStats`/`CarrierBuy`), вручную — по Carrier ID или позывному; эскадренный Javelin — через
  участников эскадрильи. Службы, стыковка, система, прыжок, трюм (снимки + дельты, хеши дельт считает
  сервер) и банк эскадры видны в профиле и на странице эскадрильи; оверлей Helper читает груз с сайта, а в
  Raven Colonial уходят исправленные значения — [FLEET-CARRIERS.md](FLEET-CARRIERS.md)
- **Projects** — проекты колонизации эскадрилий с маршрутом, системами и прогрессом (`/projects`)
- **Log Import** — разбор журналов и в браузере (личный кабинет `/account`), и в Colonial Helper идёт по одним и
  тем же правилам и в одни и те же таблицы: доставки, состояния стройплощадок, снимки прогресса, сканы тел,
  сводка пилота, авианосцы и фракции. Повторы доставок отсекает `source_hash`, и он считается побайтно
  одинаково в браузере (TS) и в Helper'е (Python), поэтому одни и те же журналы, загруженные обоими путями,
  не дублируются. «Перезагрузить логи с нуля» (кабинет или Helper → `POST /api/journal/reset`) очищает ранее
  загруженные данные пилота, после чего журналы пересчитываются заново. Состояние каждой стройплощадки хранится одной строкой
  (`colonisation_sites`, ключ — MarketID), снимки прогресса подрезает задача `colonisation-cleanup` (окно
  `COLONISATION_RETENTION_DAYS`). «Монеты наёмников» читаются из `Bank_Account.MercCoins_Current`. У сводки
  пилота (`pilot_stats`) хранится источник последней записи (`stats_source`: сайт / программа / CAPI) —
  [COLONISATION-SITES-REWORK.md](COLONISATION-SITES-REWORK.md),
  [CAPI-STABILITY-AND-STATS-SOURCE.md](CAPI-STABILITY-AND-STATS-SOURCE.md)
- **Станции и товары** — станции, рынки и снимки ассортимента в базе проекта (`station_commerce`), поиск
  товаров `/station-search` с фокусом на карте Atlas; данные приходят из Colonial Helper и дампов —
  [STATION-COMMERCE.md](STATION-COMMERCE.md)
- **Community Goals** — `/cg`: цели сообщества из Inara (задача `cg-check`)

### Пилот

- **Pilot Dossier** (`/cmdr/[name]`, список — `/cmdrs`) — раздельные блоки «весь перевозимый груз» и «тоннаж
  на стройплощадки», а внутри — структура перевозок по назначению: стройплощадки и колонизационные корабли
  отдельно от авианосцев, миссий, powerplay, спасательных рейсов и продаж на рынке. Видимость блоков
  (баланс, ранги, груз, доставки, позиция) пилот настраивает сам
- **Frontier CAPI** — досье заполняется из Companion API по потоку **PKCE**, поэтому Shared Key от FDEV не
  требуется: нужен только `FRONTIER_REDIRECT_URI`, а `FRONTIER_CLIENT_ID` опционален (по умолчанию — ключ
  приложения «ED Ring Colony» `0d6027a7-2561-4e1b-af2e-2fe71b296bdd`, общий для сайта и Colonial Helper).
  Привязка фиксируется сразу после обмена кода на токены, поэтому недоступный CAPI (техобслуживание `418`,
  аккаунт без входа в игру) даёт «привязано, данных пока нет», а не потерю связи; `/account/capi` показывает
  причину, срок действия токена и диагностику (`/api/capi/status`). Helper и сайт делят одну привязку через
  `/api/capi/token`, живой токен продлевается задачей `capi-sync`. Отказ CAPI в правах (`400`) после
  подтверждённого входа через EGS/Steam сохраняет OAuth — [CAPI-ENTITLEMENT-FIX.md](CAPI-ENTITLEMENT-FIX.md);
  история разборов — [CAPI-BINDING-FIX.md](CAPI-BINDING-FIX.md),
  [CAPI-PLATFORM-RELINK-FIX.md](CAPI-PLATFORM-RELINK-FIX.md)
- **Leaderboard** (`/leaderboard`) — тоннаж и достижения пилотов
- **Верфь (Outfitting)** — `/outfitting`: конструктор сборок кораблей по образцу coriolis.io на собственных
  расчётах. Все корпуса, слоты, переборки, модули, инженерные чертежи и **экспериментальные эффекты**;
  сводка считает массу, дальность прыжка, скорость и буст, щит с сопротивлениями, броню, баланс энергии,
  трюм и стоимость. Четыре вкладки — **сводка**, **атака** (DPS/SDPS, энергия и тепло), **защита** и
  **графики** (свой SVG). Управление кораблём (форсаж, орудия, груз и топливо), подсказки по модулям,
  перетаскивание и копирование модулей, обмен сборками с Coriolis/EDSY/Inara (SLEF, журнальный `Loadout`),
  снаряжение за Merc Coin. Сборка кодируется в ссылку `?b=<код>`, сохраняется в браузере и в профиле
  (`outfitting_builds`). Движок — `lib/outfitting/`, данные — `public/data/outfitting.json` из
  [EDCD/coriolis-data](https://github.com/EDCD/coriolis-data) (`scripts/build-outfitting-data.mjs`) плюс
  правки админки; все 60 экспериментальных эффектов сверены с EDSY и переведены на семь языков
- **Инженеры** — `/engineers`: дерево разблокировки (корабельная и наземная ветки), условия встречи,
  отметки пройденного и чертежи каждого инженера — те же данные, что у верфи
  (`/outfitting` ↔ `/engineers?engineer=<id>`)

### Сообщество

- **Squadrons** — эскадрильи со званиями и правами, оформлением (`branding`), чатом в двух каналах
  (общий + офицерский, Realtime) и голосовыми комнатами (WebRTC, `squadron_voice_*`)
- **Forum** — Community discussions with markdown support, reactions, subscriptions, search, and moderation
- **Wiki** — Full wiki system with categories, tags, revisions, favorites, and colonization guides
  (`public/wiki/colonization-guide/`)
- **News** и **Galnet** — новости сайта и автоматическая синхронизация Galnet с переводами
- **Notifications** — Real-time in-app and push notifications (web-push)
- **Direct Chat**, **Friends**, **Comments** — личные сообщения, друзья с онлайн-статусом, комментарии
  (вкладка кабинета «Сообщения и друзья», `/account/friends`)
- **Support** — тикеты техподдержки с вложениями (`/support`, разбор — Админка → Поддержка)
- **Премиум и платежи** — магазин косметики и почётных титулов (`/premium-shop`), подписки, кредиты;
  провайдер Т-Банк (по умолчанию выключен) — [TBANK-SETUP.md](TBANK-SETUP.md); оферта `/offer`,
  реквизиты `/details`

### Администрирование

- **Admin Panel** — `/admin`, четыре группы вкладок:
  - «Контент сайта»: контент главной, новости;
  - «Сообщество»: управление (пользователи и роли, модерация доставок), форум, комментарии, поддержка;
  - «Игровые данные»: верфь ([OUTFITTING-ADMIN.md](OUTFITTING-ADMIN.md)), хабы, маршрут, RavenColonial,
    «Каталог систем», PowerPlay, «Фракции»;
  - «Система и сервисы»: биллинг, мониторинг (+ обновление проекта и ключи `.env.production`), бэкапы,
    авторизация (кнопки входа, SMTP), обновления Helper.
- **Mobile Admin** — `/m-admin` PWA-ready HUD dashboard with 9 tabs (Overview, Monitor, Billing, Systems,
  Content, Users, Support, Backup, Auth), auto-refresh 20s, bottom nav —
  [MOBILE-ADMIN.md](MOBILE-ADMIN.md)
- **Android App** — Native Kotlin + Jetpack Compose monitor app in `android-app/` (тот же агрегатор
  `/api/mobile/admin-summary`). **Сейчас не собирается** — см. «Известная проблема» в
  [android-app/README.md](android-app/README.md)
- **i18n** — интерфейс на 7 языках: ru, en, de, it, ko, zh, ja (свой контекст `lib/i18n/`); новости,
  Galnet и тексты главной переводятся Yandex Translate (задачи `translate` и `galnet-sync`)

## Tech Stack

- **Framework**: Next.js 16.3.5 / React 19.2.8 (App Router, `output: 'standalone'`, `src/proxy.ts` вместо middleware)
- **Language**: TypeScript 5 (strict) · Python 3.10+ (Colonial Helper, Tk + ttkbootstrap) · Kotlin 1.9 (Android)
- **Styling**: Tailwind CSS 4.3.3 + `src/app/globals.css` + `src/styles/forum-extra.css` + CSS-модули админки; Jetpack Compose Material3 (Android)
- **Database**: self-hosted Supabase (PostgreSQL + PostgREST + Realtime + Storage, шлюз Kong за тем же доменом сайта) + прямой Postgres (`pg`, `pg-copy-streams`) для тяжёлых импортов
- **Auth**: Supabase Auth (подтверждённая почта + Discord; Google/GitHub — opt-in) + VK ID и Яндекс ID (собственные OAuth/PKCE-потоки сайта, выключены по умолчанию — [VK-ID-SETUP.md](VK-ID-SETUP.md), [YANDEX-ID-SETUP.md](YANDEX-ID-SETUP.md)); кнопки входа и SMTP — Админка → Авторизация; Bearer JWT для Android; API-токены `rc_…` для Colonial Helper
- **3D**: Three.js 0.185.1 + React Three Fiber 9.7.0 + Drei 10.7.8
- **Push**: web-push 3.6.7
- **Markdown**: react-markdown 10.1.0 + remark-gfm + rehype-sanitize
- **Validation**: zod 4.4.3 · **Cache**: lru-cache 11.5.2 · **i18n**: свой React-контекст (`lib/i18n/`)
- **Tests**: `node:test` + jsdom + esbuild-бандлы + PGlite (Postgres в процессе) + libpg-query; Playwright 1.63 для браузерных сценариев; `unittest` для Helper'а
- **Mobile**: PWA `/m-admin` + Native Android `android-app/` (Kotlin, Compose, Retrofit, EncryptedSharedPreferences, Navigation Compose)

## Quick Start

### Prerequisites
- Node.js 22.18+ и npm (в репозитории `package-lock.json`; pnpm/yarn не используются)
- Python 3.10+ — только для Colonial Helper (`uploader/`)
- Supabase CLI — опционально, для управления базой

### Installation

```bash
git clone https://github.com/NooboGreenD/ed-ring-colony.git
cd ed-ring-colony
npm ci
cp .env.example .env.local   # заполните значения Supabase
```

### Environment Variables

The repository includes a safe, placeholder-only [`.env.example`](.env.example) — полный справочник всех
переменных с пояснениями. Copy it to the ignored `.env.local` file (на сервере — `.env.production`) and keep
all real or temporary credentials there. Never expose a service-role, CLI access token, or database password
through a `NEXT_PUBLIC_` variable.

```env
# Required
NEXT_PUBLIC_SITE_URL=https://edringcolony.ru
NEXT_PUBLIC_SUPABASE_URL=https://supabase.edringcolony.ru
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
CRON_SECRET=your-cron-secret-min-32-chars

# Optional
AUTH_OAUTH_PROVIDERS=discord
# OAuth client secrets belong in the Supabase Auth stack, not the website.
DATABASE_URL=postgres://...            # прямой Postgres для импортов (каталог систем, фракции)
DISCORD_WEBHOOK_URL=your-discord-webhook-url
NEXT_PUBLIC_VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
YANDEX_TRANSLATE_API_KEY=your-yandex-key
INARA_API_KEY=...                      # Community Goals
JOBS_ENABLED=capi-sync,update-progress,cg-check,eddn-cleanup,colonisation-cleanup,galnet-sync,translate,powerplay-sync,factions-sync
```

Группы переменных (каталог систем `GALAXY_*`, PowerPlay `POWERPLAY_*`, фракции `FACTIONS_*`, обновление
`UPDATE_*`/`PROJECT_*`, мониторинг `MONITOR_*`, Helper `UPLOADER_*`, Frontier `FRONTIER_*`/`CAPI_*`,
платежи, VK/Яндекс) описаны в `.env.example` и в CONTEXT.md, раздел «Environment Variables».

### Run

```bash
npm run dev        # http://localhost:3000
npm run build      # production build (standalone)
npm run start      # запустить собранное
npm run typecheck  # next typegen + tsc --noEmit
```

### Тесты

```bash
npm run test:quick    # быстрый контур: без jsdom-рендеров и shell-интеграций (1263 проверки, ~1 мин)
npm test              # весь набор: 142 файла, 1520 проверок (~1,5–2 мин на 2 ядрах)
npm run test:list     # какие файлы есть и к какому контуру они относятся
node scripts/run-tests.mjs atlas ring    # только файлы про Atlas и кольцо
npm run test:browser  # Playwright-сценарии tests/browser/*.spec.ts (нужен запущенный сайт)
python -m unittest discover -s uploader/tests   # тесты Colonial Helper
```

Набор гоняется параллельно по файлам (`scripts/run-tests.mjs`), сборки esbuild для тестов кэшируются в
`.cache/test-bundles`, база в тестах — PGlite. Тот же `npm test` выполняется при сборке Docker-образа `web`
(`RUN_TESTS=1`). Подробности — [TEST-SUITE-SPEED.md](TEST-SUITE-SPEED.md).

**Известные падения (на 18.10.2026):** 6 проверок галактического кольца, написанных до переработки кольца
в #122–#128: 4 в `scripts/tests/atlas-ring-constraints.test.mjs` (выбор и шаг опоры, проверка маршрута)
и по одной в `atlas-search-map.test.mjs` и `atlas-ui-dom.test.mjs` (подписи «Копировать текстом»). Они
падают и на `main`; остальные 1514 проходят.

## Database Setup

**Существующая установка.** Сохраняйте `auth.users`, identities, `profiles` и API-токены; не запускайте
`supabase/full_schema.sql` на живой базе. Недостающие миграции применяет сам сервер: кнопка «Обновить
сейчас» (флажок «с миграциями») или «Применить только миграции» в Админка → Мониторинг —
`deploy/update-project.sh` накатывает все файлы `supabase/migrations/*.sql`, которых ещё нет в
`migrations.mark`, по алфавиту, после бэкапа БД.

**Новая установка.** `supabase/full_schema.sql` (все 86 миграций одним файлом) или
`npx supabase db push` — подробно в [supabase/DATABASE.md](supabase/DATABASE.md). Каталог систем
требует отдельной загрузки дампа — [SPANSH-IMPORT.md](SPANSH-IMPORT.md).

Если Galnet-новости не переводятся, а в очереди висят `pending`-статьи — на базе не применены колонки
переводов; разово прогоните `node --env-file=.env.production scripts/apply-galnet-migration.mjs`
(идемпотентно) — [GALNET-TRANSLATIONS-FIX.md](GALNET-TRANSLATIONS-FIX.md).

Для **облачного** Supabase-проекта миграции можно применить CLI. Временные **серверные** значения — в
`.env.local`:

```env
SUPABASE_PROJECT_REF=your-project-ref
SUPABASE_ACCESS_TOKEN=temporary-cli-access-token
SUPABASE_DB_PASSWORD=temporary-database-password
# Or use SUPABASE_DB_URL for a direct, percent-encoded connection URL.
```

```bash
set -a; . ./.env.local; set +a
npx supabase link --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
npx supabase db push --dry-run --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
npx supabase db push --project-ref "$SUPABASE_PROJECT_REF" --password "$SUPABASE_DB_PASSWORD"
```

Self-hosted база — `npx supabase db push --db-url "$SUPABASE_DB_URL"` или проверенный SQL через `psql`.
Realtime (публикация `supabase_realtime`) нужен для таблиц, на которые подписан браузер: `messages`,
`friends`, `user_notifications`, `forum_notifications`, `squadron_chat_messages`,
`squadron_voice_participants`, `squadron_voice_signals`.

## Project Structure

```
ed-ring-colony/
  src/
    proxy.ts                # сессии Supabase, заглушка техработ, шлюз Supabase (вместо middleware)
    app/                    # Next.js App Router: 59 страниц
      layout.tsx            # topbar (статус System Online/Update) + sidebar + footer
      atlas/ map/ system/ systems/ architect/ outfitting/ engineers/ station-search/ ...
      admin/ m-admin/       # админка и мобильная админка (PWA)
      api/                  # 227 маршрутов API (полный список — CONTEXT.md §5)
    components/
      GalaxyMap/            # 3D-карта галактики и её слои (INTEGRATION.md)
      SystemMap/            # карта системы: SystemOrrery3D + список тел
      Atlas/                # вкладки Atlas: поиск, маршруты, кольцо, рынок, поблизости, PowerPlay, фракции
      Architect/            # планировщик застройки и «Проекты систем»
      Carriers/             # карточки и панель авианосцев
      Outfitting/ Engineers/ Forum/ Wiki/ Projects/ Comments/ Cosmetics/ Galnet/ Support/
      Admin/                # вкладки админки (мониторинг, каталог, PowerPlay, фракции, Helper, верфь, ...)
      Icons.tsx             # все иконки (131 SVG)
    hooks/                  # слои Atlas (usePowerplayLayer, useFactionsLayer), поиск, друзья, realtime
    lib/                    # серверная и общая логика: импорты, синхронизации, CAPI, BGS, PowerPlay,
                            #   авианосцы, архитектор, верфь, журналы, i18n, Supabase-клиенты
    styles/forum-extra.css
    types/
  scripts/                  # run-tests.mjs, server-jobs.mjs + job-schedule.mjs, update-agent.mjs,
                            #   monitor-agent.mjs, импорт Spansh, Galnet, EDDN, сборка данных верфи
    tests/                  # 142 файла автотестов (+ helpers, fixtures)
  uploader/                 # Colonial Helper (Python): программа, лаунчер, сборка пакета, тесты
  android-app/              # Android-монитор (Kotlin + Compose)
  supabase/                 # migrations/ (86), full_schema.sql, maintenance/, templates/, DATABASE.md
  deploy/                   # Dockerfile'ы jobs/агентов, nginx, systemd, update-project.sh, бэкап,
                            #   selfhost/ (install.sh, upgrade.py, realtime-check.py)
  public/                   # data/outfitting.json, ed3d/, wiki/, fonts/, manifest-mobile.json
  tests/browser/            # Playwright
  Dockerfile, docker-compose.yml, next.config.mjs, .env.example
  migrations/, fix-supabase.js, package-additions.json   # старые разовые файлы, оставлены для справки
```

## API Routes

227 маршрутов в `src/app/api/`. Полная таблица с методами и доступом — [CONTEXT.md §5](CONTEXT.md#5-api-routes).
Основные группы:

| Группа | Префикс | Доступ |
|---|---|---|
| Atlas, карта, каталог | `/api/atlas/*`, `/api/map/*`, `/api/galaxy/*`, `/api/powerplay/*`, `/api/factions/*`, `/api/edsm/*` | публично (часть — с сессией) |
| Колонизация | `/api/architect/*`, `/api/projects/*`, `/api/hubs*`, `/api/route*`, `/api/systems/progress`, `/api/market/*`, `/api/stations/*` | сессия / публично |
| Журналы и Helper | `/api/logs/upload`, `/api/logs/import`, `/api/journal/*`, `/api/carriers/*`, `/api/factions/sync`, `/api/cmdr/stats` | API-токен `rc_…` или сессия |
| Frontier CAPI | `/api/capi/*` | сессия (`/token` — и токен Helper'а) |
| Сообщество | `/api/squadrons/*`, `/api/forum/*`, `/api/wiki/*`, `/api/comments*`, `/api/friends`, `/api/notifications`, `/api/support/*`, `/api/news*`, `/api/galnet*` | публично / сессия |
| Магазин и платежи | `/api/billing/*`, `/api/shop/*` | сессия; вебхуки провайдеров |
| Обновления Helper | `/api/uploader/*` (манифест, blob, лаунчер) | публично |
| Админка | `/api/admin/*`, `/api/mobile/*` | роль `admin` (часть — staff) |
| Фоновые задачи | `/api/cron/*`, `POST /api/galnet` | `Authorization: Bearer $CRON_SECRET` |
| Служебное | `/api/health`, `/api/status`, `/api/maintenance` | публично |

## Фоновые задачи

Расписание — `scripts/job-schedule.mjs`, исполнитель — `scripts/server-jobs.mjs` в Docker-сервисе `jobs`
(ровно один экземпляр). Он вызывает защищённые маршруты внутри Docker-сети (`http://web:3000`) с
`CRON_SECRET`; состояние запусков — `jobs-state.json`, его видно в Админка → Мониторинг. Список включённых —
`JOBS_ENABLED` (пустое значение отключает всё).

| Задача | Расписание (UTC) | Маршрут | Что делает |
|---|---|---|---|
| `capi-sync` | каждые 5 мин | `/api/cron/capi-sync` | синхронизация привязанных аккаунтов Frontier небольшой пачкой, продление токенов |
| `update-progress` | каждые 30 мин | `/api/cron/update-progress` | прогресс хабов и систем маршрута из Raven Colonial → `system_progress` |
| `cg-check` | каждые 6 ч | `/api/cron/cg-check` | Community Goals из Inara (нужен `INARA_API_KEY`) |
| `eddn-cleanup` | каждые 6 ч, :30 | `/api/cron/eddn-cleanup` | удаляет цены EDDN старше 7 дней |
| `colonisation-cleanup` | 03:40 | `/api/cron/colonisation-cleanup` | подрезает снимки прогресса строек старше `COLONISATION_RETENTION_DAYS` |
| `galnet-sync` | 06:20 | `/api/galnet` | лента Galnet + догон переводов |
| `translate` | каждые 6 ч, :40 | `/api/cron/translate` | очередь переводов `news` и `galnet_news` |
| `powerplay-sync` | 05:20 и 17:20 | `/api/cron/powerplay-sync` | дамп EDSM PowerPlay (условный запрос — второй за сутки обычно 304) |
| `factions-sync` | 07:10 | `/api/cron/factions-sync` | обновляет фракции старше `FACTIONS_REFRESH_DAYS` и продолжает прерванный импорт; **первую** загрузку делает админ |
| `galaxy-import` | 02:00, **выключена по умолчанию** | `/api/cron/galaxy-import` | дельта каталога Spansh; включается осознанно |

Если в `.env.production` задан свой `JOBS_ENABLED`, новые задачи (`powerplay-sync`, `factions-sync`) нужно
дописать в него вручную.

## Spansh: все системы галактики

Полная таблица всех известных систем (`galaxy_systems`, ~2×10⁸ строк — вся исследованная галактика)
загружается ночным дампом Spansh. Она ускоряет поиск в Атласе (опорные координаты и звёздные кандидаты
берутся из локальной БД) и подпитывает экспериментальный слой «Все системы ⚗» на 3D-карте (фильтр классов,
карточка по клику). Страница системы открывается и для систем без стройки, если они есть в каталоге.

Импорт запускается **из самого приложения** — production-образ не содержит `scripts/`: Админка → вкладка
«Каталог систем» (`/admin?tab=galaxy`), `POST /api/admin/galaxy` (сессия админа) или
`POST /api/cron/galaxy-import` (`CRON_SECRET`). Запрос только стартует фоновую загрузку и сразу отвечает;
прогресс виден в `GET /api/galaxy/stats`, прерванный импорт продолжается.

Полный дамп (`systems.json.gz`, 5.9 ГиБ) нужен **один раз**: дальше импорт сам берёт дельту Spansh,
перекрывающую отставание каталога (`systems_1week.json.gz` ~21 МиБ на суточном цикле,
`systems_1month.json.gz` ~88 МиБ после месяца простоя). Холодный старт ускоряют параллельные
Range-соединения (`GALAXY_DOWNLOAD_SEGMENTS`, по умолчанию 4), запись через `COPY` по прямому Postgres
([GALAXY-IMPORT-SPEED.md](GALAXY-IMPORT-SPEED.md)) и режим шардов (`GALAXY_IMPORT_MODE=shards`): архив
распаковывается в gzip-TSV файлы, после чего перезапуск импорта стоит O(1), а не повторного разбора 6 ГиБ.

Архивы и шарды лежат на отдельном диске сервера (`GALAXY_DATA_HOST_DIR`, по умолчанию
`/mnt/sdb/ed-ring-colony/spansh` → `/app/data/spansh`; там же — архив фракций `factions/`): предыдущий дамп
удаляется перед загрузкой нового, а архив — после успешного импорта, так что ~12 ГиБ пика не превращаются в
бесконечный рост. Перенос со старого volume и первичная настройка диска:
`sudo bash deploy/migrate-galaxy-dump.sh` (скрипт сам находит, куда смонтирован `/dev/sdb1`, и печатает
строку для `.env.production`).

```bash
npm run spansh:import                 # CLI: полный дамп → БД
npm run spansh:import -- --variant 1day   # только изменения за сутки
npm run spansh:import -- --unpack     # распаковать архив в шарды
npm run spansh:selftest               # офлайн-проверка конвейера (без БД и сети)
```

Подробности, альтернативы загрузки и диагностика (почему карта не показывает все системы):
[SPANSH-IMPORT.md](./SPANSH-IMPORT.md).

## Galnet Sync

Новости Galnet забираются с официального JSON:API Frontier
(`https://cms.zaonce.net/en-GB/jsonapi/node/galnet_article`), складываются в таблицу `galnet_news` и
автоматически переводятся через Yandex Cloud Translate API v2 на ru/en/de/it/ko/zh/ja. Расписание —
задачи `galnet-sync` (06:20 UTC) и `translate` (каждые 6 часов) из таблицы выше.

Для ручной диагностики остался CLI, работающий с БД напрямую:

```bash
node scripts/galnet-sync.mjs                  # синхронизация + перевод
node scripts/galnet-sync.mjs --dry-run        # только разбор ленты, без записи в БД
node scripts/galnet-sync.mjs --translate-only # только очередь переводов
node scripts/galnet-sync.mjs --no-translate   # только синхронизация
```

Нужные серверные переменные для CLI: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`YANDEX_TRANSLATE_API_KEY` (опционально `YANDEX_TRANSLATE_FOLDER_ID`, `YANDEX_TRANSLATE_IAM_TOKEN`).

### Если переводы не появляются

Перевод выполняет контейнер `web` (по запросу планировщика `jobs`), поэтому ключ Yandex должен быть в
окружении именно сервиса `web`. Порядок проверки:

```bash
# 1. Ключ виден внутри web? (в стандартном docker-compose.yml web читает env_file .env.production;
#    установки, переведённые deploy/selfhost/upgrade.py, держат ключи в environment сервиса web)
docker compose exec web sh -c 'env | grep -c YANDEX_TRANSLATE'

# 2. Что говорит планировщик: event:"skipped"/"warning" = нет ключа, event:"failure" = ошибка API
docker compose logs --since 48h jobs | grep -E '"job":"(translate|galnet-sync)"'

# 3. Размер очереди и конфигурация переводчика
curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
  'http://127.0.0.1:3000/api/galnet?limit=1' | jq '{translateConfigured, pendingGalnetTranslations, errors}'

# 4. Ручной догон очереди с подробными ошибками Yandex (401/403 — ключ, 429 — квота)
docker compose exec web node scripts/galnet-sync.mjs --translate-only
```

Типичные причины: ключ потерялся при обновлении (`upgrade.py` переносит его из работающего контейнера);
для API-ключа сервисного аккаунта нужна роль `ai.translate.user`; исчерпана квота символов (429 — статьи
остаются `failed` и будут повторно взяты следующим запуском — свежие статьи обрабатываются первыми).
Ключи `.env.production` можно посмотреть и поменять в Админка → Мониторинг → «API-ключи сайта».

## Colonial Helper 2.16.0

В репозитории находится Windows/Python-клиент `uploader/colonial_helper.py` для загрузки данных Elite
Dangerous на ED Ring Colony. Что он умеет и как собирается — [uploader/README.md](uploader/README.md),
журнал версий — [uploader/CHANGES.md](uploader/CHANGES.md). Последние версии:

* **2.16.0** — состояние минорных фракций посещённых систем → `POST /api/factions/sync` ([FACTIONS.md](FACTIONS.md));
* **2.15.0** — закреплённый блок оверлея всегда пропускает мышь (Ctrl+F12 — закрепить/открепить все),
  любой блок можно отвязать от игры и вынести на другой монитор;
* **2.14.0** — учёт авианосцев на сайте (`POST /api/carriers/sync`, оверлей читает `GET /api/carriers/mine`),
  исправленная отправка груза в Raven Colonial ([FLEET-CARRIERS.md](FLEET-CARRIERS.md));
* **2.13.x** — обновление пакетом кода через сервер проекта, подпись ключом, которому доверяют клиенты,
  единый дизайн восьми HUD-блоков, CAPI после верного входа через Epic/Steam.

Обновления Helper полностью обслуживает собственный сервер: администратор загружает базовый EXE, сервер
собирает ZIP, считает SHA-256, подписывает манифест Ed25519, публикует версию и умеет откатывать релиз.
**Изменения в `uploader/` сами по себе не доходят до пилотов — пакет нужно опубликовать в Админка →
Обновления Helper.**

### Какие данные принимает сайт

- персональные доставки для leaderboard: прямые `ColonisationContribution`, `CargoDepot`, доставка на Fleet
  Carrier и подтверждённые уменьшения корабельного Cargo (`POST /api/logs/upload`);
- общие события `ColonisationConstructionDepot`: состояние стройки, требования ресурсов, прогресс,
  construction ID, MarketID, система и время — в `colonisation_sites` и `construction_depot_snapshots`;
- сканы тел (`system_scans`), сводку пилота (`pilot_stats`), события авианосцев (`/api/carriers/sync`),
  станции и рынки (`/api/stations/report`), фракции (`/api/factions/sync`);
- повторные доставки не дублируются благодаря `source_hash` (одинаковому у сайта и Helper'а), а события
  стройки — отпечатку состояния: неизменившееся состояние, которое журнал пишет каждые несколько секунд,
  не добавляет строку.

Каждая доставка несёт объяснение своего происхождения, поэтому досье может делить «весь груз» и «груз на
стройплощадки» без догадок (`source`, `is_construction`, `market_id` — миграция
`supabase/migrations/20260917000000_deliveries_transport_scope.sql`). `is_construction` выставляет парсер
журнала: `ColonisationContribution` и `CargoDepot` — всегда стройка, `cargo_delta` — только если игрок стоял
у рынка, про который журнал показывал `ColonisationConstructionDepot`, а отгрузка на авианосец, грузовые
миссии, Powerplay и Search-and-Rescue — просто перевозка. Исторические строки имеют
`is_construction IS NULL` и считаются стройкой, иначе старые профили обнулились бы.

Браузерная загрузка (личный кабинет `/account` → `POST /api/logs/import`) и десктопный uploader отправляют
один и тот же набор данных. Разбор делается одним проходом по журналу: `lib/journalParser.ts` считает
доставки и одновременно кормит событиями `lib/journalTelemetry.ts`, а кабинет тем же проходом собирает
события авианосцев (`lib/fleetCarrierCollector.ts` → `/api/carriers/sync`) и фракций
(`lib/bgsJournal.ts` → `/api/factions/sync`).

`MarketBuy` с Fleet Carrier уменьшает его запас и не считается доставкой на проект. Обычные продажи на
станции не загружаются как construction delivery. Ключи Raven Colonial, EDSM и Inara хранятся только
локально у пользователя. Сырые журналы на сайт не передаются; uploader хранит только локальные byte
offsets (`.colonial_helper_journal_offsets.json`).

## Deployment

### Собственный сервер (Docker Compose)

```bash
# При обновлении существующего сервера НЕ перезаписывайте рабочий env-файл.
# Один скрипт: ключи мониторинга + метаданные ревизии + запуск + проверка.
bash deploy/start-monitoring.sh
docker compose --env-file .env.production logs --tail=100 jobs
```

Ручной эквивалент того же запуска:

```bash
docker compose --env-file .env.production --profile monitoring build web jobs monitor-agent
docker compose --env-file .env.production --profile monitoring up -d web jobs monitor-agent
```

Новый сервер — [SELFHOST.md](SELFHOST.md) (всё на одной машине, `deploy/selfhost/install.sh`),
[UBUNTU20-INSTALL.md](UBUNTU20-INSTALL.md) или [SERVER-SETUP.md](SERVER-SETUP.md) (облачный Supabase).
Переход с Vercel и роль каждого файла в `deploy/` — [DEPLOY.md](DEPLOY.md).

### Операционный мониторинг

В **Админка → Мониторинг** доступны статус сайта, Supabase/БД, Docker-сервисов, планировщика и версия
развёрнутого проекта. Включение — одна команда `bash deploy/start-monitoring.sh` (или
`npm run monitoring:up`): она сама генерирует и вставляет отдельный `MONITOR_AGENT_TOKEN`, поднимает
Compose-профиль `monitoring` (сервис `monitor-agent`) и проверяет связку web → agent; порт агента не
публикуется. Полная безопасная настройка, режимы скрипта и команда обновления: [MONITORING.md](MONITORING.md).

Дополнительно панель показывает:

- **место на диске** — вес базы на диске (`pg_database_size`), разбивка по таблицам (данные / индексы /
  TOAST) и свободное место на разделе;
- **контент и переводы** — последняя синхронизация Galnet, сколько статей ждут перевода, и кнопки
  «Синхронизировать Galnet сейчас» / «Добить переводы»;
- **обновление проекта** — ревизия в ветке, число новых коммитов и неприменённых миграций, кнопка «Обновить
  сейчас» с прогрессом по стадиям и журналом, кнопка «Остановить», а перед запуском — флажки «с тестами»,
  «с бэкапом БД» и «с миграциями» плюс отдельная кнопка «Применить только миграции» (без пересборки).
  Включение: `sudo bash deploy/start-update-agent.sh` (или `npm run update:enable`);
- **API-ключи сайта** — `.env.production` в маскировке, правка и «Применить» (пересоздание `web`).

На время такой пересборки вся витрина показывает `System Update` с анимированными часиками и процентом вместо
`System Online`: посетитель видит, что идёт плановое обновление, а не падение сервиса. Данные для этого даёт
публичный `GET /api/status` — только стадия и процент, без путей, ревизий и журнала.

### Мобильный мониторинг

- **Веб-версия `/m-admin`** — PWA-ready мобильная админка в стиле HUD сайта, 9 вкладок: Обзор, Монитор,
  Биллинг, Системы, Контент, Юзеры, Поддержка, Бэкапы, Auth. Автообновление каждые 20 с, bottom nav,
  карточки вместо таблиц; требует роль admin.
- **Android-приложение `android-app/`** — Kotlin + Jetpack Compose, логин через `POST /api/mobile/auth` →
  Bearer JWT в EncryptedSharedPreferences, агрегатор `GET /api/mobile/admin-summary?period=30d`. Сборка
  `cd android-app && ./gradlew assembleDebug` сейчас падает (см. [android-app/README.md](android-app/README.md)).

Подробности: [MOBILE-ADMIN.md](MOBILE-ADMIN.md) и [MONITORING.md](MONITORING.md).

## Приём платежей Т-Банка

Разовая оплата кредитов, товаров и периода подписки через страницу банка; без автосписаний. Настройка
терминала, тестирование, требования к чекам и порядок разбора сбоев: **[TBANK-SETUP.md](TBANK-SETUP.md)**.
Провайдер выключен по умолчанию.

## Design System

See [DESIGN.md](DESIGN.md): палитра из 9 цветов, типографика, компоненты, иконки, анимации, адаптив и
мобильная админка.

## Architecture

See [CONTEXT.md](CONTEXT.md): стек, маршрутизация и аутентификация, таблицы БД, полный список API,
компоненты, интеграции (EDSM, EDDN, Spansh, Raven Colonial, Frontier CAPI, Inara, Yandex), фоновые задачи,
переменные окружения и типовые приёмы.

## License

MIT

## Credits

- Elite Dangerous by Frontier Developments
- EDSM for system, PowerPlay and minor-faction data
- EDDN for real-time data
- Spansh for the galaxy catalog and route planning
- Raven Colonial for colonial data
- EDCD / coriolis-data for ship and module statistics (ship builder)
- INARA for engineer unlock requirements and Community Goals
- OpenNGC for nebula shapes
- Yandex Translate for i18n

---

*For questions or issues, open a GitHub issue or contact the maintainers.*
