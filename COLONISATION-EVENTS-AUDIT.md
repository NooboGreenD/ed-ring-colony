# Аудит `colonisation_events`: откуда дубли и мусорные записи

Разбор проекта и всех путей загрузки журналов (сайт + Colonial Helper) с
проверкой на дубли, план диагностики существующей базы и внесённый фикс.

Дата: 2026-09-24.

---

## 1. Короткий вывод

Дубли и мусор в `colonisation_events` — не случайность, а сумма шести
независимых дефектов. Три из них клиентские (лишние строки уезжают на сервер),
три — серверные (лишние строки сохраняются в базе).

| № | Дефект | Где | Что происходило |
|---|---|---|---|
| D1 | `finish()` вызывается в цикле по файлам | `src/app/account/page.tsx` | браузер отправлял уже собранное заново: 10 файлов → 55 строк вместо 10 |
| D2 | Коллектор состояния пересоздавался на каждый тик watcher'а | `uploader/colonial_helper.py` | неизменившееся состояние стройки уходило на сайт каждые 5 секунд |
| D3 | Уникальный ключ схемы не работает при `construction_id IS NULL` | `supabase/…capi_journal_base.sql` | `ColonisationContribution` и события без `ConstructionID` дублировались при каждом импорте |
| D4 | CAPI писал голым `insert()` без проверки ошибки | `src/app/api/capi/sync/route.ts` | повторный синк молча терял всю пачку, события без системы писались с пустым `system_name` |
| D5 | Отсутствующая метка времени заменялась на `now()` | `src/lib/journalTelemetry.ts` | одна и та же запись при каждом повторе становилась «новой строкой» |
| D6 | Снимок прогресса писался на каждое событие CAPI-окна | `src/lib/projects/autoProgress.ts` | `construction_depot_snapshots` рос даже без изменений на стройке |

Первый же замер подтвердил опасения владельца: журнал по одной стройке
превращался в десятки тысяч строк об одном и том же состоянии.

Фикс внесён в код (раздел 6). Для уже накопленных данных — разовый скрипт
`supabase/maintenance/colonisation_events_source_hash_dedup.sql` (раздел 7).

---

## 2. Как таблица устроена сегодня

```sql
CREATE TABLE colonisation_events (
  id                 SERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  journal_import_id  INTEGER REFERENCES journal_imports(id) ON DELETE SET NULL,
  event_timestamp    TIMESTAMPTZ NOT NULL,
  system_name        TEXT NOT NULL,
  market_id          BIGINT,
  construction_name  TEXT,
  construction_id    BIGINT,
  construction_progress NUMERIC(5,2),
  resources_total    JSONB DEFAULT '[]',
  raw_event          JSONB NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, event_timestamp, system_name, construction_id)   -- ← ключ с дырой
);
```

Ключ схемы устроен так, что не удерживает ровно те повторы, которые создаёт
игра:

1. **NULL не равен NULL.** В PostgreSQL уникальный индекс считает строки
   разными, если хотя бы один столбец ключа NULL. `construction_id` пуст у
   `ColonisationContribution` (это вклад командира, а не снимок стройки) и у
   событий журнала, где поля `ConstructionID` нет. Такие строки можно
   вставлять сколько угодно раз — ограничение промолчит.
2. **`event_timestamp` в ключе.** Журнал пишет
   `ColonisationConstructionDepot` каждые несколько секунд, пока игрок стоит
   у площадки. Состояние стройки при этом не меняется, а метка времени новая —
   значит, для ключа это «новое событие». Ровно этот случай описан в тестах
   приложения: 4990 событий в одном файле при единицах реальных изменений
   (`uploader/tests/test_upload_performance.py`).

Читателей у таблицы мало: `src/lib/ravenDepotSnapshots.ts` берёт последний
`resources_total` по `market_id` (обогащение ответа Raven Colonial), остальное
читается вручную. То есть истории «наблюдений» никто не использует — нужны
только **изменения состояния**.

---

## 3. Как загружаются логи: шесть путей в одну таблицу

