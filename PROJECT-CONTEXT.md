# ED Ring Colony и Colonial Helper — рабочий контекст перед доработками

> Дата анализа: **2026-11-23**. Ветка: `arena/24476c57-ed-ring-colony`.
> Исходная ревизия: `d2f8315135bb009fb3ed24ec98af342a023643ea`.
> Задача: разобраться в проекте и desktop-приложении, зафиксировать основу для последующих изменений, **не менять функциональность**.
>
> Дополнение: [PROJECT-INVENTORY.md](PROJECT-INVENTORY.md) — структурный индекс всех Python-модулей Helper (с классами, методами, функциями и локальными зависимостями), страниц, API-маршрутов, библиотек, компонентов, миграций, тестовых файлов и операционных скриптов.

## 1. Границы и достоверность этого контекста

Проведены инвентаризация репозитория, чтение архитектурных документов и ключевых реализаций, трассировка основных сквозных сценариев, полный запуск Node-тестов, попытка полного запуска Python-тестов и отдельный успешный запуск чистого Python-контура. Сведения ниже разделены на подтверждённое исходниками, результаты исполнения и риски, требующие воспроизведения.

**Это не утверждение о построчном аудите каждой функции и не сертификация безопасности.** Наличие файла в индексе означает структурный учёт, а не ручную проверку всех его ветвей. Без production-конфигурации, реальной БД, Windows, запущенной игры и доступа к игровым сервисам нельзя подтвердить боевое поведение интеграций и HUD.

Источники истины при конфликте:

1. Текущий исполняемый код и миграции.
2. Воспроизводимые результаты тестов с учётом ограничений стенда.
3. Документы конкретного контракта/исправления.
4. Общие README и исторические обзоры.

`ARCHITECTURE.md`, `CONTEXT.md`, `ARCHITECT.md`, `README.md`, `uploader/README.md` полезны, но содержат исторические версии, устаревшие количества модулей и упоминания уже удалённых интерфейсов. В частности, комментарий о Tk не доказывает наличие действующего Tk-интерфейса.

## 2. Что представляет собой продукт

ED Ring Colony — связанная экосистема для Elite Dangerous:

- сайт: галактическая карта, Атлас, маршруты и кольцо колонизации;
- проекты колонизации, планировщик «Архитектор», снабжение и прогресс строек;
- станции, рынки, оснащение и инженерные справочники;
- авианосцы: груз, каталог, местоположение, посещения, история и расписания прыжков;
- досье командира, корабль, статистика, журнал, достижения;
- BGS/минорные фракции, PowerPlay, цели сообщества;
- эскадрильи, друзья, сообщения, форум, wiki, новости, Galnet, поддержка;
- подписки, платежи, косметика, премиум-функции;
- админка, мобильная админка, Android Monitor, мониторинг, обновления и резервное копирование;
- **Colonial Helper**: Windows-first desktop-клиент с чтением локального журнала, телеметрией, HUD и собственным каналом обновлений.

Основная связующая сущность — **звёздная система**. С ней связаны тела, станции, площадки, проекты, маршруты, фракции, державы, носители и наблюдения пилотов.

### Размер снимка

| Часть | Фактическая структура |
|---|---|
| `src/` | 880 отслеживаемых файлов; 64 `page.tsx` |
| Маршруты | 268 `route.ts` внутри `src/app/api`, ещё 2 вне `/api` |
| Библиотеки | 291 файл `.ts` под `src/lib` (без `.tsx`, `.mjs`, JSON) |
| Компоненты | 190 `.tsx` под `src/components` |
| Helper | 75 Python-модулей верхнего уровня в `uploader/` |
| SQL | 120 файлов в `supabase/migrations/` |
| Тесты | 205 Node-файлов, 92 Python-файла, 5 Playwright-файлов |

Это объём исходников, а не количество доступных в production функций или строк в реальной БД.

## 3. Стек и размещение ответственности

### Web

- Next.js **16.4.2**, App Router, React **19.2.8**, TypeScript `strict`.
- Node.js по `package.json`: **>=22.18.0**.
- Tailwind 4/PostCSS, общие CSS и собственные UI-компоненты.
- three.js, React Three Fiber, drei: карта галактики и 3D-сцены систем.
- Supabase: PostgreSQL, Auth, PostgREST/RPC, Storage, Realtime.
- Прямой PostgreSQL через `pg` и `pg-copy-streams` для тяжёлых импортов.
- Zod для ряда входных контрактов; LRU и другие кэши в памяти процесса.
- Состояние интерфейса преимущественно React hooks; отдельного Redux/Zustand в зависимостях нет.
- Markdown: `react-markdown`, `remark-gfm`, `rehype-sanitize`.
- Push: `web-push`.
- i18n: собственный контекст, семь языков `ru/en/de/it/ko/zh/ja`.

### Desktop

- Python; Windows build-kit рекомендует Python 3.11.
- **PySide6-Essentials >=6.7,<6.12**, а не Electron, Tk или PyQt.
- `requests`, `pyperclip`; PyInstaller для Windows-сборок.
- `orjson` опционален, без него используется стандартный `json`.
- Интерфейс, лаунчер, Setup, деинсталлятор и HUD используют Qt; некоторые адаптеры сохраняют старые имена методов (`after`, `notebook.select`, `geometry`).
- WinAPI через `ctypes`: окно игры, мониторы, горячие клавиши, click-through и Z-order HUD.
- Собственная реализация Ed25519 на Python stdlib в `bundle.py`; подпись проверяется также серверной стороной Node crypto.

### Версии независимы

| Компонент | Источник версии | Значение в снимке |
|---|---|---|
| Web | `package.json` | `2.28.6` |
| Helper | `uploader/colonial_helper.py::VERSION` | `2.30.0` |
| Bootstrap launcher | `uploader/launcher.py::LAUNCHER_VERSION` | `1.5.0` |
| Парсер журналов | `uploader/journal_parser.py::PARSER_VERSION` | `7` |

Версия исходников не означает, что соответствующий пакет уже опубликован в канале обновлений пользователей.

## 4. Карта репозитория

