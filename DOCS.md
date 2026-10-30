# Документация ED Ring Colony — карта

> Состояние на **19.10.2026**: сайт **2.25.2**, Colonial Helper **2.17.0**,
> 90 SQL-миграций, 231 API-маршрут, 150 файлов автотестов (1592 проверки, все
> проходят), 1416 тестов Helper.
> Документы лежат там же, где лежали всегда: на их имена ссылаются код, тесты и
> админка, поэтому файлы не переносятся и не переименовываются.

## С чего начать

| Задача | Куда смотреть |
|---|---|
| Что это за проект, что умеет, как запустить локально | [README.md](README.md) |
| Как устроено: стек, маршруты API, таблицы, интеграции, фоновые задачи | [CONTEXT.md](CONTEXT.md) |
| Как разделы связаны в единый механизм: анализ модулей, найденные разрывы, план, правила для новых функций | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Что и когда менялось | [CHANGELOG.md](CHANGELOG.md) (сайт), [uploader/CHANGES.md](uploader/CHANGES.md) (Helper) |
| Внешний вид: палитра, компоненты, иконки | [DESIGN.md](DESIGN.md) |
| Обновить работающий сервер | [MONITORING.md](MONITORING.md) → «Ручное обновление проекта» (Админка → Мониторинг → «Обновить сейчас») |
| Регистрация отвечает «временно закрыта», хотя SMTP настроен | [SIGNUP-DISABLED-FIX.md](SIGNUP-DISABLED-FIX.md) |
| Сайт не открывается: «слишком длинные cookie» (400/431), инкогнито помогает | [COOKIE-SIZE-FIX.md](COOKIE-SIZE-FIX.md) — диагностика: `sh deploy/diag-cookies.sh` |
| Поставить сервер с нуля | [SELFHOST.md](SELFHOST.md), [UBUNTU20-INSTALL.md](UBUNTU20-INSTALL.md), [SERVER-SETUP.md](SERVER-SETUP.md) |
| Все переменные окружения | [.env.example](.env.example) |
| Схема базы и миграции | [supabase/DATABASE.md](supabase/DATABASE.md) |

## Функции сайта (актуальные справочники)

| Документ | О чём |
|---|---|
| [ARCHITECT.md](ARCHITECT.md) | Архитектор системы `/architect`: планировщик застройки, планы на сервере, назначенный архитектор, «Проекты систем» `/architect/projects` (участники, авианосцы, прогресс, лидеры) |
| [FLEET-CARRIERS.md](FLEET-CARRIERS.md) | Учёт авианосцев на сайте (`fleet_carriers`), привязка личного и эскадренного носителя, груз и банк эскадры, слой «Авианосцы» на карте и в Atlas |
| [POWERPLAY.md](POWERPLAY.md) | Вкладка Atlas «PowerPlay», ночной дамп EDSM (архив → куски → база, архив с компьютера), задача `powerplay-sync`, раздел админки |
| [FACTIONS.md](FACTIONS.md) | Минорные фракции: вкладка Atlas «Фракции», таблицы `bgs_*`, загрузка дампа EDSM (скачивание → разбивка → запись), загрузка архива с компьютера, обновления от Helper и журналов |
| [SPANSH-IMPORT.md](SPANSH-IMPORT.md) | Каталог всех систем галактики (`galaxy_systems`): дамп Spansh, дельты, шарды, отдельный диск, облако точек «Все системы» |
| [GALAXY-IMPORT-SPEED.md](GALAXY-IMPORT-SPEED.md) | Скорость заливки каталога: `COPY` в staging, снятие индексов, прямой Postgres |
| [STATION-COMMERCE.md](STATION-COMMERCE.md) | Станции и рынки в базе проекта, поиск по станциям `/station-search`: список станций с раскрытием, быстрый выбор и точный поиск |
| [ATLAS-SEARCH-REWORK.md](ATLAS-SEARCH-REWORK.md) | Как устроены поисковики Atlas: шаговые сессии, кэш проекта, прогресс на 3D-карте |
| [ATLAS-RING-RESULT-FIX.md](ATLAS-RING-RESULT-FIX.md), [ATLAS-RING-LIMITS-FIX.md](ATLAS-RING-LIMITS-FIX.md) | Галактическое кольцо: требования к маршруту, результат на карте, сохранение в проект, CSV |
| [ATLAS-NEARBY-SEARCH.md](ATLAS-NEARBY-SEARCH.md) | Вкладка Atlas «Поблизости» (сфера/куб 1–50 св. лет) |
| [ATLAS-MARKET-FIX.md](ATLAS-MARKET-FIX.md) | Вкладка Atlas «Рынок»: поиск товаров для стройки, материалы стройплощадки |
| [SYSTEM-COORDINATE-FALLBACK.md](SYSTEM-COORDINATE-FALLBACK.md) | Координаты хабов, маршрута и проектов: EDSM → каталог → Spansh |
| [COLONISATION-SITES-REWORK.md](COLONISATION-SITES-REWORK.md) | Данные стройплощадок: одна строка на площадку (`colonisation_sites`), снимки прогресса, очистка |
| [OUTFITTING-ADMIN.md](OUTFITTING-ADMIN.md) | Админка верфи: модули, корабли, броня, заводская инженерия, буквы креплений (F/G/T) |
| [src/components/GalaxyMap/INTEGRATION.md](src/components/GalaxyMap/INTEGRATION.md) | Слои 3D-карты галактики: какие есть, откуда данные, где подключаются |
| [public/wiki/colonization-guide/article.md](public/wiki/colonization-guide/article.md) | Текст гайда по колонизации для вики (с картинками рядом) |

