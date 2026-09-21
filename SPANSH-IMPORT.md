# Spansh: полная таблица всех систем галактики

Проект хранит **все известные системы Elite Dangerous** (ночной дамп
[Spansh](https://spansh.co.uk/dumps), файл `systems.json.gz`, ~6 GiB) в
таблице `galaxy_systems`. Она используется:

1. **Поиск в Атласе** — координаты опорной системы и звёздные кандидаты
   (нейтроны, чёрные дыры, белые карлики, Вольф–Райе, Herbig Ae/Be, T Tauri,
   углеродистые, гиганты, супергиганты) берутся из локальной БД вместо
   онлайн-запросов EDSM/Spansh. Планетные кандидаты (телескоп-классы и
   скалы) продолжают приходить из Spansh bodies-search, но координаты их
   систем тоже резолвятся из БД.
2. **Поиск системы на карте** (поле «Поиск системы») — сначала локальная
   таблица (все ~1.3M систем), потом EDSM.
3. **Экспериментальный слой «Все системы ⚗»** на 3D-карте галактики —
   облако из ~1.3M точек (цвет по классу главной звезды, клик по точке
   открывает карточку системы). Данные: бинарный файл `edgs-v1`
   (~30 МБ), который генерируется импортом или строится на лету из БД
   (`/api/galaxy/all-systems`).

Формат дампа (schema `BriefDumpSystem`,
[spansh/elite_dangerous_schemas](https://github.com/spansh/elite_dangerous_schemas)):
одна система на строку — `{ id64, name, mainStar, coords{x,y,z}, needsPermit,
updateTime }`. Координаты — в Sol-centered frame сайта (Sol = 0,0,0;
SgrA = 25.21875, −20.90625, 25899.96875), конвертация не требуется.

## Как запустить импорт

Импорт нужно выполнять на машине с доступом в интернет
(`downloads.spansh.co.uk`) и с доступом к Supabase.

**Важно:** production-образ Next.js (standalone) не содержит `scripts/` и
зависимость `pg`, поэтому запускать импорт из web-контейнера нельзя.
На сервере (где лежит клон репозитория) удобно делать это одноразовым
контейнером node:

```bash
cd /path/to/ed-ring-colony
docker run --rm --env-file .env.production \
  -v "$(pwd)":/work -w /work node:22-alpine \
  sh -c "npm ci --no-audit --no-fund && node scripts/import-spansh-systems.mjs"
```

(`.env.production` содержит `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` — этого достаточно; при наличии `DATABASE_URL`
используется быстрый прямой режим.) Любая другая машина с Node ≥ 22.18
работает так же: `npm ci && npm run spansh:import`.

Поддерживаемые режимы подключения к БД (по приоритету):

- `DATABASE_URL` — прямой Postgres (быстрее: крупные `INSERT … ON CONFLICT`,
  поддерживается `--truncate`);
- `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — через PostgREST
  (upsert чанками по 500).

Полезные флаги:

```bash
node scripts/import-spansh-systems.mjs --help
  --file <path>        локальный .gz/.json дамп вместо скачивания
  --limit <n>          обработать только n систем (проверка)
  --truncate           очистить таблицу перед импортом (pg-режим)
  --dry-run            только парсинг, без записи в БД
  --no-points          не генерировать файл точек для карты
  --skip-download      переиспользовать ранее скачанный файл
  -v                   прогресс каждые 10 секунд
```

Скрипт:

1. скачивает `systems.json.gz` в `data/spansh/` (с возобновлением по Range);
2. стримингово парсит JSON-массив (одна запись на строку; понимает и
   minified-формат), без удержания всего дампа в памяти;
3. `id64` (unsigned 64-bit) извлекается как строка из сырых цифр — JS-числа
   теряли бы точность выше 2^53;
4. класс главной звезды нормализуется (`star_type` + `star_giant_class`),
   считаются `distance_from_sols` / `distance_from_sgra`;
5. пишет в `galaxy_systems` (upsert по `name_lc`) + статистику в
   `galaxy_systems_meta` (key `stats`);
6. генерирует `public/data/galaxy-systems-points.bin` (`.meta.json` рядом)
   для экспериментального слоя карты.

Повторный импорт безопасен (upsert); для полной перезаписи — `--truncate`.

Проверка без интернета и БД:

```bash
npm run spansh:selftest          # синтетический дамп → парсер → БД-строки → точки
npm run test                     # все тесты, включая scripts/tests/spansh-systems.test.mjs
```

## Что в таблице

| колонка | описание |
| --- | --- |
| `id64` | Spansh ID64 (строка, до 2^64) |
| `name` / `name_lc` | каноническое имя / нормализованный ключ поиска |
| `x, y, z` | координаты (ly, Sol-centered frame) |
| `main_star` | сырой класс: `G (White-Yellow) Star`, `Neutron Star`, … |
| `star_type` | `o\|b\|a\|f\|g\|k\|m\|brown_dwarf\|neutron\|black_hole\|white_dwarf\|wolf_rayet\|herbig_ae_be\|t_tauri\|carbon\|unknown` |
| `star_giant_class` | `dwarf\|giant\|supergiant` (для обычных классов) |
| `needs_permit` | нужен ли permit |
| `distance_from_sols`, `distance_from_sgra` | расстояния (ly) |
| `updated_at` | `updateTime` из дампа |

## API

- `GET /api/galaxy/stats` — статус загрузки (ready, count, imported_at);
- `GET /api/galaxy/systems/search?q=…` — автодополнение (exact → prefix → substring);
- `GET /api/galaxy/systems/:id64` — одна система по ID64;
- `GET /api/galaxy/all-systems` — бинарный файл точек (`edgs-v1`, ETag).

Если импорт ещё не выполнялся, все эти эндпоинты возвращают «пусто»
(404 для all-systems), а поиск и Атлас работают в прежнем режиме
через EDSM/Spansh.

## Ресурсы на сервере

- RAM во время импорта: < 1 GB (стриминг, батчи по 5000 строк);
- время: скачивание ~6 GiB (зависит от линии) + ~2–5 минут на запись ~1.3M строк;
- БД: ~1.5–2 GB с индексами; файл точек ~35 МБ.