| Путь | Назначение |
|---|---|
| `src/app/` | Страницы App Router, серверные API, auth callback |
| `src/proxy.ts` | Refresh сессии, maintenance, ограничения Supabase gateway, бюджет cookie |
| `src/components/` | Предметные UI-компоненты; особенно `Admin`, `Atlas`, `Architect`, `Carriers`, `Outfitting`, `GalaxyMap`, `SystemMap` |
| `src/hooks/` | Загрузка Атласа, слои карты, поиск, прогресс |
| `src/lib/` | Общая и серверная предметная логика, адаптеры внешних сервисов |
| `src/types/` | Разделяемые типы; значительная часть типов также объявлена рядом с реализацией |
| `supabase/migrations/` | Последовательные изменения схемы, RPC, индексов, RLS, Storage |
| `supabase/full_schema.sql` | Собранный снимок схемы; в текущем baseline не синхронен со всеми миграционными секциями |
| `scripts/` | Планировщик, импорт, обслуживание, мониторинг, update-agent и Node-тесты |
| `uploader/` | Весь Python-клиент и его тесты |
| `android-app/` | Kotlin/Jetpack Compose Android Monitor |
| `deploy/` | Docker/systemd/nginx, установка, обновление, диагностика, backup |
| `public/` | Статика, PWA/service worker, справочники и графика |
| `data/` | В том числе локальный dev-fallback биллинга; большие каталоги/релизы исключены из Git |

## 5. Основные подсистемы сайта и данные

| Подсистема | Реализации/контракты | Основные хранилища |
|---|---|---|
| Идентичность систем | `systemIdentity.ts`, `systemCoordinates.ts`, `systemOverview.ts`, `systemProgress.ts` | `system_coords`, агрегирующие SQL/RPC |
| Галактика и Атлас | `galaxySystems*`, `galaxyImport*`, `galaxyCopyWriter`, `galaxyShards`, `atlas*`, `spanshClient` | `galaxy_systems`, `galaxy_systems_meta`, кэши и сессии Атласа |
| Кольцо/маршруты | `routeEngine`, `routeHint`, `/api/route`, `/api/hubs` | `hubs`, `route_systems`, `route_tracks`, `helper_route_inbox` |
| Журналы/досье | `journalParser`, `journalIngest`, `deliveryImport`, `journalTelemetry`, `pilotDossier`, `cargoScope` | `deliveries`, `system_scans`, `pilot_stats`, `pilot_ship_state`, `journal_imports` |
| Учёт строек | `colonisationEvents`, `siteProjects`, `ravenDepotSnapshots`, `ravenColonial` | `colonisation_sites`, `construction_depot_snapshots`, `construction_projects`, `system_progress` |
| Проекты эскадрилий | `projects/*`, `/api/projects/[id]` | `projects`, `project_members`, `project_systems`, `project_build_plans` |
| Архитектор и проекты систем | `architect/*`, `/architect`, `/architect/projects` | `system_plans`, `system_architects`, `architect_projects`, `architect_project_*` |
| Станции/рынки | `stationCommerce`, `stationSearch*`, `market*` | `commerce_systems`, `station_commerce`, `station_inventory_snapshots`; есть и старые рыночные таблицы |
| Авианосцы | `fleetCarrier*`, `carrier*`, `/api/carriers` | `fleet_carriers`, cargo/events, directory/visits, schedules/history/watch |
| Фракции/PowerPlay | `systemObservations`, `bgs*`, `powerplay*`, `eddn/*` | `bgs_*`, `powerplay_*`, `eddn_listener_state` |
| Frontier CAPI | `capi/*`, `/api/capi`, `/api/cron/capi-*` | `capi_tokens`, `capi_profiles`, `capi_sync_jobs` |
| Цели сообщества | `communityGoal*`, `frontierCommunityGoals.mjs` | `community_goals`, персональные отчёты, история прогресса |
| Оснащение/инженеры | `outfitting/*`, `engineers/*`, UI Workspace | `outfitting_builds`, `outfitting_catalog`, JSON-справочники |
| Аккаунт/сообщество | auth, `squadron*`, `wikiAuth`, `supportTickets`, `notify` | profiles, squadrons, friends/messages, forum/wiki, support, notifications |
| Биллинг/магазин | `billingData`, `billing/*`, `/api/billing`, `/api/shop` | plans/subscriptions, balances, transactions, payment intents/webhooks, inventory/cosmetics |
| Обновления Helper | `uploaderStore`, `helperReleaseJobs`, upload sessions/chunks, `/api/uploader`, `/api/admin/uploader` | Файловое CAS-хранилище релизов и указатели stable/beta |
| Привязка Helper | `helperDevices`, `helperAuth`, `/api/uploader/link`, `/api/uploader/settings` | `helper_devices`, `helper_link_codes`, `helper_settings` |

### Не смешивать модели проектов

В проекте одновременно существуют:

1. `projects*` — коллективные проекты эскадрилий и их системы/участники.
2. `architect_projects*` — координация «Проектов систем».
3. `system_plans` — проектирование застройки в Архитекторе.
4. `construction_projects` — учёт реальных строек на сайте, включая созданные Helper без доступного Raven.
5. `colonisation_sites` и depot snapshots — фактические наблюдения игры.
6. Raven `buildId` и `system_progress` — внешняя карточка и её кэш.

Они связаны, но не взаимозаменяемы. У них разные права, жизненный цикл, идентификаторы и источники состояния.

## 6. Главные сквозные потоки

### 6.1 Приём журнала

```text
Journal.*.log
  ├─ Python journal_parser → Helper ApiClient → POST /api/logs/upload
  └─ Web journalParser → POST /api/logs/import
                                    ↓
                            journalIngest.ts
                              ├─ reset первой пачки, если явно запрошен
                              ├─ начальный ник, только если профиль пуст
                              ├─ deliveryImport → deliveries
                              ├─ journalTelemetry → стройки/сканы/статистика/эскадрилья
                              ├─ Community Goal reports/catalogue
                              └─ projects/projectSync → статусы + уведомления
```

- Дедупликация поставок опирается на одинаковый Python/TS `source_hash`.
- Python-формат: `journal-v2-` + SHA256 от вида, строки журнала и контекста, соединённых `\0`.
- Одна строка `ColonisationContribution` может породить несколько товарных строк; контекст товара обязателен.
- `CargoDepot` сам по себе не доказывает доставку на стройку. Нужен контекст станции и `delivery_kind`/`station_kind` (`cargoScope.ts` ↔ `colonisation.py`/`journal_parser.py`).
- Сбой дополнительной телеметрии или реакции проектов не должен превращать уже принятую поставку в повторяемый общий 500. В текущем конвейере эти ошибки отделены и журналируются.
- Старый `/api/journal/{parse,import}` остаётся отдельным путём: правки парсинга нельзя считать завершёнными, проверив только `/logs/*`.