| Путь | Кто | Роут | Формат событий | Что писал в `colonisation_events` |
|---|---|---|---|---|
| P1 | Браузер: `/account` (загрузка логов) | `POST /api/logs/import` → `persistJournalTelemetry` | `constructionEvents` (snake_case, как у Helper'а) | снимки строек (`ColonisationConstructionDepot`) |
| P2 | Браузер: `/account/journal` (страница журнала) | `POST /api/journal/parse` → `POST /api/journal/import` | `depotEvents` + `contributionEvents` (camelCase) | снимки строек **и** вклады (`ColonisationContribution`) |
| P3 | Colonial Helper: первичная загрузка истории | `POST /api/logs/upload` → `persistJournalTelemetry` | `construction_events` | снимки строек |
| P4 | Colonial Helper: живой watcher | `POST /api/logs/upload` | `construction_events` | снимки строек каждые несколько секунд |
| P5 | CAPI: синхронизация по кнопке | `POST /api/capi/sync` | напрямую из `parseColonisationEvents` | снимки строек (без `persistJournalTelemetry`) |
| P6 | CAPI: крон | `GET /api/cron/capi-sync` | то же | только `updateProjectProgress` (в `construction_depot_snapshots`) |

`/api/logs/import`, `/api/logs/upload` и `/api/capi/sync` — три независимых
SQL-записи в одну таблицу. Именно поэтому фикс сделан общим модулем
(`src/lib/colonisationEvents.ts`), а не правкой в каждом роуте.

---

## 4. Дефекты: что именно и с доказательством

### D1. Браузер повторял уже собранное (`finish()` в цикле)

`src/app/account/page.tsx` разбирает файлы по одному и складывает результат:

```ts
const telemetryResult = telemetry.finish();          // ← отдаёт ВСЁ накопленное
allConstructionEvents.push(...telemetryResult.constructionEvents);
```

`TelemetryCollector.finish()` возвращает внутренний массив, который
накапливается между файлами. Значит, на файле №k в список попадают все
события файлов 1..k ещё раз — сумма растёт как треугольник.

Замер (симуляция цикла страницы, 10 файлов, по одному изменению состояния в
каждом):

```
уникальных состояний: 10
строк, отправленных браузером: 55      # Σ k = 10·11/2
```

На реальной истории это десятки тысяч строк и сотни HTTP-запросов вместо
одного-двух. В базе повторы чаще всего схлопывались ключом схемы (у снимков
`construction_id` заполнен) — то есть это ещё и скрытая нагрузка, а строки без
`ConstructionID` и события без метки времени (D5) попадали в таблицу целиком.

### D2. Watcher Helper'а отправлял состояние каждые 5 секунд

`uploader/colonial_helper.py` (до фикса):

```python
def _process_journal_changes(self, filepath, old_size, new_size, live=False):
    collector = ConstructionSnapshotCollector()      # ← новый набор подписей на каждый вызов
    ...
    construction_events = collector.events           # ← и весь накопленный список
```

`_process_journal_changes` вызывается из `_watcher_loop` для каждого файла
каждые 5 секунд. Набор «уже отправленных состояний» при этом терялся, поэтому
первое же событие тика проходило фильтр — состояние то же, метка времени
новая, строка в таблице новая. Игрок, простоявший у площадки час, оставлял
~720 строк на одну стройку за одну сессию.

Вторая грань того же дефекта (обнаружена при отладке теста): список
`collector.events` не очищался, поэтому один и тот же снимок уезжал на сайт
повторно со следующим тиком — и так далее, пока сессия жива.

### D3. Уникальный ключ не ловит `NULL construction_id`

Страница `/account/journal` пишет вклады так:

```ts
const contributionRows = contributionEvents.map((ev) => ({
  ...,
  construction_id: null,          // ← по определению события
  construction_progress: null,
}));
await svc.from('colonisation_events').upsert(batch, {
  onConflict: 'user_id,event_timestamp,system_name,construction_id',
  ignoreDuplicates: true,         // ← не сработает: NULL не равен NULL
});
```

То же и в `persistJournalTelemetry`, и в CAPI. Повторный импорт того же файла
(пользователь просто перетащил журнал ещё раз) добавлял копии по каждой
позиции вклада. События `ColonisationConstructionDepot` без `ConstructionID`
вели себя так же.

### D4. CAPI: ошибка записи не проверялась

```ts
const { data } = await svc.from('colonisation_events').insert(rows).select();
inserted = data?.length || 0;      // error не читается вообще
```

Повторный синк того же окна упирается в ключ схемы, `INSERT` отменяется
целиком — и «никто не узнает»: ошибки нет в ответе, часть событий окна
потеряна. События без системы (CAPI не всегда отдаёт `StarSystem`) при этом
писались с пустым `system_name`: по ним площадку не найти, а `insert` без
конфликта создавал их заново на каждом синке.

### D5. Отсутствующая метка времени = `now()`

```ts
const timestamp = typeof event.timestamp === 'string' && event.timestamp
  ? event.timestamp
  : new Date().toISOString();      // ← каждый повтор = новая строка
```

Событие без `timestamp` записывалось с текущим временем сервера, поэтому любые
повторы (D1, D2, повторный импорт) превращались в новые строки, которые уже не
схлопнуть ни ключом схемы, ни отпечатком.

### D6. Снимки прогресса на каждое событие CAPI-окна

`updateProjectProgress()` вызывался для каждого события в окне CAPI и всегда
писал строку в `construction_depot_snapshots` со свежим `now()`. Каждые
несколько минут (крон) — ещё раз, даже если на стройке ничего не изменилось.

### D7 (замечание). Сервер не узнаёт повторно загруженный файл

`journal_imports.file_hash` пишется, но нигде не проверяется: сервер не ищет
уже завершённый импорт с тем же хешем, поэтому повторная загрузка того же
журнала снова доходит до строк. Распознавание повторов целиком лежит на уровне
строк — а там до этого фикса дыра была и в ключе схемы (D3), и в метке времени
(D5). Отдельное ограничение по `(user_id, file_hash)` не добавлялось: оно
запрещало бы легальный повторный импорт подросшего файла (журнал дописывается)
и ломало бы старые сборки Helper'а, которые шлют `fileHash = "manual"`.

### Что НЕ является дублем (проверено отдельно)

* Параллельные пачки Helper'а (`max_workers=4`) различаются по данным — это не
  повторы; сервер схлопывал их ключом схемы.
* `source_hash` доставок (`deliveries`) уже идемпотентен — там механизм был
  сделан раньше (`20260911010000_delivery_import_idempotency.sql`), и он же
  взят образцом для `colonisation_events`.
* Локальный кэш «уже загруженных файлов» Helper'а (`.colonial_helper_imported_files.json`)
  сравнивает размер, mtime, версию парсера и адрес сайта — повторный импорт
  той же истории он отсекает корректно.

---

## 5. Что покажет диагностика на живой базе

Полный сценарий — в `supabase/maintenance/colonisation_events_source_hash_dedup.sql`
(шаг 0, только чтение). Коротко, что запустить в SQL Editor:

```sql
-- 1. Общая картина
SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE construction_id IS NULL)  AS without_construction_id,
       count(*) FILTER (WHERE btrim(system_name) = '')  AS without_system,
       count(*) FILTER (WHERE raw_event->>'event' = 'ColonisationContribution') AS contributions
FROM public.colonisation_events;

-- 2. Сколько строк приходится на одно состояние одной площадки одного пилота
SELECT sum(repeats) AS redundant_rows, max(repeats) AS worst_case
FROM (
  SELECT count(*) AS repeats
  FROM public.colonisation_events
  WHERE raw_event->>'event' = 'ColonisationConstructionDepot'
  GROUP BY user_id, lower(btrim(system_name)), market_id, construction_id,
           round(construction_progress::numeric, 2),
           coalesce(construction_name, ''),
           md5(coalesce(resources_total, '[]'::jsonb)::text)
  HAVING count(*) > 1
) AS grouped;

-- 3. Всплески по дням (видно сессии, когда watcher отправлял по строке на тик)
SELECT date_trunc('day', event_timestamp) AS day, count(*)
FROM public.colonisation_events GROUP BY 1 ORDER BY 1 DESC LIMIT 30;
```

Ожидаемая картина: «redundant_rows» — это и есть мусор, который удалит шаг 1
скрипта. Вклады (`contributions`) видно отдельным счётчиком: строки никто не
читает, тоннаж живёт в `deliveries`, поэтому в скрипте для них подготовлен
отдельный (закомментированный) блок удаления — решение за владельцем.

---

## 6. Фикс: что изменено

### 6.1 Новый общий модуль записи

`src/lib/colonisationEvents.ts` — единственное место, которое строит строки и
пишет их в таблицу:

* `colonisationSourceHash()` — устойчивый ключ состояния
  (`colony-v1-<fnv>`): система, MarketID, ConstructionID, имя, прогресс и
  слепок ресурсов. Для `ColonisationConstructionDepot` метка времени в ключ
  **не** входит (это снимок состояния), для остальных событий входит (это
  отдельные факты). Локальные названия ресурсов (`Name_Localised`) исключены:
  журнал переводится на язык клиента, иначе русский и английский клиенты дали
  бы «разные» состояния;
* `depotEventRow()` / `contributionEventRow()` / `telemetryConstructionRow()` —
  построение строк из всех трёх форматов (парсер сайта, CAPI, Helper) с одной и
  той же нормализацией;
* `persistColonisationEvents()` — запись пачками по 100, `upsert` по
  `(user_id, source_hash)` с `ignoreDuplicates`, деление пачки при
  `statement_timeout` (57014), ошибки собираются в `warnings` (импорт доставок
  не падает). Возвращает число реально записанных строк и набор отпечатков —
  по ним решается, для чего писать снимок прогресса;
* деградация как у `deliveries`: если колонки `source_hash` ещё нет —
  пишем прежним ключом схемы; если колонка есть, а уникального индекса ещё нет —
  сверяемся с уже записанным и вставляем только недостающее. Роллинг-деплой
  (API впереди миграции) ничего не ломает.

### 6.2 Точки входа переведены на общий модуль

* `src/lib/journalTelemetry.ts` — `persistJournalTelemetry` пишет снимки через
  общий модуль; в `construction_depot_snapshots` попадают только **реально
  записанные** состояния (повтор больше не «подтверждается» снимком); строки
  без системы или метки времени пропускаются с предупреждением; в счётчиках
  появилось `constructionDuplicates`.
* `src/app/api/journal/import/route.ts` — снимки и вклады через общий модуль,
  в ответе `duplicateDepots` / `duplicateContributions`.
* `src/app/api/capi/sync/route.ts`, `src/app/api/cron/capi-sync/route.ts` —
  `insert()` заменён на общий писатель; прогресс проекта обновляется по
  последнему состоянию каждой стройки (`latestDepotEvents`).
* `src/lib/projects/autoProgress.ts` — снимок пишется только при смене
  состояния (`depotStateFingerprint`).
* `src/app/account/page.tsx` — вместо `finish()` в цикле используется новый
  `TelemetryCollector.drain()`, который отдаёт только новые snapshots и шаг
  счётчиков (D1).

### 6.3 Uploader

* `uploader/journal_parser.py` — `ConstructionSnapshotCollector.drain()` и
  `requeue()`: набор подписей живёт вместе с коллектором, а на отправку уходят
  только новые состояния.
* `uploader/colonial_helper.py` — коллектор один на сессию (`self._construction_collector`,
  сбрасывается при старте watcher'а и кнопкой «Сбросить кэш импорта»), живой тик
  вызывает `drain()`, неудачная отправка возвращает пачку в накопитель
  (`requeue`) вместо тихой потери (D2).

### 6.4 Схема и обслуживание базы

* `supabase/migrations/20260928000000_colonisation_events_source_hash.sql` —
  колонка `source_hash` (+ комментарий) и ссылка на maintenance-скрипт.
  Повторена в `supabase/full_schema.sql`.
* `supabase/maintenance/colonisation_events_source_hash_dedup.sql` — разбор
  накопленного: префлайт (раздел 5), копия лишних строк в
  `colonisation_events_dedup_backup` (с возможностью отката), удаление,
  затем `CREATE UNIQUE INDEX CONCURRENTLY` по `(user_id, source_hash)`.
  Файл идемпотентен.

### 6.5 Тесты

* `scripts/tests/colonisation-events.test.mjs` — 13 тестов: одинаковый
  отпечаток из разных клиентов, независимость от языка журнала, отсутствие
  метки времени в ключе состояния, отсев повторов, схлопывание пачки,
  деградация без колонки/индекса, деление пачки при таймауте.
* `scripts/tests/journal-telemetry.test.mjs` — новые проверки: повторное
  состояние не пишется ни в события, ни в снимки; событие без системы/метки
  времени не пишется; `drain()` не повторяет уже собранное.
* `uploader/tests/test_initial_upload_flow.py` — регрессия D2: два живых тика с
  неизменившимся состоянием дают одну строку, изменение состояния проходит.
* Прогоны: `node --test scripts/tests/*.test.mjs` — 486 тестов, 0 падений;
  `npx tsc --noEmit` — чисто; `python -m unittest discover -s uploader/tests` —
  1161 тест, 0 падений.

---

## 7. Порядок выката

1. **Миграция** `20260928000000_colonisation_events_source_hash.sql` — добавляет
   колонку. Ничего не переписывает и не блокирует.
2. **Код сайта** (роуты + страница загрузки). До пункта 3 API работает в режиме
   «колонка есть, индекса нет»: сверка с базой перед вставкой, дубли не
   создаются.
3. **`supabase/maintenance/colonisation_events_source_hash_dedup.sql`** —
   диагностика, чистка истории, уникальный индекс. Тихое окно.
4. **Пересборка Colonial Helper** (следующий релиз): клиент перестанет слать
   лишнее. Сервер уже защищён и от старых версий — просто трафика больше.

Если индекс создать до чистки, `CREATE UNIQUE INDEX` упадёт на дублях — порядок
шагов в файле именно поэтому такой, а префлайт-запросы показывают объём работ.

## 8. Что осталось на решение владельца

* **Вклады в `colonisation_events`.** Строки `ColonisationContribution` никто не
  читает (тоннаж — в `deliveries`), а они множатся по каждой позиции груза.
  В maintenance-скрипте есть закомментированный блок их удаления и остановка
  записи не требуется: после пункта 1 они перестают дублироваться.
* **`construction_depot_snapshots`.** Новые строки теперь появляются только при
  смене состояния, но накопленная история не чистилась — посмотреть объём можно
  запросом:
  `SELECT system_name, construction_id, count(*) FROM construction_depot_snapshots GROUP BY 1,2 ORDER BY 3 DESC LIMIT 20;`
* **Версия Helper'а.** Фикс клиента вступит в силу только в следующем релизе
  (VERSION в `uploader/colonial_helper.py` не поднимался — это часть процесса
  выпуска).
* **`full_schema.sql` отстаёт** от `migrations/` (заканчивается на
  20260920…, хотя есть миграции до 20260927…). Свежая установка получит не всё;
  инструкция по пересборке — в `supabase/DATABASE.md`.

---

## 9. Как проверить, что стало лучше

* В ответе `/api/logs/upload` и `/api/logs/import` появились
  `constructionInserted` (реально записанные строки) и `constructionDuplicates`
  (повторы; раньше они молча писались). При повторной загрузке того же журнала
  `constructionInserted` должен быть равен нулю для снимков.
* В логе Helper'а число отправленных snapshots должно совпадать с числом
  изменений состояния, а не с числом файлов/тиков.
* В базе: `SELECT count(*) FROM colonisation_events WHERE source_hash IS NULL;`
  — растёт только за счёт старых клиентов; после обновления Helper'а перестаёт
  расти совсем.
