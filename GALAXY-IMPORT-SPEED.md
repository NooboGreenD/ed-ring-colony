# Каталог систем: почему 20 систем/с и как это ускорить

> Исходная жалоба: импорт идёт со скоростью **~20 систем/с**, а в каталоге
> **201 370 977** систем. При такой скорости заливка займёт **≈116 лет** —
> это не «долго», это сломанный путь записи, а не медленный.
>
> Ориентир нормы: прямой Postgres на обычном SSD должен давать
> **30–150 тыс. строк/с** через `COPY` и **5–20 тыс. строк/с** через пачечные
> `INSERT`. То есть сейчас потеряно три-четыре порядка.

Цифры для прикидки при 2×10⁸ строк:

| скорость | время полной заливки |
| --- | --- |
| 20 /с | 116 лет |
| 1 000 /с | 56 часов |
| 10 000 /с | 5,6 часа |
| 50 000 /с | 1,1 часа |
| 100 000 /с | 34 минуты |

---

## 1. Сначала диагностика: три числа, которые всё объясняют

Прежде чем что-то крутить, снимите три факта — они отличают «не тот путь
записи» от «медленный диск».

**а) Каким путём идёт запись.** В логе импорта есть строка `DB mode: …`:

```
[spansh-import] DB mode: pg (postgresql://…)        ← прямой Postgres
[spansh-import] DB mode: supabase (https://…)       ← PostgREST, HTTP
```

В админке то же самое показывает `/api/galaxy/stats` (поле `backend`) и
`--check-db`:

```bash
node scripts/import-spansh-systems.mjs --check-db
```

**`backend: supabase` — это и есть ваши 20/с.** Путь через PostgREST пишет
пачками по 200 строк (`SUPABASE_BATCH_SIZE`), каждая — HTTP-запрос с JSON,
который Supabase рубит по `statement_timeout`; после таймаута пачка делится
пополам и повторяется, в пределе — построчно. Этот путь существует как
аварийный («хоть как-то»), а не как режим заливки 6 ГиБ.

**б) Что делает база прямо сейчас:**

```sql
SELECT pid, state, wait_event_type, wait_event,
       now() - query_start AS running, left(query, 120) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND state <> 'idle'
ORDER BY query_start;
```

Если `wait_event_type = 'IO'` — упёрлись в диск; если запрос висит в
`DELETE FROM galaxy_systems WHERE name_lc IN (…) OR id64 IN (…)` — это пункт
2.2 ниже (seq scan по всему каталогу).

**в) Сколько реально весит одна пачка:**

```sql
EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM galaxy_systems WHERE name_lc IN ('sol') OR id64 IN ('10477373803');
```

`Seq Scan on galaxy_systems` в плане = подтверждение диагноза.

---

## 1a. Частный случай: «db:5432 — timeout expired», PostgREST настроен

Именно это и означает 20/с: импорт идёт по аварийному HTTP-пути, потому что
прямое подключение не поднимается. Важная деталь — формулировка ошибки:

| ошибка драйвера | что произошло | что делать |
| --- | --- | --- |
| `getaddrinfo EAI_AGAIN db` | имя `db` не резолвится | подключить `web` к сети Supabase |
| **`timeout expired`** | имя **резолвится**, но TCP не доходит | см. ниже |

`timeout expired` при хосте `db` почти всегда значит одно из двух:

1. **`db` увели в сторону.** Контейнера `db` в сети `web` нет, но внешний DNS
   (поисковый домен провайдера, wildcard) отвечает на короткое имя чужим
   **публичным** адресом. Соединение честно висит до таймаута — firewall ни
   при чём, хотя сообщение намекает именно на него.
2. **Сеть есть, но трафик режут** правила `DOCKER-USER`/ufw, либо контейнер
   Postgres живёт в другой сети, чем та, где резолвится имя.

Поэтому проверка подключения теперь **отдельно спрашивает DNS и отдельно
открывает сокет** (`src/lib/pgReachability.ts`) и пишет, во что именно
разрешилось имя:

```
DNS «db»: 203.0.113.7 · порт 5432: dns-public
Имя «db» резолвится в ПУБЛИЧНЫЙ адрес 203.0.113.7 — это не контейнер Supabase…
```

```
DNS «db»: 172.18.0.5 · порт 5432: tcp-timeout
Адрес найден, но порт 5432 не ответил — проверьте сеть контейнеров и DOCKER-USER/ufw.
```

Это видно и в админке (кнопка «Проверить подключение к БД»), и в CLI:

```bash
node scripts/import-spansh-systems.mjs --check-db
```

**Если в панели всё ещё старый текст** («Похоже на firewall/маршрут» без
строки `DNS «db»: …`) — контейнер собран до этих правок. Ждать пересборки не
нужно: есть автономный скрипт без единой зависимости, кроме Node. Его можно
запустить на хосте, из любого контейнера и на старой сборке:

