# История изменений ED Ring Colony

Журнал слитых pull request'ов сайта, базы и сопутствующих программ — от новых к
старым. Сейчас: **сайт 2.22.0** (`package.json` → `version`), **Colonial Helper
2.17.0** (`uploader/colonial_helper.py` → `VERSION`).

* Подробные заметки к каждой версии Helper — [uploader/CHANGES.md](uploader/CHANGES.md)
  (его первый раздел сервер берёт как заметки к релизу, см. `uploader/build_bundle.py`).
* Описание функций — [README.md](README.md), устройство — [CONTEXT.md](CONTEXT.md),
  все документы — [DOCS.md](DOCS.md).
* Номер версии сайта поднимался не в каждом PR: между 2.14.1 (29.09) и 2.15.0
  (17.10) изменения шли без смены номера. Метка «web X» / «Helper X» в конце
  строки — версия, с которой вышел этот PR.

## Версии сайта

| Версия | PR | Дата | Главное |
|---|---|---|---|
| 2.22.0 | #154 | 19.10.2026 | Единый механизм данных о системах: карточка системы со всеми разделами, одно наблюдение → фракции и PowerPlay, журналы → проекты эскадрилий с уведомлениями ([ARCHITECTURE.md](ARCHITECTURE.md)) |
| 2.21.0 | #152 | 18.10.2026 | Фракции: скачивание → разбивка → запись строго по очереди, короткие запросы к EDSM, архив с компьютера |
| 2.20.0 | #151 | 18.10.2026 | Фракции: дамп EDSM через архив на сервере и куски, как у «Каталога систем» |
| 2.19.0 | #150 | 18.10.2026 | Минорные фракции: вкладка Atlas, таблицы `bgs_*`, обновления от Helper 2.16.0 |
| 2.18.0 | #149 | 18.10.2026 | PowerPlay: прогресс загрузки, фильтр по державам, раздел в админке |
| 2.17.0 | #148 | 18.10.2026 | Atlas: вкладка PowerPlay |
| 2.16.1 | #147 | 18.10.2026 | Авианосцы: чужие Javelin не приписываются эскадрилье |
| 2.16.0 | #146 | 17.10.2026 | Слой «Авианосцы» на карте и в Atlas |
| 2.15.0 | #145 | 17.10.2026 | Архитектор: «Проекты систем» |
| 2.14.1 | #69 | 29.09.2026 | Назначенный архитектор системы |
| 2.13.0 | #66 | 28.09.2026 | Архитектор: три вида плана, Spansh в сверке тел |
| 2.12.2 | #58 | 27.09.2026 | Сверка груза авианосца (блок CARRIER) |
| 2.12.1 | #58 | 27.09.2026 | Frontier CAPI без HTTP 400 |
| 2.12.0 | #56 | 26.09.2026 | Телеметрия Архитектора и привязка Frontier CAPI |

## Все pull request'ы

### 2026-10-19

- #154 Единый механизм данных о системах ([ARCHITECTURE.md](ARCHITECTURE.md)). Что сделано:
  - общий ключ системы и ссылки между разделами;
  - карточка системы `/system/[name]` + `GET /api/systems/overview` со всеми разделами;
  - PowerPlay из журналов пилотов (Helper, кабинет, CAPI); дамп EDSM не перетирает свежие данные;
  - стройки из любого пути загрузки двигают статусы систем в проектах эскадрилий и уведомляют участников;
  - общий приём журналов `/api/logs/*`;
  - Атлас открывает систему на слоях «Фракции» и PowerPlay по ссылке, поиск станций и проекты ведут в карточку системы;
  - миграция `20261020120000_unified_system_data.sql`.

  (web 2.22.0, Helper 2.17.0)

### 2026-10-18

- #152 Фракции: шаги по очереди, замерзающие соединения к EDSM → короткие запросы, архив с компьютера (web 2.21.0)
- #151 Фракции: загрузка дампа EDSM как у «Каталога систем» — архив на сервер → куски → база (web 2.20.0)
- #150 Минорные фракции: вкладка «Фракции» в Atlas, данные в БД, загрузка из EDSM и обновления от Colonial Helper (web 2.19.0, Helper 2.16.0)
- #149 PowerPlay: понятная загрузка, фильтр по державам, кликабельные системы, раздел в админке (web 2.18.0)
- #148 Atlas: вкладка PowerPlay — системы под контролем держав на карте (web 2.17.0)
- #147 fix(carriers): чужие Javelin больше не приписываются эскадрилье пилота (web 2.16.1)

