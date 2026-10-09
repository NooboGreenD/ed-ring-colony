> **Обновление 09.10.2026.** Описанная ниже схема (`colonisation_events`, ключ `source_hash`,
> `colonisation_events_prune`, вклады в таблице) заменена. Текущее состояние каждой площадки —
> таблица `colonisation_sites` (одна строка на MarketID), снимки прогресса — `construction_depot_snapshots`.
> Причины и порядок переноса — в [COLONISATION-SITES-REWORK.md](COLONISATION-SITES-REWORK.md).

# `colonisation_events`: почему 3 ГБ превратились в 12+ и что изменено

Дата: 2026-10-01. Продолжение [COLONISATION-EVENTS-AUDIT.md](COLONISATION-EVENTS-AUDIT.md)
(тот разбор закрыл дубли; этот — объём).

Жалоба: «после загрузки в таблицу объёма данных максимум на 3 ГБ она стала
размером больше 12 ГБ; такими темпами она станет неимоверно большей. С сайта
логи грузятся не полностью, а с приложения — много лишней информации, у пилота
показывает 943 153 188 „монет наёмников“, хотя их не больше нескольких тысяч».

---

## 1. Короткий вывод

| № | Причина роста | Что сделано |
|---|---|---|
| V1 | `raw_event` хранил **полную копию события журнала** — вместе с `ResourcesRequired`, который и так лежит в `resources_total`, и с `Name_Localised` каждого ресурса. Строка выходила **в 2–3 раза тяжелее** полезного содержимого, при этом колонку никто не читает, кроме диагностики `raw_event->>'event'` | код пишет только маркер `{"event":"…"}`; миграция худеет старые строки (раздел 4) |
| V2 | **Политики хранения не было**: история «наблюдений» за стройками копилась вечно. Читателю нужен только последний снимок площадки (Raven) — всё остальное балласт | функция `colonisation_events_prune(days)` + ежедневная задача `colonisation-cleanup` (раздел 5) |
| V3 | **Вклады `ColonisationContribution`** писались по строке на каждую позицию груза и никем не читались (тоннаж живёт в `deliveries`) | запись остановлена, накопленное удаляет prune (раздел 6) |
| V4 | Браузерная загрузка **теряла телеметрию молча**: сбой одной пачки (сеть, 429, таймаут) — `console.warn` и дальше; пилот видел «загружено», а снимков/сканов нет — это и выглядело как «с сайта логи грузятся не полностью» | 3 повторных попытки на пачку + счётчик потерь в итоговой сводке (раздел 7) |
| V5 | «Монеты наёмников» читались из `Statistics.Combat.Combat_Bond_Profits` — это накопленные за всю игру **кредиты** за боевые облигации (сотни миллионов), а не жетоны Operations (кап 9999) | источник исправлен на `Statistics.Bank_Account.MercCoins_Current`, мусор в базе сброшен, старые клиенты фильтруются (раздел 8) |

Дубли, отправляемые старыми сборками Helper'а, по-прежнему отсекаются
`source_hash` (аудит от 24.09) — этот рубеж работает и здесь.

---

## 2. Математика раздувания

Один `ColonisationConstructionDepot` из журнала: ~20 ресурсов, у каждого
`Name`, `Name_Localised`, `RequiredAmount`, `ProvidedAmount`, `Payment`.

```
resources_total:   ~2.0–2.5 КБ   ← полезная часть (читает Raven)
raw_event:         ~2.5–3.0 КБ   ← ТЕ ЖЕ ресурсы + локализация, никто не читает
индексы:           ~30 % строки  ← UNIQUE(user_id,event_timestamp,system_name,
                                   construction_id) + (user_id,source_hash) + …
```

Итого строка весила в 2.5–3 раза больше полезных данных. Дальше работали
механизмы из аудита (watcher-пачки каждые 5 секунд, повторные импорты) — и
«3 ГБ данных» превращались в 12+ ГБ на диске. С 24.09 повторы новых строк не
создаются, но **уже накопленное никуда не делось**, а `raw_event` и история без политики
хранения продолжали расти и дальше.