### 6.2 Наблюдения систем

```text
Helper: BgsSnapshotCollector → POST /api/factions/sync ─┐
Web/CAPI/EDDN: журнальные наблюдения ──────────────────┼→ systemObservations
EDSM dumps: базовые данные с учётом свежести ──────────┘    ├→ bgs_apply_snapshots
                                                          └→ powerplay_apply_observations
                                                           ↓
                                            Атлас + /api/systems/overview
```

Неизвестный владелец PowerPlay не должен угадываться из произвольного элемента `Powers`. Нужно различать владельца, спорность, перечень присутствующих держав и возраст наблюдения.

### 6.3 Стройка и Raven

В актуальном Helper создание проекта сначала сохраняется на сайте через `/api/projects/register`; регистрация/обогащение в Raven идёт следом. Недоступность Raven не должна скрывать локально/сайтом известную стройку. `site_projects.py`, `src/lib/siteProjects.ts`, `systemProgress.ts` — важные места согласования источников.

Raven остаётся отдельной интеграцией: ключ RCC, `buildId`, primary/link/assign, поставки и пересчёт потребности. Отправка на сайт и отправка в Raven не образуют общую транзакцию. Для Raven используется отдельный ledger уже отправленных поставок.

### 6.4 Авианосцы и станции

- События носителя собираются и переживают сбой сети в отдельном outbox.
- Сайт применяет их идемпотентно и учитывает порядок по времени.
- Helper читает `/api/carriers/mine`, а не полагается только на Raven.
- `CarrierStats` задаёт достоверный суммарный груз, а рынок/переводы дают поимённые позиции: их нельзя безусловно складывать как независимые добавления.
- `StationCommerceCollector` публикует метаданные и **реально полученные** Market/Outfitting/Shipyard snapshots. Сам факт докования не означает пустой ассортимент.

## 7. Colonial Helper: устройство приложения

### 7.1 Точки входа и запуск

```text
ColonialHelperSetup.exe
  → installer.py / installer_window.py
  → устанавливает ColonialHelper.exe, маркер установки, ярлыки

ColonialHelper.exe
  → launcher.py::main
  → стартовое окно launcher_ui / launcher_window
      ├─ новости, Galnet, язык, канал, привязка профиля
      ├─ проверка/установка подписанного пакета
      └─ запуск Helper
           → проверка установленной/предыдущей/встроенной версии
           → установка sys.path и переменных окружения
           → colonial_helper.py::main
           → HelperWindow + ColonialHelperApp
```

Прямой запуск исходников: `python uploader/colonial_helper.py`. Запуск установленной копии и исходников отличается наличием launcher/bundle environment; в исходниках обновлять пакет установки обычно нечего.

`launcher.py` обеспечивает fallback к встроенному пакету, диагностику ошибок, конфигурацию CA для PyInstaller, выбор версии и rollback. У него есть режимы `--run-helper`, `--repair`, `--reinstall`, `--bundle-info`, `--launcher-version`, удаление.

### 7.2 Оркестратор и ядро

`colonial_helper.py` — **9 949 строк**, один большой `ColonialHelperApp`. Здесь одновременно находятся:

- создание страниц, callbacks и их wiring;
- настройки/credentials/миграция путей;
- первоначальное восстановление и watcher;
- маршруты и путешествия;
- согласование строек/Raven/сайта;
- API-вызовы и фоновые потоки;
- сбор состояния для оверлеев;
- обновления, завершение и диагностика.

Часть вычислений уже вынесена в чистые модули — это хорошая граница для дальнейших изменений. Но любая новая функция, добавленная прямо в оркестратор, увеличивает связанность.

### 7.3 Действующая навигация

Список проверен по `_build_notebook`, а не только по README:

| Раздел | Действующая реализация/роль |
|---|---|
| Подключение | `AuthPage`: токен сайта, адрес, CAPI через сайт, journal directory, RCC, EDSM, Inara, EDDN |
| Пилот | `EquipmentPage` + `PilotPage`: Odyssey-снаряжение и инфографика пилота/корабля |
| Загрузка логов | `UploadPage`: выбор/импорт, прогресс, watcher, кэш импортов, явный reset данных |
| Маршрут | `RouteSection`: `RoutePage` + `TravelPage`, импорт/экспорт, ведение по маршруту |
| Колонизатор | `ColonyPage`: список проектов, primary, привязка площадки, создание, сверка |
| BGS | `qt_factions.BgsSection`: фракции и `qt_powerplay.PowerplayPanel` |
| Оверлей | `OverlayPage`: блоки, поведение, профили, экраны, прозрачность и горячие клавиши |
| Экзобиология | `ExobioPage`: тела, роды, фильтры, прогресс сканирования |
| Лог | `LogPage`: уровни, записи, очистка, автопрокрутка |

**Отдельная вкладка «Карта системы» сейчас не зарегистрирована:** `tab_map = None`. `system_map.py`, `system_view.py`, `orrery.py`, экспорт и старые callbacks остаются в коде. Их наличие не означает, что действующий Qt-интерфейс показывает старую карту.

### 7.4 Qt и потоки

- `ui_qt.py`: общая тема, `ensure_app`, frameless окна, titlebar, диалоги, `Task/run_async`, защита скролла.
- `helper_window.py`: `QMainWindow`-адаптер, lifecycle и знакомые оркестратору методы.
- `helper_shell.py`: навигация и стек Qt-страниц, адаптивная ширина, строковый контракт `select()`.
- `helper_pages.py`: виджеты страниц и Actions/State-контракты. Здесь уже 4 508 строк — второй крупный UI-узел.
- `after()` возвращает выполнение на GUI thread через Qt-сигнал и QTimer. Создавать Qt-виджет/таймер непосредственно из произвольного worker thread нельзя.
- API, импорт, обновления, догрузка данных выполняются в Python threads/ThreadPoolExecutor; общая архитектура не asyncio.
- `_on_close` останавливает HUD, вызывает `dispatcher.stop(wait=False)`, сохраняет FC/BGS collectors и настройки, затем уничтожает окно. В этой реализации нет явного `_stop_watcher()`/join watcher и ожидания полного drain сетевых очередей. Не считать закрытие подтверждением доставки всех накопленных данных; это отдельная важная ветка тестирования (R3/R7).