## Colonial Helper (десктопная программа)

| Документ | О чём |
|---|---|
| [uploader/README.md](uploader/README.md) | Что умеет программа, установка, сборка, как обновляется, заметки к версиям |
| [uploader/CHANGES.md](uploader/CHANGES.md) | Подробный журнал по «раундам». **Первый раздел — заметки текущего релиза** (их берёт `build_bundle.py`) |
| [UPLOADER-UPDATE-STRUCTURE.md](UPLOADER-UPDATE-STRUCTURE.md) | Канал обновлений: лаунчер + пакет кода, подпись Ed25519, публикация из админки |
| [HELPER-LAUNCHER-LINK.md](HELPER-LAUNCHER-LINK.md) | Лаунчер: возврат после Helper, профиль пилота в правом верхнем углу, привязка учётной записи кодом, перенос раскладки оверлея, загрузка установщика Setup в админке |

## База данных

| Документ | О чём |
|---|---|
| [supabase/DATABASE.md](supabase/DATABASE.md) | Состав `supabase/`, таблицы по разделам, как применяются миграции на сервере, развёртывание с нуля, снимок `full_schema.sql` |
| [SQL-MIGRATIONS-AUDIT.md](SQL-MIGRATIONS-AUDIT.md) | Аудит миграций от 25.09.2026 (история; проверка снимка теперь в `scripts/tests/migrations-sql.test.mjs`) |

## Развёртывание и эксплуатация

| Документ | О чём |
|---|---|
| [MONITORING.md](MONITORING.md) | Админка → Мониторинг: состояние сервисов, обновление проекта кнопкой, миграции, ключи `.env.production`, SMTP, бэкапы, уборка диска |
| [SELFHOST.md](SELFHOST.md) | Всё на одной машине: сайт + self-hosted Supabase (`deploy/selfhost/install.sh`) |
| [UBUNTU20-INSTALL.md](UBUNTU20-INSTALL.md) | То же пошагово для Ubuntu 20.04 с переносом архивом |
| [SERVER-SETUP.md](SERVER-SETUP.md) | Свой сервер + облачный Supabase |
| [DEPLOY.md](DEPLOY.md) | Справка по переносу с Vercel на VPS: что было привязано к Vercel, Docker, nginx, systemd |
| [POST-MIGRATION.md](POST-MIGRATION.md) | Что изменилось после переезда (сентябрь 2026) и как устроены `jobs`, OAuth, Uploader на своём сервере |
| [UBUNTU20-UPGRADE.md](UBUNTU20-UPGRADE.md) | Разовая команда переезда от 21.09.2026 (история; обычные обновления — через админку) |
| [.env.example](.env.example) | Все переменные с пояснениями |

## Вход, почта и платежи

| Документ | О чём |
|---|---|
| [VK-ID-SETUP.md](VK-ID-SETUP.md) | Вход и привязка через VK ID (по умолчанию выключено) |
| [YANDEX-ID-SETUP.md](YANDEX-ID-SETUP.md) | Вход и привязка через Яндекс ID (по умолчанию выключено) |
| [TBANK-SETUP.md](TBANK-SETUP.md) | Разовые платежи Т-Банка через страницу банка |
| [MONITORING.md](MONITORING.md) → «Отправка писем» | SMTP для регистрации и восстановления пароля |

## Мобильная админка

| Документ | О чём |
|---|---|
| [MOBILE-ADMIN.md](MOBILE-ADMIN.md) | `/m-admin` (PWA) и Android-приложение, общий агрегатор `/api/mobile/admin-summary` |
| [android-app/README.md](android-app/README.md), [android-app/QUICKSTART.md](android-app/QUICKSTART.md) | Сборка APK (Android Studio или `gradle wrapper` + `./gradlew`); ошибки сборки после #139 исправлены в 2.25.2 — см. «Сборка после #139» |