Читатели таблицы (проверено grep'ом по репозиторию):

* `src/lib/ravenDepotSnapshots.ts` — только `resources_total` последней строки
  по `market_id`;
* maintenance-диагностика — только `raw_event->>'event'`.

Больше таблицу не читает никто.

---

## 3. Что изменено в коде записи

`src/lib/colonisationEvents.ts` — все три построителя строк
(`depotEventRow`, `contributionEventRow`, `telemetryConstructionRow`) кладут в
`raw_event` только `slimRawEvent(eventName)` — `{"event":"…"}` (~40 байт).
Присланный клиентом `raw_event` (старые сборки Helper'а и браузера продолжают
его отправлять) **игнорируется**. `resources_total` не меняется: его читает
обогащение Raven (`RequiredAmount`/`ProvidedAmount`/`Name_Localised`).

Колонка остаётся `NOT NULL` — деградации и миграция-ahead-of-code не нужны:
любая комбинация «код/база» записывается корректно.

Отправка тоже похудела:

* браузерный `TelemetryCollector` больше не вкладывает `raw_event` в snapshot
  (`src/lib/journalTelemetry.ts`) — трафик загрузки с сайта вдвое меньше;
* Colonial Helper (`uploader/journal_parser.py::_construction_event_from`)
  перестал отправлять `raw_event` на сайт — то же самое для приложения.

`source_hash` не менялся: строки, записанные до и после этого фикса,
продолжают схлопываться как одинаковые состояния.

## 4. Миграция: старые строки худеют

`supabase/migrations/20261008000000_colonisation_events_slim_retention.sql`:

1. `UPDATE … SET raw_event = jsonb_build_object('event', raw_event->>'event')`
   для строк тяжелее 256 байт — идемпотентно, маркер типа сохраняется
   (диагностика различает вклады и снимки как раньше);
2. сброс мусорных `pilot_stats.mercenary_coins` (см. раздел 8);
3. функция `colonisation_events_prune(days)` (раздел 5) + индекс
   `(user_id, market_id, event_timestamp DESC)` под поиск «последнего снимка».

`UPDATE` не блокирует схему, но место на диске возвращает только VACUUM —
порядок действий в тихое окно описан в
`supabase/maintenance/colonisation_events_source_hash_dedup.sql` (раздел 4
скрипта): `colonisation_events_prune(60)` → `VACUUM (ANALYZE)` → при
необходимости `VACUUM FULL`/`pg_repack`.

## 5. Политика хранения

Функция `public.colonisation_events_prune(p_retain_days DEFAULT 60)`:

* вклады `ColonisationContribution` — удаляются **целиком** (не читает никто);
* состояния старше окна — удаляются, **кроме последнего снимка каждой
  площадки** (`DISTINCT ON (user_id, market_id)`), он нужен Raven;
* `construction_depot_snapshots` старше окна — удаляются (графики читают окно,
  а не всю историю).

Задача `colonisation-cleanup` (новая в `scripts/job-schedule.mjs`, ежедневно
03:40 UTC, endpoint `/api/cron/colonisation-cleanup`) вызывает функцию через
RPC. Окно настраивается `COLONISATION_RETENTION_DAYS` (минимум 7 — защита от
опечатки). Задача включена в списки по умолчанию: `docker-compose.yml`,
`.env.example`, `deploy/crontab.example`, `POST-MIGRATION.md`.

Ручной запуск и отчёт:

```sql
SELECT * FROM public.colonisation_events_prune(60);
-- deleted_events | deleted_snapshots | deleted_contributions
```

## 6. Вклады: запись остановлена

`src/app/api/journal/import/route.ts` больше не пишет
`ColonisationContribution` в `colonisation_events`: в ответе появилось
`skippedContributions`, `insertedContributions` всегда 0. Страница
`/account/journal` как раньше показывает найденные вклады в предпросмотре —
данные парсера не менялись, меняется только бессмысленная запись в БД.
Дубли вкладов при повторном импорте больше не вопрос: строк просто нет.

## 7. Надёжность загрузки с сайта

`src/app/account/page.tsx`:

* каждая пачка телеметрии (снимки строек, сканы тел, статистика пилота)
  отправляется с **тремя попытками** и паузой — как доставки; повтор безопасен
  благодаря `source_hash`;
* если пачка всё же не прошла, в итоговой сводке появляется красная строка
  «Часть телеметрии (N пачек…) не отправилась — загрузите журнал ещё раз»
  вместо тихого `console.warn`.

## 8. «Монеты наёмников»

Валюта Merc Coin появилась с обновлением **Operations** (30.06.2026): выдаётся
за операции, магазин Frontier ограничивает баланс **9999** и пополнение
1000/нед. В журнал игра пишет баланс в `Statistics.Bank_Account.MercCoins_Current`
(поле добавлено 22.06.2026, через два дня перенесено в `Bank_Account`).

Сайт читал `Statistics.Combat.Combat_Bond_Profits` — это **кредиты** за боевые
облигации за всю карьеру. У ветерана это сотни миллионов, отсюда
«943 153 188 монет» при реальных паре тысяч.

Исправлено в трёх местах:

| Файл | Было | Стало |
|---|---|---|
| `src/lib/journalTelemetry.ts` | `assign('mercenary_coins', combat, ['Combat_Bond_Profits', …])` | `assign('mercenary_coins', bank, ['MercCoins_Current', 'Mercenary_Coins'])` |
| `uploader/colonial_helper.py` | `combat["Combat_Bond_Profits"]` | `bank["MercCoins_Current"]` (запасной `Mercenary_Coins`) |
| `uploader/companion_api.py` | `profile.mercenary_payout` → `combat.combat_bond_profits` | `bank_account.merc_coins_current` (и варианты), кредиты убраны |

Защита от старых клиентов (они ещё долго будут присылать `Combat_Bond_Profits`
под видом жетонов): `isPlausibleMercenaryCoins()` (лимит 100 000 с запасом над
капом 9999) применяется в `persistJournalTelemetry` и `/api/cmdr/stats` —
мусорное значение просто не записывается. Миграция сбрасывает уже накопленный
мусор (`UPDATE pilot_stats SET mercenary_coins = 0 WHERE mercenary_coins >
100000`), следующая загрузка журнала запишет настоящее значение.

В досье подпись карточки уточнена: «Жетоны Operations (кап 9999)».

---

## 9. Порядок выката

1. **Миграция** `20261008000000_colonisation_events_slim_retention.sql`
   (худеем + функция + индекс). Ничего не блокирует надолго.
2. **Код сайта** — быстрее перестаём писать тяжёлое; работает и до миграции.
3. **`supabase/maintenance/colonisation_events_source_hash_dedup.sql`** — если
   ещё не выполнялся после аудита 24.09 (дубли + уникальный индекс).
4. **Ручной прогон** `colonisation_events_prune(60)` + `VACUUM (ANALYZE)` (или
   дождаться ночного `colonisation-cleanup`).
5. `VACUUM FULL`/`pg_repack` в тихое окно, если нужно вернуть место ОС сразу.
6. **Пересборка Colonial Helper** (следующий релиз): перестанет отправлять
   `raw_event` и боевые облигации под видом жетонов. Сервер корректен и со
   старыми клиентами.

Ничего ломать предыдущие шаги не могут: порядок 1↔2 взаимозаменяем, prune
идемпотентен, старые клиенты совместимы.

## 10. Как проверить

```sql
-- Размер и динамика
SELECT pg_size_pretty(pg_total_relation_size('public.colonisation_events'));

-- Новые строки обязаны быть крошечными (маркер + resources_total)
SELECT max(octet_length(raw_event::text)) AS heaviest_raw_event
FROM public.colonisation_events WHERE created_at > now() - interval '1 day';

-- Рост остановился: после чистки цифры не должны расти неделями
SELECT date_trunc('day', created_at) AS day, count(*), sum(pg_column_size(resources_total)) AS resources_bytes
FROM public.colonisation_events GROUP BY 1 ORDER BY 1 DESC LIMIT 14;

-- Отчёт ночной чистки: docker logs jobs (задача colonisation-cleanup)
```

В ответе `/api/logs/import` и `/api/logs/upload`: `constructionInserted`
остаётся осмысленным, `constructionDuplicates` показывает отсечённые повторы.
На странице загрузки журнала неудавшиеся пачки телеметрии видны в сводке.

Тесты: `scripts/tests/colonisation-events.test.mjs` (маркер вместо сырого
события), `scripts/tests/journal-telemetry.test.mjs` (MercCoins_Current,
фильтр мусорных жетонов, отсутствие чтения из Combat_Bond_Profits),
`uploader/tests/test_upload_performance.py` (raw_event не отправляется),
`uploader/tests/test_companion_api.py` (баланс из bank_account),
`uploader/tests/test_capi_link.py` (статистика из Bank_Account).