### 2026-10-17

- #146 Карта и Atlas: слой «Авианосцы» — значок как в игре, фильтр «в каких системах» — web 2.16.0
- #145 Architect: «Проекты систем» — группы систем, участники, авианосцы, прогресс и лидеры — web 2.15.0

### 2026-10-16

- #144 Оверлей: закреплённый блок всегда пропускает мышь, блок можно вынести на другой экран (Helper 2.15.0)
- #143 feat(carriers): учёт авианосцев на сайте проекта, оверлей Helper без зависимости от Raven — Helper 2.14.0
- #142 fix(journal): устранить дубли поставок между сайтом и Colonial Helper
- #141 feat(journal): перезагрузка логов с нуля с очисткой мусорных данных
- #140 fix(migrations): make 20261016000000_credentials_and_views_hardening resilient to live schema
- #139 security: harden credential tables, Supabase gateway, auth routes, and client apps

### 2026-10-14

- #138 Allow removing individual ship outfitting slots
- #137 Fix scrolling in outfitting editor dialogs
- #136 Add ship management to outfitting admin
- #135 Безопасность: утечка персональных данных profiles и самоназначение админом (RLS)
- #134 Add persistent station commerce and station search with Atlas integration
- #133 Make orange galaxy belt a transparent 3D tube

### 2026-10-13

- #132 Add Spansh coordinate fallback for hubs, routes and squadron projects
- #131 Fix Atlas market search failures and add construction site material selection
- #130 Support 20,000+ route systems with complete reads and admin pagination
- #129 fix(atlas): prevent key system input and Add button overlap
- #128 feat(atlas): multidirectional ring preview and responsive search UI
- #127 fix(types): исправить TS-сборку basis3d
- #126 fix(ring-route): применять параметры геометрии при нажатии Поиск
- #125 fix(ring-hubs): исправить падение модального окна поиска хабов
- #124 feat(ring-route): уточнение кольца, ключевые системы, поиск хабов, инфографика
- #123 fix(atlas): собирать кольцо после полного скана
- #122 fix(atlas): искать кольцо по реальным системам, а не по середине хорды
- #121 fix(galaxy-map): убрать dense режим для маршрутов проекта
- #120 fix(atlas): улучшить устойчивость поиска галактического кольца

### 2026-10-12

- #119 Atlas: кольцо остаётся на карте и сохраняется в проект; тесты быстрее в 2,7 раза
- #118 Atlas: кольцо — 504, запуск при радиусе >50, требования маршрута, ввод с клавиатуры

### 2026-10-11

- #117 Atlas: шаговый поиск кольца, кэш проекта и прогресс на 3D-карте
- #116 Карта галактики: туманности снова видимы, форма — из реальных данных OpenNGC
- #115 Карта галактики: туманности в игровом виде — объёмы вместо скоплений точек

### 2026-10-10

- #114 Меню и Atlas: общий поисковик систем, переработанный интерфейс, уведомления
- #113 Colonial Helper и Архитектор: тип постройки из справочника Raven, тело из системы, проект Raven с сайта без дублей
- #112 Fix CAPI relink loop after valid Epic/Steam authorization — Helper 2.13.4
- #111 Add shipyard catalog management and responsive admin layout
- #110 CAPI: стабильность всех видов подключения и защита источника сводки пилота

### 2026-10-09

- #109 Fix Helper build kit: embed keys into multi-line TRUSTED_KEYS
- #108 Reliable Colonial Helper updates without key rotation
- #107 Helper 2.13.3: починка канала обновлений (подпись ключом клиентов) и серверный выбор канала
- #106 Fix HTTP 413 for launcher uploads
- #105 Журналы колонизации: одна строка на площадку вместо истории; EDDN для Spansh (opt-in)
- #104 uploader: диагностика HTTP 413 при загрузке базового ColonialHelper.exe

### 2026-10-08

- #103 Improve diagnostics for failed git stash updates
- #102 Исправить слой точек и диагностику загрузки Helper
- #101 Карта: облако точек переживает сбой хранилища и стало в 1.7 раза больше
- #100 Каталог систем: слияние COPY-импорта больше не обрывается по времени

### 2026-10-07

- #99 Верфь: единый блок распределителя, переборки в основных модулях, заводские модули, цвета происхождения и сборка облака точек для карты

### 2026-10-06

- #98 deploy: скрипт диагностики и восстановления БД после перезагрузки сервера

### 2026-10-05

- #97 Raise nginx release upload limit
- #96 Fix 413 при загрузке EXE Helper и таймаут слияния каталога систем 120с→900с