```bash
node scripts/check-db-reachability.mjs                         # из DATABASE_URL
node scripts/check-db-reachability.mjs db:5432 host.docker.internal:5432 172.17.0.1:5432 127.0.0.1:5432
docker compose exec web node /app/scripts/check-db-reachability.mjs db:5432
```

Он резолвит имя, открывает сокет и печатает вердикт по каждому адресу —
сразу видно, какой из вариантов подставить в `DATABASE_URL`.

### Как починить (по порядку)

**Шаг 1. Подключить `web` к сети стека Supabase** — штатный способ, файл уже
есть в репозитории:

```bash
docker network ls | grep -i supabase          # точное имя сети
echo 'SUPABASE_NETWORK=supabase_default' >> .env.production
docker compose --env-file .env.production --profile monitoring \
  -f docker-compose.yml -f deploy/compose.supabase-net.yml up -d
docker network inspect supabase_default --format '{{range .Containers}}{{.Name}} {{end}}'
# в списке должны быть и supabase-db, и ed-ring-colony-web
```

Затем `DATABASE_URL=postgresql://postgres:ПАРОЛЬ@db:5432/postgres`
(пароль — `POSTGRES_PASSWORD` из `/opt/supabase/.env`).

**Шаг 2. Если сеть подключить нельзя** — адресуйте Postgres так, как его
видит контейнер. У `web` уже проброшен `host.docker.internal`:

```bash
# на хосте: убедиться, что порт слушается
ss -ltnp | grep 5432
# в .env.production
DATABASE_URL=postgresql://postgres:ПАРОЛЬ@host.docker.internal:5432/postgres
# либо IP docker-моста: 172.17.0.1
```

Проверка изнутри контейнера (три команды, которые сразу всё показывают):

```bash
docker compose exec web getent hosts db
docker compose exec web sh -c 'nc -zv db 5432 || true'
docker compose exec web sh -c 'nc -zv host.docker.internal 5432 || true'
```

**Шаг 3. Самый быстрый обход для разовой заливки** — не чинить сеть
контейнера вовсе, а запустить импорт **на хосте**, рядом с базой:

```bash
cd /opt/ed-ring-colony/src
DATABASE_URL=postgresql://postgres:ПАРОЛЬ@127.0.0.1:5432/postgres \
  node scripts/import-spansh-systems.mjs --from-shards
```

Каталог один на всех — неважно, какой процесс его наполняет.

> Пока прямое подключение не поднято, **не запускайте полную заливку**: путь
> PostgREST физически не способен залить 2×10⁸ строк.

## 2. Что именно тормозило (по убыванию вклада)

### 2.1. Путь PostgREST вместо прямого Postgres — ×100…×1000

Разобрано выше. Лечится не оптимизацией, а настройкой `DATABASE_URL`
(или `SUPABASE_DB_URL`) в том процессе, который делает импорт. Проверка —
`--check-db`. Если web-контейнер не видит сервис `db` чужой compose-сети,
проще запускать импорт CLI-скриптом рядом с базой:

```bash
DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/postgres \
  node scripts/import-spansh-systems.mjs --from-shards
```

### 2.2. `DELETE … WHERE name_lc IN (…) OR id64 IN (…)` — до ×50

Старый пачечный путь перед каждым `INSERT` снимал конфликты по обоим
уникальным индексам одним запросом с `OR`. Два разных индекса под `OR` плюс
2000 литералов в каждом списке — планировщик на большой таблице регулярно
выбирает `Seq Scan` по 2×10⁸ строкам. Одна такая пачка — десятки секунд, то
есть ровно наблюдаемые «десятки систем в секунду».

Исправлено: конфликты снимаются `DELETE … USING staging` — join по
`uq_galaxy_systems_id64`, без `OR` и без списков литералов.

### 2.3. Текстовые `INSERT … VALUES` вместо `COPY` — ×5…×20

Пачка 2000×13 литералов — это мегабайты SQL, которые сервер парсит и
планирует заново каждый раз. `COPY FROM STDIN` не парсит SQL вообще и пишет
страницами.

Исправлено: новый писатель `src/lib/galaxyCopyWriter.ts` (см. раздел 3).

### 2.4. Поддержка индексов на лету — ×3…×10 на холодной заливке

На `galaxy_systems` висят GIN по триграммам имени и GiST по кубу координат —
самые дорогие на вставку структуры в Postgres. На холодном старте их надо
снимать и строить после заливки:

```bash
psql "$DATABASE_URL" -f supabase/maintenance/galaxy_systems_bulk_load.sql
# … импорт …
psql "$DATABASE_URL" -f supabase/maintenance/galaxy_systems_rebuild_indexes.sql
```

Уникальные индексы (`uq_galaxy_systems_id64`, `uq_galaxy_systems_name_lc`)
снимать **нельзя**: на них держится идемпотентность возобновляемого импорта.

### 2.5. Настройки сервера под bulk-заливку — ×1,5…×3

Разово, на время заливки (в `postgresql.conf` или `ALTER SYSTEM` + reload):