### 7.5 Журнал, восстановление, watcher

1. Создаются трекеры, конфигурация и кэши, коллектора/outbox.
2. Восстанавливаются сведения из последних журналов и файлов состояния.
3. При старте watcher читаются сохранённые **байтовые offsets**, а не только mtime.
4. Необработанная история сверяется с `live=False`; выгрузки накапливаются, чтобы не делать HTTP на каждый файл.
5. Обычный цикл опрашивает journal примерно раз в **5 секунд**.
6. Обрабатываются только полные строки до последнего `\n`; неполный хвост остаётся следующему тику.
7. `parse_events()` делает один проход с hooks: snapshots, CG, трекеры, third-party dispatcher, экзобиология.
8. Читаются `Status.json`, `Cargo.json`, `ModulesInfo.json`, Market/Outfitting/Shipyard и маршрут, если доступны.
9. Коллекторы отправляют накопленное, UI обновляется через GUI scheduler.

Кэш импортированных файлов зависит от `PARSER_VERSION`: при изменении правил извлечения версия повышается, иначе уже прочитанная история не получит новые данные. Offset «прочитано с диска» **не равен** подтверждению «принято всеми серверами».

### 7.6 Чистые предметные модули

| Модуль | Ответственность |
|---|---|
| `journal_parser.py` | Поток событий, поставки, классификация, source hash, construction snapshots |
| `ship_tracker.py` | Состояние корабля, модули, hull/shield/fuel/ammo/cargo, journal + JSON |
| `pilot_equipment.py` | Костюмы, оружие, модификации, backpack и loadouts Odyssey, дисковый кэш |
| `carrier.py` | Личный/известные FC, суммарный и поимённый груз, согласование снимков/дельт |
| `colonisation.py` | Контекст площадки из нескольких событий, ресурсы, прогресс, черновик проекта |
| `site_projects.py` | Нормализация/слияние проектов сайта и Raven, потребность, подписи |
| `colony_build_types.py` | Справочник типов построек и нормализация |
| `route_tracker.py` | NavRoute/CSV, посещения, подсказки сайта и их кэш |
| `route_travel.py` | Разбор разных форматов маршрута, положение пилота, статистика, ETA |
| `route_hint.py`, `route_export.py` | Нормализация подсказки и CSV-поля/экспорт |
| `exobiology.py` | Состояние биосканов, роды, фильтры/прогнозы, кэш истории |
| `foot_map.py` | Поверхностные координаты/heading, корабль/SRV/POI/образцы, чистая геометрия |
| `factions_data.py`, `powerplay_data.py` | Журнал/хвост истории/сайт, свежесть, нормализация и состояния BGS/PowerPlay |
| `system_map.py`, `system_view.py`, `orrery.py` | Модель системы, общий payload и геометрия/размещение; не отдельная активная Qt-вкладка |
| `community_goals.py` | Персональные CG snapshots и накопление отчётов |
| `station_commerce.py`, `carrier_sync.py`, `bgs_sync.py`, `squadron_sync.py` | Предметные очереди/outbox и синхронизация с сайтом |

Экзобиологические прогнозы — упрощённая собственная модель, а не гарантированная полная база видов. Комментарии `exobiology.py` отдельно запрещают считать её перенесённым GPL-кодом SrvSurvey; лицензионное происхождение данных важно сохранять.

### 7.7 HUD

```text
Ship / Route / Carrier / Exobio / FootMap / Session state
                       ↓
       ColonialHelperApp._get_overlay_data
                       ↓
          OverlayManager (overlay.py)
             ├─ overlay_layout.py / overlay_options.py
             ├─ overlay_blocks.py / ship_hud.py / hud_icons.py
             └─ hud_window.py → Qt paint / WinAPI window styles
```

Десять ключей блоков: `route`, `status`, `ship`, `cargo`, `session`, `events`, `exobio`, `bio`, `carrier`, `footmap`.

Важны не только строки текста, но и размеры/позиции, монитор, DPI, фон/прозрачность, lock/click-through, режим отображения, фокус игры, idle timeout, hotkeys, профили и миграция старых настроек. За обнаружение игры отвечает `game_monitor.py`, за экраны `screens.py`, за WinAPI HUD `hud_win32.py`, за глобальные хоткеи `hotkeys.py`.

На не-Windows часть OS-функций становится no-op. Успех чистого теста на Linux не доказывает правильность HUD поверх Elite Dangerous в Windows.

## 8. API Helper и внешние интеграции

### Основные контракты сайта

| API | Назначение |
|---|---|
| `POST /api/auth/token` | Проверка отзываемого project API token |
| `POST /api/logs/upload` | Поставки, construction events, CG и дополнительная телеметрия |
| `POST /api/journal/reset` | Явная очистка данных журналов пользователя |
| `/api/cmdr/stats`, `/api/cmdr/ship-state` | Статистика и состояние корабля |
| `POST /api/cmdr/squadron` | Последнее явно наблюдённое игровое членство/ранг |
| `GET /api/cmdr/route` | Маршрут, переданный из Атласа |
| `/api/projects/active`, `/api/projects/register` | Независимый от доступности Raven учёт строек сайта |
| `/api/carriers/sync`, `/api/carriers/mine`, `/api/carriers/[id]` | События, перечень и карточки FC |
| `POST /api/stations/report` | Реальные снимки рынка/верфи/модулей и метаданные станции |
| `/api/factions/sync`, `/api/factions/system` | Передача наблюдений и чтение текущей системы |
| `GET /api/systems/overview` | В том числе PowerPlay текущей системы |
| `GET /api/systems/route-hint` | Стройка, открытие, звезда, тела и координаты следующей системы |
| `/api/atlas/system-bodies` | Чтение/передача сканов тел |
| `/api/capi/helper`, `/api/capi/profile` | Серверная CAPI-привязка и профиль без Frontier credentials в desktop |
| `/api/uploader/link/*`, `/api/uploader/settings` | Привязка устройства и перенос разрешённых настроек |
| `/api/uploader/manifest`, blobs/bundle/launcher/setup | Канал обновления и дистрибутивы |