## Тесты

| Документ | О чём |
|---|---|
| [README.md](README.md) → «Тесты» | Команды, контуры `quick`/полный, известные падения |
| [TEST-SUITE-SPEED.md](TEST-SUITE-SPEED.md) | Как устроен параллельный прогон и кэш сборок esbuild |
| [DOCKER-TESTS-HERMETIC-FIX.md](DOCKER-TESTS-HERMETIC-FIX.md) | Почему тесты обязаны быть герметичными внутри `docker build` |

## История: разборы инцидентов и правок

Эти документы описывают состояние **на дату правки**; актуальность и
продолжение каждого — в колонке «Статус». У заменённых разборов сверху также
стоит пометка со ссылкой на новый.

| Документ | Дата · PR | О чём | Статус |
|---|---|---|---|
| [PROFILES-PII-RLS-FIX.md](PROFILES-PII-RLS-FIX.md) | 15.10 · #135 | Персональные данные `profiles` и самоназначение админом | Актуально; дополнено #139 (`20261016000000_credentials_and_views_hardening.sql`) |
| [ATLAS-MARKET-FIX.md](ATLAS-MARKET-FIX.md) | 13.10 · #131 | Устойчивый поиск рынка, материалы стройплощадки | Актуально |
| [ATLAS-NEARBY-SEARCH.md](ATLAS-NEARBY-SEARCH.md) | 13.10 · #131 | Вкладка «Поблизости» | Актуально |
| [SYSTEM-COORDINATE-FALLBACK.md](SYSTEM-COORDINATE-FALLBACK.md) | 13.10 · #132 | Запасной поиск координат через Spansh | Актуально |
| [ATLAS-RING-RESULT-FIX.md](ATLAS-RING-RESULT-FIX.md) | 12.10 · #119 | Кольцо на карте, сохранение в проект | Актуально; дополнено #120–#128 |
| [ATLAS-RING-LIMITS-FIX.md](ATLAS-RING-LIMITS-FIX.md) | 12.10 · #118 | 504 на кольце, требования к маршруту | Актуально; геометрия расширена в #124/#128 |
| [TEST-SUITE-SPEED.md](TEST-SUITE-SPEED.md) | 12.10 · #119 | Параллельный прогон тестов | Механизм актуален, цифры — на дату |
| [NEBULA-VISUAL-FIX.md](NEBULA-VISUAL-FIX.md) | 11.10 · #116 | Туманности на карте | Актуально |
| [CAPI-EGS-PROFILE-400-CONTEXT.md](CAPI-EGS-PROFILE-400-CONTEXT.md) | 25.10 · case note | Свежая диагностика EGS, HTTP 400, таймлайн и возможные обходы | **Текущий контекст; причина на стороне Frontier вероятна, но не доказана** |
| [CAPI-ENTITLEMENT-FIX.md](CAPI-ENTITLEMENT-FIX.md) | 10.10 · #112 | HTTP 400 CAPI после верного входа через EGS/Steam | Общая логика OAuth/entitlement; конкретный кейс — в case note |
| [CAPI-STABILITY-AND-STATS-SOURCE.md](CAPI-STABILITY-AND-STATS-SOURCE.md) | 09.10 · #110 | Стабильность подключений CAPI, источник сводки пилота | Актуально, кроме трактовки HTTP 400 (см. ENTITLEMENT) |
| [BUILD-KIT-KEYS-FIX.md](BUILD-KIT-KEYS-FIX.md) | 09.10 · #109 | Встраивание ключей в комплект первой сборки | Актуально |
| [COLONISATION-SITES-REWORK.md](COLONISATION-SITES-REWORK.md) | 09.10 · #105 | `colonisation_events` 12+ ГБ → `colonisation_sites` | **Действующая схема** |
| [GALAXY-POINTS-PUBLISH-FIX.md](GALAXY-POINTS-PUBLISH-FIX.md) | 08.10 · #102 | Публикация облака точек при сбое хранилища | Актуально |
| [COOKIE-SIZE-FIX.md](COOKIE-SIZE-FIX.md) | 31.10 · #243 | Сайт не открывается: заголовок Cookie длиннее пределов nginx (8 КБ) и Node (16 КБ) | Актуально |
| [SIGNUP-DISABLED-FIX.md](SIGNUP-DISABLED-FIX.md) | 28.10 · #228 | `disable_signup=true` при рабочем SMTP: имя ключа `DISABLE_SIGNUP` и пересоздание `auth` | Актуально |
| [DOCKER-TESTS-HERMETIC-FIX.md](DOCKER-TESTS-HERMETIC-FIX.md) | 02.10 · #86 | Тесты внутри `docker build` | Принцип актуален |
| [DISK-LEAK-CONTAINER-CONFLICT-FIX.md](DISK-LEAK-CONTAINER-CONFLICT-FIX.md) | 02.10 · #84 | Конфликт имени контейнера и утечка диска | Актуально |
| [DISK-LEAK-CACHE-MOUNTS-FIX.md](DISK-LEAK-CACHE-MOUNTS-FIX.md) | 30.09 · #74 | Бюджет кэш-маунтов BuildKit | Актуально |
| [CAPI-PLATFORM-RELINK-FIX.md](CAPI-PLATFORM-RELINK-FIX.md) | 01.10 · #82 | Выбор платформы, общий токен с Helper | Частично заменено ENTITLEMENT |
| [LOG-UPLOAD-OPTIMIZATION.md](LOG-UPLOAD-OPTIMIZATION.md) | 01.10 · #82 | Урезание `raw_event`, прунинг | Заменено COLONISATION-SITES-REWORK |
| [ENGINEERS-STICKY-FIX.md](ENGINEERS-STICKY-FIX.md) | 01.10 · #82 | Карточка инженера под шапкой | Актуально |
| [CAPI-BINDING-FIX.md](CAPI-BINDING-FIX.md) | 27.09 · #58 | «OAuth прошёл, привязки нет» | Основа актуальна, детали — в более поздних |
| [CAPI-400-FIX.md](CAPI-400-FIX.md) | 27.09 · #58 | `audience` и HTTP 400 | Частично заменено ENTITLEMENT |
| [ACCOUNT-AVATAR-SQUADRON-FIX.md](ACCOUNT-AVATAR-SQUADRON-FIX.md) | 27.09 · #58 | Аватары без 503, «Сообщения и друзья», создание эскадрилий | Актуально |
| [SQL-MIGRATIONS-AUDIT.md](SQL-MIGRATIONS-AUDIT.md) | 25.09 · #50 | Аудит миграций | История (55 миграций на дату) |
| [COLONISATION-EVENTS-AUDIT.md](COLONISATION-EVENTS-AUDIT.md) | 24.09 · #43 | Дубли `colonisation_events` | Заменено COLONISATION-SITES-REWORK |
| [PORTS_ANALYSIS.md](PORTS_ANALYSIS.md) | 25.09 · #44 | Откат портов Synology | История (Synology-конфигурация удалена) |
| [GALNET-TRANSLATIONS-FIX.md](GALNET-TRANSLATIONS-FIX.md) | 23.09 · #32 | Переводы Galnet и колонки в БД | Актуально как диагностика |
| [REALTIME-FIX.md](REALTIME-FIX.md) | 21.09 · #13 | WebSocket Realtime | Актуально как диагностика |
| [SKILL-wiki-404-fix.md](SKILL-wiki-404-fix.md) | 08.09 | 404 вики на Vercel | История (Vercel не используется), урок про `generateStaticParams` в силе |