### 2026-10-04

- #95 Добавить создание первичной EXE-сборки Colonial Helper
- #94 Save outfitting builds to pilot profiles
- #93 Galaxy import: fix multi-hour merge stalls + resumability diagnostics
- #92 Верфь: боевая сводка, графики, обмен сборками с Coriolis/EDSY и управление кораблём

### 2026-10-03

- #91 Fix full dump imports in shard mode

### 2026-10-02

- #90 Самовосстановление сети Supabase (db) + быстрый полный импорт каталога на непустой базе
- #89 Fix and accelerate galaxy catalog imports
- #88 Fix direct Postgres network detection
- #87 Fix production build tracing and TypeScript errors
- #86 Герметичные тесты: 9 падений npm test внутри docker build web (bash/python3/env из build-args)
- #85 Ускорение импорта каталога систем: COPY вместо пачечных INSERT + диагностика прямого Postgres
- #84 fix(deploy): конфликт имени контейнера при переключении и утечка диска за ним

### 2026-10-01

- #83 Импорт каталога систем: дельты вместо 6 ГиБ, параллельная загрузка, шарды и отдельный диск
- #82 Остановка роста colonisation_events (12+ ГБ), монеты наёмников, выбор платформы CAPI, инженеры

### 2026-09-30

- #81 fix(orrery): sync cluster orbits with moving stars
- #80 feat(outfitting): modernize shipyard with EDSY-style 3-pane picker, power distributor pips, drag-and-drop, and streamlined engineering
- #79 Improve Helper release operations and backup storage
- #78 Верфь: экспериментальные эффекты применяются к модулям и переведены
- #77 smtp: проверять живость auth по контейнеру, а не по 401 от key-auth
- #76 i18n: полный перевод разделов «Верфь» и «Инженеры» на все языки проекта
- #75 Вертикальная интерактивная схема инженеров
- #74 Диск: бюджет кэш-маунтов BuildKit (.next/cache Turbopack) и дамп перед обновлением без каталога систем
- #73 Исправить включение uploader в web-образ

### 2026-09-29

- #72 Верфь, дерево инженеров, починка 3D-карты системы и надёжная сборка образов
- #71 Доработать Архитектор, Helper, SMTP и оформление эскадрилий
- #70 fix(auth): same-origin Supabase gateway for TLS failures
- #69 Архитектор системы: назначенный архитектор, администрирование и блоки лидерборда — web 2.14.1
- #68 Обновления Helper и Архитектора системы
- #67 fix(deploy): сборка без provenance-аттестаций buildx — «DeadlineExceeded: context deadline exceeded»

### 2026-09-28

- #66 Архитектор: три вида на план, Spansh в сверке тел, аудит данных — web 2.13.0
- #65 fix(update-agent): BuildKit-сборка в read-only контейнере — DOCKER_CONFIG на записываемый том
- #64 Настройка канала обновлений Helper из админки (ключи подписи и токен публикации)
- #63 Fix update-agent refresh and BuildKit fallback
- #62 Раунд 67: Colonial Helper обновляется пакетом кода, а не новым exe — Helper 2.13.0
- #61 Обновить дизайн 3D-визуализации системы
- #60 Обновление из админки не падает без BuildKit: запасной Dockerfile web + buildx в агенте

### 2026-09-27

- #59 Уборка диска и скорость сборки после обновлений + настройки почты в админке
- #58 Кабинет, Frontier CAPI и блок CARRIER: аватары без 503, «Сообщения и друзья», эскадрильи, CAPI без HTTP 400, сверка груза авианосца — web 2.12.1 → 2.12.2, Helper 2.12.1, 2.12.2
- #57 System Architect: постройки по телам, редактор записи, основной порт

### 2026-09-26

- #56 feat: Architect telemetry and Frontier CAPI dossier binding — web 2.12.0, Helper 2.12.0
- #55 Архитектор: сверять тела системы с EDSM и базой проекта при загрузке
- #54 Сделать сборку update-agent устойчивой к сбоям DNS Alpine
- #53 fix(admin): перезапуск агента и обновления без таймаута
- #52 Обновление из панели, камера 3D-карты и сигналы на телах
- #51 Раунд 63 (2.11.0): архитектор по факту, редизайн страницы системы, фиксы uploader, EDSM/CAPI, диагностика почты — Helper 2.11.0
- #50 Восстановить мёртвые SQL-миграции, починить RLS friends и пересобрать full_schema

### 2026-09-25