`ApiClient`: delivery chunk **100**, construction chunk **500**, до **4** параллельных upload workers. Сервер `/logs/upload` допускает до 500 поставок, 500 construction events и 500 CG reports в одном запросе. Эти числа относятся к разным коллекциям и не должны смешиваться.

### Авторизация: три разных контура

1. **Web Supabase session/JWT**: cookie/Authorization, `supabaseServer.ts`, `requestUser.ts`, RLS.
2. **Project API token Helper**: хранится в БД SHA256-хешем, проверяется на отзыв. `helperAuth.resolveRequestUser` поддерживает mixed endpoints, но `/logs/upload` имеет собственный явный body-token контракт.
3. **Helper device token**: одноразовый 8-символьный код с TTL 10 минут обменивается на привязку устройства и профиль/настройки. Не следует считать его автоматически эквивалентным токену загрузки журналов.

Frontier OAuth — ещё один, **серверный** контур. Его access/refresh tokens не должны попадать в Helper или в браузерные DTO.

### Внешние сервисы

| Сервис | Текущее назначение и ограничения |
|---|---|
| Raven Colonial | Проекты/ресурсы/вклады/FC; RCC key; вторичная интеграция, не условие существования проекта сайта |
| EDSM | Journal upload, внешние тела/данные; нужны корректные CMDR и GameVersion/Build |
| Inara | Journal-derived events; CMDR из игры предпочтительнее ручного поля; Live-only ограничения |
| EDDN | Публичная публикация исследовательских событий; выключена по умолчанию, публикация необратима |
| Frontier CAPI | OAuth/PKCE, профили, journal и CG на сервере, platform/entitlement/binding проверки |
| Spansh | Каталог/дельты, поиск/маршруты; серверный импорт и fallback |
| Discord/VK/Yandex | Соответствующие OAuth/учётные записи/уведомления; Yandex также перевод контента |
| T-Bank | Серверная цена, платёжные intent/webhook, выдача средств/подписок и идемпотентность |

`ThirdPartyDispatcher` имеет отдельные проверки включения сервисов, очередь на 2 000 элементов и по умолчанию 2 worker threads. Переполнение намеренно не блокирует журнал: событие отбрасывается с учётом счётчика. Это best-effort очередь, а не durable transport.

Inara: до 25 событий в batch, накопление около 5 секунд, не менее 30 секунд между запросами; при закрытии есть принудительный flush. История во внешние сервисы по умолчанию не отправляется, пока пользователь явно не включил backfill. Это не означает, что исторические данные не должны попасть на собственный сайт.

`uploader/companion_api.py` — **legacy**, оставлен для совместимости/тестов. Возвращать его самостоятельный OAuth в production UI нельзя: единственный владелец Frontier binding — сайт. В `/api/capi/helper` вызывается server sync без повторного опроса journal/CG, поскольку локальные журналы Helper уже загружает отдельно.

## 9. Хранение, источники истины и идентичность

### Desktop

| Данные | Фактическое место/механизм |
|---|---|
| Код версий | Корень установки `bundle.install_root()`, `app/<version>`, stage, `state.json`, `install.json` |
| Настройки Helper | `Path.home()/AppData/Local/ColonialHelper/.colonial_helper.json` |
| Credentials Helper | Там же `.colonial_helper_credentials.json`; токены не шифруются, применяется `0600` |
| Кэши | Route hints, exobio, map, equipment, imported files, offsets и Raven ledger в `data_dir` Helper |
| Durable outbox | Станции, FC, BGS и squadron в `data_dir` |
| Настройки launcher | По умолчанию `Path.home()/.colonial_helper.json` — **пока расходится с Helper** |
| Device account launcher | По умолчанию `~/.colonial_helper_account.json`, рядом с launcher settings |
| Диагностика | `logs/launcher.log`, `logs/helper.log`; crash hooks/faulthandler |

`_migrate_old_configs` **копирует**, а не перемещает старые файлы, и только если нового ещё нет. Это сохраняет данные при миграции, но не синхронизирует дальнейшие записи между старым и новым путём.

`COLONIAL_HELPER_HOME`/маркер установки управляют корнем пакета. Текущий `ColonialHelperApp.data_dir` построен напрямую из `Path.home()/AppData/...`; это не универсальная абстракция user data и не обязательно тот же каталог, что у portable/custom install.

### Сервер

- Supabase/PostgreSQL — основное хранилище предметных данных.
- Service-role клиенты обходят RLS: в вызывающем API обязательно проверять пользователя, роль и ownership.
- Storage — изображения/аватары/медиа/облако точек и другие бинарные данные согласно конкретному разделу.
- Direct PG — большие импорты, COPY, массовые RPC, недоступные по времени короткому PostgREST-запросу.
- Релизы Helper — отдельный файловый том `UPLOADER_STORE_DIR`, не слой Docker image.
- Дампы галактики — отдельный каталог/диск, resume, сжатые shards/stream, без помещения больших наборов в Git.
- `billingData.ts` содержит локальный dev/fallback контур; его нельзя путать с production persistence.

### Идентификаторы и свежесть

- `systemIdentity.ts::systemKey` — единое сравнение имён: очистка control chars, схлопывание пробелов, trim, lowercase.
- `systemId64` — строка/BigInt с проверкой диапазона. Значения шире безопасного JS Number не следует безусловно преобразовывать в `number`.
- `SystemAddress`, `MarketID`, `buildId`, `project_key`, SQL id проекта и id тела — разные сущности.
- Источник и timestamp — часть предметного состояния, не декоративные подписи.
- Нет данных ≠ ноль; неизвестный владелец ≠ первый из списка; нет свежего скана ≠ отсутствие биологии; нет `SquadronStartup` ≠ выход из эскадрильи.

## 10. Доставка обновлений Helper

### Контракт

1. `build_bundle.py` собирает разрешённые Python/data файлы и manifest; bootstrap/build/install/uninstall части исключены из обычного payload.
2. Manifest содержит schema/channel/version/entry/min_launcher/files/signature.
3. На сервере `uploaderStore.ts` проверяет подпись, размеры и hashes, хранит blobs по SHA256 и указатели каналов.
4. `bundle_updater.py` получает manifest, проверяет доверенный Ed25519 key, планирует изменённые файлы, загружает/собирает stage.
5. `bundle.py` проверяет directory, активирует пакет, хранит previous и здоровье запуска.
6. Helper отмечает готовый запуск healthy. Неуспешные trial-запуски приводят к rollback; хранится текущая и предыдущая версия.

