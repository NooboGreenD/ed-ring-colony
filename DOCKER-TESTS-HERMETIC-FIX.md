# Сборка web: `npm test` внутри docker build валился (9 упавших тестов)

## Симптомы

- Обновление проекта (кнопка «Обновить сейчас» / `update-project.sh`) падает
  на этапе сборки образов:

  ```
  # tests 942
  # pass 863
  # fail 9
  # skipped 70
  ERROR: process "/bin/sh -c if [ "$RUN_TESTS" = "1" ]; then npm test; …" did not complete successfully: exit code: 1
  ```

- Локально (`npm test` на машине разработчика) тот же комит — **полностью
  зелёный**: 942 passed, 0 failed.
- Сборка ретраится трижды и всё равно падает → «не собрался образ web».

## Причина

Тестовый слой `RUN npm test` выполняется в **builder-стадии web-образа на
`node:22-alpine`**, и это окружение отличается от рабочей машины сразу по
трём пунктам. Тесты, которые не учитывали эти отличия, падали (все 9):

### 1. В alpine нет `bash` (3 падения)

update-agent запускает job-скрипты через `spawn('bash', [script])` — так
устроен продакшн (образ агента ставит bash через `apk add` явно). В
builder-стадии web-образа bash нет, поэтому:

- `db-backup.test.mjs` — «backup http: запуск, одиночность…» и «backup http:
  ошибка скрипта видна админу…»: стаб `fake-backup.sh` умирал с
  `spawn bash ENOENT`, одиночность копии не проверялась (202 вместо 409);
- `env-route.test.mjs` — «клиент + агент: … применение ключей»: стаб
  `apply-env.sh` не запускался, job завершался `failed`.

Пять других shell-наборов (compose-switch, update-script, monitor-bootstrap,
rebuild-now, update-agent) на этот случай уже были закрыты гейтом
`hasBash`/`needsBash` → в логе сборки видно ровно **70 skipped**.

### 2. В alpine нет `python3` (1 падение)

- `uploader-server-release.test.mjs` — «сервер сам подписывает и собирает
  рабочий ZIP…»: состав архива проверялся через `python3 -c 'import
  zipfile …'`. Соседний `uploader-store.test.mjs` на этот случай уже умел
  пропускаться, а этот — нет.

### 3. Build-args из `.env` становятся ENV тестового слоя (5 падений)

`docker-compose.yml` передаёт в web `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SITE_URL`, `SUPABASE_INTERNAL_URL` и др. как build-args — они
нужны следующему слою `next build`. Но `ENV` в Dockerfile объявлен **до**
`RUN npm test`, и «настоящие» значения попадали в окружение тестов:

- `email-auth.test.mjs` (4 падения): `getServerSupabaseUrl()` предпочитает
  `SUPABASE_INTERNAL_URL`, запрос настроек auth уходил на внутренний Kong,
  а стаб `fetch` ждал публичный URL → 503 вместо 202 в signup-сценариях;
- `avatar-squadron-routes.test.mjs` (1 падение): заглушки ставились через
  `process.env.NEXT_PUBLIC_SUPABASE_URL ??= …` — при уже заданной переменной
  «настоящее» значение побеждало, и адрес аватара собирался с боевого хоста.

## Лечение

Применено в этом коммите — повторных действий на сервере не требуется:

1. **Тесты стали герметичными.** Заглушки окружения ставятся принудительно
   (`process.env.X = '…'` вместо `??=`), `email-auth` вычищает
   `SUPABASE_INTERNAL_URL` в `reset()`; то же — в architect-*, capi-,
   leaderboard- и logs-наборах, где `??=` был миной замедленного действия.
2. **Shell-зависимые тесты честно пропускаются без bash** (как остальной
   набор): два http-теста бэкапа получили `{ skip: needsBash }`, а
   «клиент + агент» разделён на CRUD-часть (работает без bash) и
   apply-часть (bash-гейт) — CRUD теперь проверяется и в docker build.
3. **ZIP проверяется без python3**: `uploader-server-release` читает
   центральный каталог архива на чистом Node (EOCD → записи `PK\x01\x02`).
4. **Dockerfile вычищает build-args вокруг тестовой команды** (второй рубеж
   обороны — на случай будущих тестов, читающих ambient-окружение):

   ```dockerfile
   RUN if [ "$RUN_TESTS" = "1" ]; then \
         env -u NEXT_PUBLIC_SUPABASE_URL -u NEXT_PUBLIC_SUPABASE_ANON_KEY \
             -u NEXT_PUBLIC_SITE_URL -u NEXT_PUBLIC_VAPID_PUBLIC_KEY \
             -u SUPABASE_INTERNAL_URL npm test; \
       else echo "RUN_TESTS=0 — тесты пропущены"; fi
   ```

   Слою `next build` переменные по-прежнему доступны: `env -u` действует
   только на команду тестов. **Добавили новый NEXT_PUBLIC_*/служебный
   build-arg — допишите его в этот список.**

## Проверка

- Локально (bash/git/python3 есть, окружение чистое): `943 pass / 0 fail /
  0 skipped`.
- Симуляция builder-стадии (PATH без bash/git/python3 + «боевые» значения
  NEXT_PUBLIC_*/SUPABASE_INTERNAL_URL в окружении): `870 pass / 0 fail /
  73 skipped` — упавших нет, состав скипов совпадает с прежними 70 плюс
  три новых bash-зависимых (2 db-backup http + env apply).

Экстренный обходной путь (без обновления кода) остаётся прежним:
`RUN_TESTS=0` в `.env` — тестовый слой пропускается целиком.