- #49 Fix mobile admin build and support cached Docker rebuilds
- #48 Архитектор системы: планировщик застройки, хранение планов на сервере, публикация по ссылке, фактический прогресс и «где купить» (/architect, тестовый режим)
- #47 feat(admin): update options checkboxes, migrations-only button, no build timeout
- #46 feat: Android monitoring app + mobile admin panel /m-admin
- #45 Кнопка «Обновить сейчас»: пересборка и миграции даже без отставания от ветки
- #44 revert(ports): вернуть портовую конфигурацию к состоянию 24 часа назад (195c75a)
- #43 fix(colonisation): остановить дубли и мусор в colonisation_events

### 2026-09-24

- #42 fix(deploy): закрепить Synology-порты сайта 9000 и Supabase 9100
- #41 fix(docker): восстановить конфигурацию портов и добавить конфиг старта deploy/start-docker.sh
- #40 Ручная полная пересборка на сервере при 502: deploy/rebuild-now.sh
- #39 Импорт каталога: PostgREST — не «медленнее», а потолок (импорт падал на 2.7%)
- #37 Ускорить docker-сборку и поднять таймаут апдейтера до 90 минут
- #36 Reconcile Galnet news table structure
- #35 Add public offer for digital products
- #34 fix(galaxy): импорт каталога не умирает на statement timeout одиночной строки
- #33 fix(deploy): fix apply-env line 99 error and improve uploader tracking

### 2026-09-23

- #32 Galnet-переводы на живой базе, SUPABASE_DB_URL без EAI_AGAIN, APP_* при сборке, честный мониторинг
- #31 fix(update): кнопка «Обновить сейчас» отвечала 404 (POST /start → /update)
- #30 Каталог на 10⁸ строк, импорт без EAI_AGAIN db, бэкап БД раз в неделю из Админки
- #29 test: не валить сборку в alpine там, где физически нужен bash
- #28 Карта системы: движок three.js на сайте и сцена во вкладке приложения

### 2026-09-22

- #27 Мониторинг: место на диске, обновление проекта кнопкой и починка контент-пайплайна
- #26 Add hidden company requisites page at /details
- #25 Enable automatic monitor-agent startup
- #24 feat(galaxy): pre-download the Spansh dump to disk and import from there
- #23 Fix galaxy catalog import dying on PostgREST statement_timeout
- #22 feat: add protected server operations dashboard
- #21 fix(galaxy): не обрывать импорт каталога на повторах систем
- #20 feat(billing): add T-Bank one-time hosted payments
- #19 fix(galaxy): импорт каталога Spansh из приложения, вместо 404 на /api/galaxy/all-systems
- #18 feat(auth): вход и привязка через Яндекс ID

### 2026-09-21

- #17 Все системы галактики: каталог Spansh, слой карты и карточка без статуса стройки
- #16 Все системы галактики: Spansh-дамп в БД, поиск в Атласе, экспериментальный слой карты
- #15 Billing on real data: cosmetics everywhere, shop CRUD, payment providers, site colour schemes
- #14 feat(billing): add billing system, project stats infographics, subscription manager and premium shop
- #13 Self-hosted migration: Uploader, OAuth and server jobs — Helper 2.10.25

### 2026-09-19

- #12 Подготовка к переносу с Vercel на свой сервер: Docker, полная схема БД, инструкции деплоя

### 2026-09-18

- #11 Грузы в досье, приватность профиля, CAPI без Shared Key, настоящие орбиты на 3D-карте

### 2026-09-17

- #10 Colonial Helper 2.10.18 → 2.10.23: та же 3D-карта, что на сайте, сфера вместо блина, живой SHIP-оверлей

### 2026-09-15

- #9 feat: Plotly system map 3D Orrery, rings, habitable zone, and Vercel build fix
- #7 fix(galnet): переписать синхронизацию Galnet и автоперевод
- #6 Colonial Helper 2.9.2→2.10.14: Raven Colonial, карта системы, EXOBIO и CARRIER — Helper 2.9.2 → 2.10.14

### 2026-09-14

- #5 Colonial Helper 2.4.0 → 2.9.1: Raven Colonial, EDSM/Inara, оверлеи, самообновление

### 2026-09-13

- #4 Uploader 2.3.0: инфографика пилота и полное управление блоками оверлея — Helper 2.3.0

### 2026-09-12

- #3 feat: improve Colonial Helper journal integrations

### 2026-09-11

- #2 Fix imports, profiles, friends, tickets, and squadron recovery

### 2026-09-08

- #1 Update from task 607430f0-6035-4f22-b381-a8913fe59ec0