Ограничения формата: schema 1, до 400 файлов, 16 MiB на файл, 64 MiB суммарно. Path traversal и недопустимые расширения должны отвергаться.

### Разные артефакты

- `ColonialHelperSetup.exe` — первичная установка/восстановление/ярлыки.
- `ColonialHelper.exe` — базовый bootstrap launcher с runtime и встроенным fallback.
- Подписанный bundle — частые изменения Python-кода.

Их нельзя подменять друг другом. Новая Python-зависимость, отсутствующая в EXE, может потребовать новую базовую сборку и повышение `min_launcher`, а не только новый bundle.

Windows PE собирается на Windows: `build_exe.py`, затем `build_installer.py`; админский `/api/admin/uploader/build-kit` генерирует комплект с публичными ключами. Слияние исходников само по себе не публикует готовый пакет пользователям.

**Критическое исключение из заявленной безопасной модели — см. риск R1 ниже.**

## 11. Развёртывание и эксплуатация

- `next.config.mjs`: standalone output, ограниченные build workers, gateway rewrite и preview origins.
- Базовая схема: reverse proxy → Next `web` → self-hosted Supabase / PostgreSQL.
- `NEXT_PUBLIC_*` встраиваются при сборке. Изменение URL/anon key зачастую требует rebuild, а не только restart.
- При `NEXT_PUBLIC_SUPABASE_URL=https://<site>/api/supabase` нужен private `SUPABASE_INTERNAL_URL`; config не разрешает молча собрать неработающий туннель.
- `src/proxy.ts` разрешает только ожидаемые public prefixes Supabase и не проксирует Studio/pg-meta. Сам gateway не должен рекурсивно запускать session refresh.
- Cookie budget и auth headers предотвращают разросшиеся заголовки и кэширование пользовательской сессии.
- `jobs` — единственный планировщик. `scripts/job-schedule.mjs`: 12 задач, 11 включены по умолчанию; galaxy-import opt-in.
- Периоды: capi jobs — минута, обычный capi sync — 5 минут, progress — 30 минут; CG/cleanup/translate/дампы/Galnet — по своим графикам.
- `monitor-agent` и `update-agent` — отдельные привилегированные сервисы. Web не должен получать Docker socket/возможность произвольного исполнения deployment-команд.
- Есть восстановление сети Supabase после пересоздания контейнеров и защита build cache; важны при self-hosted обновлениях.
- Документы эксплуатации: `DEPLOY.md`, `SELFHOST.md`, `MONITORING.md`, `POST-MIGRATION.md`, `UPLOADER-UPDATE-STRUCTURE.md`.

### Android / mobile

`/m-admin` — отдельный мобильный web UI. `android-app/` — Kotlin/Compose + Retrofit/OkHttp, JWT в EncryptedSharedPreferences, polling агрегатора около 20 секунд. Это монитор/админский клиент, **не порт Python Helper**.

Release требует HTTPS, debug допускает ограниченные локальные адреса. В репозитории нет `gradlew`, несмотря на npm-скрипт `android:assemble`; сборку и дистрибуцию Android нужно проверять отдельно в Android toolchain.

## 12. Риски и технический долг перед разработкой

Порядок ниже — предварительная техническая приоритизация, не список уже исправленных проблем.

### R1 — критично: приватный ключ доверенного канала обновлений находится в исходниках

**Подтверждено кодом:** `src/lib/uploaderStore.ts` объявляет `CANONICAL_SIGN_SEED_B64`; тот же модуль создаёт из него signing key и включает его в конфигурацию. Соответствующий public key доверен `uploader/bundle.py::TRUSTED_KEYS`.

Значение seed намеренно не воспроизводится в этом отчёте. Подпись на таком ключе не доказывает эксклюзивное происхождение пакета от владельца сервера: любой получивший исходники может вычислять подходящие подписи. Это не само по себе доказательство возможности заменить пакет на production HTTPS-сервере, но нарушение границы доверия и опасная предпосылка компрометации канала.

**Нужно до широкого распространения:** вывести секрет из исходников в защищённое хранилище, спланировать ротацию/удаление старого доверенного ключа, миграцию существующих EXE/bundle, серверных ключей и build-kit. Простое удаление строки или выпуск новой подписи не отзывает доверие уже установленных клиентов. Отдельно проверить историю Git и резервные копии.

### R2 — высоко: настройки launcher и Helper расходятся по пути

**Подтверждено кодом:** `launcher_settings.DEFAULT_PATH` и `launcher.configured_update_channel()` читают home-root, а `ColonialHelperApp` читает/пишет AppData. Миграция одноразово копирует старые файлы и не синхронизирует изменения.

Следствия для воспроизведения: язык/канал/адрес/профили launcher и Helper могут расходиться; облачная раскладка может быть скачана не в тот файл; custom install/uninstall может учитывать не все данные. Нужна общая функция путей с совместимой миграцией, а не ещё одна константа в UI.

### R3 — высоко: прочитанный offset не гарантирует durable ACK поставки

**Подтверждено структурой:** `_pending_watcher_deliveries` хранится в памяти, а journal offsets сохраняются независимо после обработки. У станций/FC/BGS/squadron есть файловые outbox, у live-поставок нет равноценного общего durable ACK-журнала.

**Риск, требующий fault-injection:** API не принимает пачку → offsets уже продвинуты → процесс завершается → автоматический повтор при следующем старте может не прочитать эту строку вновь. В первичной сверке offsets также сохраняются до окончательной deferred-выгрузки. Ручной повторный импорт способен восстановить данные, но это не гарантия автоматической доставки. Рассмотреть durable outbox либо separate read/ack checkpoints; серверный `source_hash` уже позволяет безопасный повтор.

### R4 — высоко: проверка CMDR происходит после hooks

В `_process_journal_changes` `parse_events(...hooks=...)` вызывается до проверки `tick_cmdr_name` на несовпадение. Hooks уже обновляют трекеры, collectors, а в live могут ставить внешние события в очередь. Отклонение списка поставок после этого не отменяет побочные эффекты.

Это **подтверждённый порядок вызовов**, но фактическое смешение аккаунтов нужно воспроизвести тестом с несколькими CMDR/файлами и контекстом токена. CG в этом месте уже добавляются в collector только после проверки; остальным hooks нужна отдельная проверка границы владельца.