## Как вести документацию

* **Новая функция** — строка в «Функциях» [README.md](README.md), раздел в
  [CONTEXT.md](CONTEXT.md) (§8), запись в этой карте, переменные — в
  [.env.example](.env.example), строка в [CHANGELOG.md](CHANGELOG.md). Большой
  функции — свой документ в корне (`ИМЯ.md`), как `FACTIONS.md`.
* **Новая миграция** — добавить её блок в `supabase/full_schema.sql` (порядок
  = порядок файлов; проверяет `scripts/tests/migrations-sql.test.mjs`) и
  таблицы — в [supabase/DATABASE.md](supabase/DATABASE.md) и CONTEXT §4.
* **Новая фоновая задача** — `scripts/job-schedule.mjs`, значение по умолчанию
  `JOBS_ENABLED` в `docker-compose.yml` и `.env.example`, таблица задач в README
  и CONTEXT §9.
* **Релиз Helper** — новый раздел **сверху** [uploader/CHANGES.md](uploader/CHANGES.md)
  (он уходит в заметки релиза) и короткая запись в [uploader/README.md](uploader/README.md).
* **Инструкции по nginx** — `DEPLOY.md`, `SELFHOST.md`, `SERVER-SETUP.md`
  проверяет `scripts/tests/release-upload-limits.test.mjs` (части по 4 МиБ,
  `check-release-upload-limit.sh`, внешний прокси/CDN).
* **Разбор инцидента** — отдельный `ЧТО-СЛОМАЛОСЬ-FIX.md` с датой и PR; когда
  поведение меняется снова, сверху старого разбора ставится пометка со ссылкой
  на новый, а сам текст не переписывается.