```
max_wal_size = 16GB            # иначе checkpoint каждые несколько секунд
checkpoint_timeout = 30min
checkpoint_completion_target = 0.9
maintenance_work_mem = 2GB     # сборка индексов после заливки
work_mem = 256MB
autovacuum_vacuum_cost_delay = 0   # либо autovacuum off на galaxy_systems
synchronous_commit = off       # импорт уже ставит это для своей сессии
```

Плюс `full_page_writes = off`, если переживёте потерю базы при аварии питания
(на холодной заливке — переживёте: повторите импорт).

### 2.6. Что уже сделано раньше и работает

Лестница дельт (`systems_1day … systems.json.gz`), параллельная докачка
`Range`-сегментами, шарды TSV — всё это про **доставку** файла и описано в
[SPANSH-IMPORT.md](SPANSH-IMPORT.md). Они уже убрали «неделю на скачивание»;
оставшееся узкое место было именно в записи в базу.

---

## 3. Что изменено в коде

**`src/lib/galaxyCopyWriter.ts`** — быстрый путь записи:

1. строки уходят в UNLOGGED-таблицу `galaxy_systems_stage` одним
   `COPY FROM STDIN` (пачками по `COPY_CHUNK_ROWS = 50 000`);
2. накопив `COPY_MERGE_ROWS = 250 000` строк, одна транзакция:
   - схлопывает дубли внутри пачки по `name_lc`, затем по `id64`
     (hash-self-join по таблице без индексов — копейки; без этого
     `ON CONFLICT` падает с 21000, а второй уникальный индекс — с 23505);
   - `DELETE FROM galaxy_systems g USING stage s WHERE g.id64 = s.id64 AND
     g.name_lc <> s.name_lc` — снимает переименованные системы по индексу;
   - `INSERT … SELECT … FROM stage ON CONFLICT (name_lc) DO UPDATE` — одна
     вставка на 250 тыс. строк;
   - `TRUNCATE stage`, `COMMIT`.
3. при ошибке — `ROLLBACK` + `TRUNCATE stage`: приёмник всегда пуст, поэтому
   повтор пачки не задваивает строки, а возобновление по шардам работает
   по-прежнему (единица прогресса — шард, а не строка).

Путь включён **по умолчанию** везде, где есть прямой Postgres:

- CLI `npm run spansh:import` (новые флаги `--no-copy`, `--merge-rows N`);
- импорт из приложения (админка, `POST /api/cron/galaxy-import`).

Запасной пачечный `INSERT`-путь никуда не делся: он используется, если
`pg-copy-streams` не установлен или задано `GALAXY_COPY=0`. Путь PostgREST
не изменился — он и не должен использоваться для полной заливки.

Новая зависимость: `pg-copy-streams@^7` (единственный способ отдать
`COPY FROM STDIN` через драйвер `pg`). После обновления — `npm ci`.

---

## 4. Рекомендуемый порядок для вашего случая (каталог залит частично)

```bash
# 0. Убедиться, что путь прямой, а не PostgREST
node scripts/import-spansh-systems.mjs --check-db

# 1. Снять тяжёлые индексы (поиск по имени и атлас временно деградируют)
psql "$DATABASE_URL" -f supabase/maintenance/galaxy_systems_bulk_load.sql

# 2. Долить каталог из шардов (COPY-путь включится сам)
GALAXY_SHARDS_PRUNE=1 node scripts/import-spansh-systems.mjs --from-shards

# 3. Вернуть индексы и статистику
psql "$DATABASE_URL" -f supabase/maintenance/galaxy_systems_rebuild_indexes.sql
```

Контроль скорости прямо во время заливки:

```sql
SELECT count(*) FROM galaxy_systems;   -- дважды с интервалом в минуту
```

Ожидание на приличном NVMe: **часы, а не недели**. Если после шагов 0–2
скорость всё ещё меньше ~5 тыс. строк/с — это уже диск или CPU базы, и
следующий шаг другой: смотреть `pg_stat_activity.wait_event` и `iostat -x 1`.

---

## 5. Что можно сделать дальше, если и этого мало

- **Партиционирование `galaxy_systems`** по диапазону `id64` (16–64 секции):
  индексы становятся локальными и помещаются в память, а заливку можно вести
  в несколько секций параллельно. Это заметная миграция — делать, только если
  ×10 от `COPY` не хватило.
- **Параллельная заливка в N соединений**: шарды независимы, каждый можно
  лить своим `COPY` в свою staging-таблицу. Упирается в диск, но на NVMe даёт
  ещё ×2…×4. В текущем коде не включено сознательно: один писатель = простой
  и честный resume-пойнт.
- **Отказ от `TEXT` для `id64`** (сейчас это строка ради 2⁶⁴): `NUMERIC(20)`
  или два `BIGINT` уменьшат индекс и сравнения. Выгода меньше, чем цена
  миграции и правок кода.
- **`UNLOGGED galaxy_systems` на время холодного старта** с последующим
  `ALTER TABLE … SET LOGGED`: убирает WAL целиком (ещё ~×1,5), но `SET LOGGED`
  потом перепишет таблицу — выгодно только при действительно пустом каталоге.