### R5 — средне/высоко: baseline проверок не зелёный

11 Node failures, полный Python прогон блокируется системной GUI-зависимостью и неполными skip-guards; см. раздел 13. Нельзя приписывать последующим изменениям все эти отказы, но нельзя и игнорировать их при релизе.

### R6 — средне: очень крупные узлы и размытые границы

`colonial_helper.py` ~10k строк, `helper_pages.py` ~4.5k, `overlay_blocks.py` ~2.9k. Несколько потоков обращаются к общему состоянию, встречаются широкие `except Exception: pass`. Это усложняет диагностику и делает безопасный рефакторинг зависимым от characterization tests.

Предпочтительно постепенно выделять сервисы по владельцу состояния: journal ingestion, delivery outbox, settings repository, colony sync, travel controller. Не переписывать всё приложение до согласования конкретной задачи.

### R7 — средне: разные гарантии очередей и сохранения

- Third-party dispatcher best-effort и ограничен по объёму.
- Ошибка отдельного внешнего POST не означает надёжной досылки после перезапуска.
- `save_config()` Helper пишет общий JSON непосредственно; launcher settings сохраняет атомарно. На сбое записи Helper возможен повреждённый файл и fallback к пустому состоянию.
- Отдельный credentials файл снижает последствия, но токены хранятся в открытом JSON; Windows ACL/защищённое хранилище отдельно не доказаны `chmod(0600)`.
- Фиксированные `.tmp` в ряде модулей требуют проверки при двух экземплярах. Для offsets уже предусмотрены уникальные временные имена и retry Windows locks.

### R8 — средне: drift схемы, документации и межъязыковых моделей

- Тест снимка SQL сообщает о двух отсутствующих миграционных секциях от 20 ноября. Нельзя заключать по этому одному тесту, что соответствующих таблиц вообще нет в snapshot/production.
- Python/TS дублируют parser, classifiers, payload карты, carrier/squadron collectors, типы построек и ряд справочников. Нужны parity fixtures.
- README/комментарии описывают Tk, старую карту, прежние версии и гарантии persistence, которые надо сверять с реализацией.
- Наличие `strict` не устраняет широкое использование `any` в SDK/RPC и предметных участках.

### R9 — средне: ограничения scale-out

Rate limits (`rateLimit.ts`), часть caches, mutexes и состояние фоновых процессов локальны одному Node-процессу. Нельзя без дополнительной проверки масштабировать web/jobs в несколько экземпляров. CAPI использует перечитывание БД и локальный mutex, но атомарность cross-process операций требует отдельного разбора.

## 13. Проверки baseline

### Окружение анализа

Node **22.22.3**, npm **10.9.8**, Python **3.11.2**. `npm ci --no-audit --no-fund` завершился успешно (316 пакетов). Для Python создана исключённая из Git `.venv`; установлены requests, PySide6-Essentials **6.11.3**, pyperclip. PyInstaller/Windows toolchain не устанавливались для выпуска EXE.

### Результаты

| Проверка | Результат |
|---|---|
| `TEST_CONCURRENCY=4 npm test` | **2 179 тестов: 2 168 pass, 11 fail**, 0 skip; около 349 секунд |
| `python -m unittest discover -s uploader/tests -q` с offscreen | **1 970 тестов, 234 errors, 440 skipped**, около 39.5 сек; стенд не содержит `libGL.so.1`, есть также тесты без корректного skip после import failure |
| Чистый Python-контур (12 перечисленных ниже модулей тестов) | **301 тест, OK**, около 7.5 сек |
| TypeScript | **PASS**: `NODE_OPTIONS=--max-old-space-size=2800 npm run typecheck` завершился с кодом 0. Первый запуск одновременно с тяжёлыми тестами был остановлен окружением; отдельный повтор успешен |
| Production build / browser E2E | Не запускались; это не заменяется unit-тестами |
| Windows Setup/EXE/HUD и Android APK | Не собирались и не проверялись в целевом окружении |
| Production DB / live Raven, EDSM, Inara, EDDN, Frontier | Не проверялись реальными пользовательскими credentials |

Ошибки Python здесь нельзя массово объявлять дефектами приложения. Импорт `PySide6.QtGui` на данном Linux завершается `ImportError: libGL.so.1`; часть тестов это корректно пропускает, часть продолжает и падает вторично (`NameError`, import error). Нужен повтор полного набора в полноценной Qt-среде.

### Все 11 Node failures

| Файл | Отказ в текущем запуске | Статус интерпретации |
|---|---|---|
| `avatar-squadron-routes.test.mjs` | Ожидается прямой Storage URL, фактически same-origin gateway URL | Несовпадение ожидания с текущей URL-политикой; не доказательство сломанной загрузки |
| `carrier-jump-schedule.test.mjs` | `null` вместо ожидаемой даты `2026-11-11T14:00:00.000Z` | Проверить дату/семантику расписания; не объявлять причину без воспроизведения |
| `community-goal-admin-api.test.mjs` | Не найден ожидаемый `publicGoal` в Frontier CAPI сценарии | Нужен отдельный разбор fixture/времени/продвижения каталога |
| `i18n-locale-parity.test.mjs` | Не совпадает набор переводов (например, 11 admin-ключей в de) | Подтверждён drift словаря |
| `i18n-locale-parity.test.mjs` | Есть используемые, но не объявленные ключи | `map.engineInit`, `anav.galaxyCatalogue`, admin фото/эскадрильи, `common.retry` |
| `i18n-placeholders.test.mjs` | Повторная проверка неизвестных ключей `t()` | Тот же класс проблемы, отдельный упавший тест |
| `large-route-ui.test.mjs` | esbuild: в stub `supabaseClient` нет `getAccessToken`, который импортирует `ShipImagesAdmin` | Дефект/устаревание тестового стенда; не доказательство отсутствия экспорта в production |
| `migrations-sql.test.mjs` | Не учтены `20261120000000_ship_images_bucket.sql`, `20261120010000_user_ship_photos.sql` в snapshot-секциях | Подтверждён drift сборного SQL |
| `squadron-images.test.mjs` | Прямой public Storage URL vs gateway URL | Проверить/обновить URL-контракт |
| `system-coordinates-ui.test.mjs` | Такой же отсутствующий `getAccessToken` в UI stub | Общая проблема тестового стенда |
| `tbank-payments.test.mjs` | Ожидалось 500, получено 525 | Проверить fixture/действующие бонусы подписки; причину пока не считать установленной |

Полный Node-прогон менял отслеживаемый `data/billing_store.json`. Этот **побочный эффект тестов восстановлен** до исходного состояния после завершения; не включать его в доработки. Саму герметичность тестов биллинга следует улучшить отдельно.

### Команды для повторения

```bash
npm ci --no-audit --no-fund
npm run typecheck
TEST_CONCURRENCY=4 npm test
npm run test:quick

python -m venv .venv
# Для полного набора нужны и системные библиотеки Qt (включая libGL),
# не только Python wheel. Полный requirements также включает PyInstaller.
.venv/bin/pip install -r uploader/requirements.txt
QT_QPA_PLATFORM=offscreen .venv/bin/python -m unittest discover -s uploader/tests -q

# Успешно проверенный чистый контур:
PYTHONPATH=uploader:uploader/tests QT_QPA_PLATFORM=offscreen \
.venv/bin/python -m unittest -q \
  test_route_travel test_squadron_sync test_station_commerce test_bgs_sync \
  test_carrier_sync test_site_projects test_powerplay_data test_factions_data \
  test_community_goals test_bundle test_bundle_updater test_third_party_api
```

Playwright настроен на уже запущенный сайт (`PLAYWRIGHT_BASE_URL`), отдельного `webServer` в config нет. Для него дополнительно требуются browser executable и сценарно подходящее окружение/данные.

## 14. Правила безопасной последующей доработки

1. **Уточнить пользовательский сценарий и затрагиваемую границу.** UI, предметная функция, transport, серверный API, SQL/RLS и release — отдельные уровни.
2. Зафиксировать baseline и regression test до исправления. Отличать текущие 11 Node failures и Qt environment errors от новых ошибок.
3. Не менять форму ответа Helper API без совместимости со старыми установленными клиентами; additive-поля предпочтительнее удаления/переименования.
4. Не менять hash/нормализацию журналов только в одном языке. Добавлять общие fixtures для TS/Python, учитывать `PARSER_VERSION` и реимпорт.
5. При изменении persistence проверять перезапуск, потерю сети, 429/5xx, partial success, несколько CMDR, несколько экземпляров и неполную строку журнала.
6. Не выполнять сетевые вызовы/долгие вычисления на GUI thread и не трогать Qt-виджеты напрямую из worker threads.
7. Не превращать отсутствие наблюдения в ноль или отрицательный факт. Источник/свежесть/unknown сохранять сквозным образом.
8. Для SQL: новая миграция, обратная совместимость, RLS/grants, RPC, индексы, синхронизация full_schema, PGlite/SQL tests. Не применять миграции к production в рамках простого анализа.
9. Для HUD: Windows smoke test на нескольких DPI/мониторах, в игре/без неё, locked/unlocked и при смене фокуса.
10. Для updater: подписи, path/size limits, partial downloads, offline fallback, rollback и repair; отдельный план R1.
11. Для новой runtime-зависимости: решить, нужен ли новый launcher EXE и `min_launcher`, проверить Windows build-kit.
12. Для релиза Helper: VERSION/CHANGES → тесты → подписанный пакет/канал → проверка обновления с прежней установленной версии. Для изменений runtime — дополнительно EXE/Setup.
13. Для web: typecheck/tests/build и проверка UI; для deployment — стенд с настоящим Supabase gateway/storage/realtime и сетями Compose.

### Быстрый выбор файлов по будущей задаче

| Задача | Начать с | Сопутствующие проверки |
|---|---|---|
| Элемент интерфейса Helper | `helper_pages.py`, соответствующий `_build_tab_*`/callback в `colonial_helper.py` | Qt offscreen + app-flow tests |
| Токен/подключение | `api_client.py`, `site_config.py`, AuthPage, `/api/auth/token`, `helperAuth.ts` | Wrong host, revoke, TLS, redirects, account switch |
| Настройки/язык/профили | `launcher_settings`, `launcher_account`, `load_config/save_config`, `overlay` | R2, migration, сохранение неизвестных ключей, restart |
| Журнал/тоннаж | Python/TS parser, `cargoScope`, `deliveryImport`, `journalIngest` | Hash parity, тип станции, дедуп, reset/reimport |
| Потеря поставок | `_watcher_loop`, `_process_journal_changes`, deferred/pending queues | R3/R4, fault injection, durable ACK |
| Стройка/потребность | `colonisation`, `site_projects`, Raven client, `siteProjects.ts`, `systemProgress` | Разные идентификаторы, offline Raven, snapshots vs deltas |
| Маршрут/путешествие | `route_travel`, `route_tracker`, `route_hint`, `route_export` | Clipboard dedup, off-route, pin, restart, unknown distances |
| Корабль/HUD | `ship_tracker`, `ship_hud`, `overlay_blocks`, `hud_window`, `hud_win32` | Приоритет journal/JSON, health/ammo semantics, Windows |
| Экзобиология | `exobiology`, `foot_map`, ExobioPage, BIO/EXOBIO/FOOTMAP blocks | History/cache, род vs вид, sample progress, unknown data |
| Фракции/PowerPlay | `factions_data`, `powerplay_data`, `bgs_sync`, `systemObservations`, SQL | Freshness/source, owner vs presence, journal fallback |
| Эскадрилья | `squadron_sync`, `/api/cmdr/squadron`, `squadronGame`, `squadronData` | Игра не выдаёт сайт-роли; отсутствие события не доказывает выход |
| Обновление/Setup | `bundle*`, `launcher*`, installer/uninstall, `uploaderStore`, admin uploader | R1/R2, trusted key rotation, launcher/runtime compatibility |

## 15. Рабочий вывод

Архитектурная основа понятна: **журнальные наблюдения → предметные трекеры/коллекторы → API сайта и независимые интеграции → PostgreSQL/кэши → web/HUD**. Для реализации доработок уже определены точки входа, владельцы состояния, места межъязыковой совместимости и способы проверки.

Главное до крупных изменений: закрыть/согласовать риск доверенного signing seed, устранить расхождение путей конфигурации, проверить durability journal pipeline и получить воспроизводимый зелёный контур на полноценном Qt/Windows стенде. Это предложения к следующему этапу, а не самовольные изменения приложения.
