# Привязка Frontier CAPI: почему не работала и что исправлено

Разбор и правки: **27 сентября 2026**. Симптом из обращения: «все этапы OAuth
проходят, но сама привязка не выполняется, профиль CMDR и статистика не
подтягиваются».

Проверить настоящий вход в аккаунт Frontier из среды разработки нельзя (нет
живого аккаунта и белого адреса для `redirect_uri`), поэтому весь поток закрыт
тестами на реальных route handlers с подменённым HTTP и Supabase — см. раздел 6.

---

## 1. Почему привязки не было

Все причины наблюдались одновременно; любая из них в одиночку уже ломала
привязку.

| # | Причина | Где было | Следствие для пилота |
|---|---|---|---|
| 1 | Колбэк ходил в CAPI **до** сохранения токенов: `exchangeCode()` → `getProfile()` → и только потом `upsert capi_tokens` | `src/app/api/capi/callback/route.ts` | Любой сбой Companion API (`418` техобслуживание, `204` у аккаунта без входа в игру, таймаут) выбрасывал исключение — токены не сохранялись. OAuth «прошёл», привязки нет |
| 2 | Тело ответа читалось как `res.json()` без защиты | `src/lib/capi/client.ts` | `204/206` (пустое тело) и HTML-страница техработ давали `SyntaxError: Unexpected end of JSON input`, который поднимался наверх как полный отказ |
| 3 | Профиль разбирался по несуществующим полям: `profile.credits`, `profile.loan`, `profile.ranks.cqc`, `profile.commander.id` в колонку `frontier_id` | колбэк и `src/app/api/cron/capi-sync/route.ts` | Даже при удачной записи в `capi_profiles` уходили `null`: CAPI отдаёт `commander.credits`, `commander.debt`, `commander.rank.cqc`, `lastSystem.name`, `ship.shipName`. Это и есть «данные не подтягиваются» |
| 4 | `getJournal()` ожидал JSON `{ events: [] }` | `client.ts`, cron | `/journal` отдаёт **NDJSON-текст** (строка = событие). Журнал не импортировался никогда, а исключение снова рушило синхронизацию целиком |
| 5 | `User-Agent: ED-Ring-Colony/2.12.0` | `client.ts` | Frontier требует формат `EDCD-[A-Za-z]+-[.0-9]+` (EDCD/FDevIDs → Frontier API/README.md); чужие агенты режутся |
| 6 | Владелец привязки определялся только по cookie-сессии Supabase в момент возврата с домена Frontier | колбэк | Если сессия не доезжала (истёк access-токен, строгий браузер, вход занял дольше), пилот получал `not_logged_in` уже **после** успешной авторизации у Frontier |
| 7 | TTL cookie потока — 600 с | `src/app/api/capi/auth/route.ts` | Вход с 2FA и подтверждением почты нередко дольше 10 минут → `invalid_state` |
| 8 | `upsert` писал сразу все колонки | колбэк | На базе, где миграции `20260916*`/`20261002*` ещё не накатаны, PostgREST отвечал `PGRST204` и **вся** запись отменялась — включая токены |
| 9 | Страница игнорировала `?status` и `?message`, «подключено» определялось по наличию строки `capi_profiles` | `src/app/account/capi/page.tsx` | Причина ошибки не показывалась вообще, а живая привязка с пустым профилем выглядела как «не подключено» |

---

## 2. Что изменено

### 2.1 Порядок колбэка

```
код → exchangeCode() → fetchFrontierIdentity() → проверка чужой привязки
    → upsertResilient('capi_tokens')          ← ПРИВЯЗКА зафиксирована здесь
    → syncCapiPilot()  (профиль, pilot_stats, журнал, позиция)
    → redirect /account/capi?status=success|partial|error&reason=…
```

Сбой CAPI после шага записи токенов больше не отменяет привязку: пилот получает
`status=partial` с причиной и работающую кнопку «Синхронизировать».

### 2.2 Новые модули `src/lib/capi/`

| Файл | Назначение |
|---|---|
| `profile.ts` | `normalizeCapiProfile()` — единственное место, где ответ CAPI превращается во внутреннюю форму; `capiProfileRow()`/`pilotStatsRow()` — строки для БД; `isBlankProfile()` |
| `journal.ts` | `parseCapiJournal()` — построчный NDJSON, обрезанные строки собираются в `malformedLines` вместо исключения; `journalPath()` → `/journal/YYYY/MM/DD` |
| `persist.ts` | `upsertResilient()`/`updateResilient()` — при `PGRST204`/`42703` отбрасывают отсутствующую колонку и повторяют запись; обязательные поля не отбрасываются; `schemaWarning()` пишет в лог, каких колонок не хватает |
| `linkState.ts` | cookie потока (`capi_state`, `capi_pkce`, `capi_link`), TTL 30 минут, подписанная HMAC-cookie с UUID пилота, `safeEqual()`, сборка редиректа с машинным `reason` |
| `syncPilot.ts` | Общая для колбэка, ручного синка и cron загрузка: профиль → `capi_profiles` + `pilot_stats` + имя CMDR в `profiles` → журнал → события колонизации → позиция |
| `messages.ts` | Машинный `reason` → текст и подсказка для интерфейса (14 причин) |

### 2.3 Маршруты

- `/api/capi/auth` — выбор платформы (`audience`: frontier/steam/epic/…), подписанная cookie владельца, TTL 30 минут.
  По умолчанию запрашивается список `frontier,steam,epic` (как в EDMC): один лишь `frontier` даёт токен учётки
  магазина, и CAPI отвечает `400 Please Visit the store to purchase Elite: Dangerous` — см. [CAPI-400-FIX.md](CAPI-400-FIX.md).
- `/api/capi/callback` — порядок из 2.1, понятные `reason`, отказ при попытке привязать один аккаунт Frontier к двум учётным записям (`already_linked_elsewhere`).
- `/api/capi/sync` — ручной синк через общий `syncCapiPilot()`, отвечает отчётом (`journalStatus`, импортировано/дубликаты, предупреждения).
- `/api/capi/profile` — отдаёт `binding.linked` по строке `capi_tokens`, поэтому живая привязка видна и без строки в `capi_profiles`.
- `/api/capi/journal` — NDJSON, статусы `204/206` как `empty`/`partial`.
- `/api/capi/status` — **новое**: диагностика без секретов (маска `client_id`, совпадает ли `redirect_uri` с адресом сайта, состояние токена, пустая ли строка профиля, живая проба CAPI).
- `/api/capi/unlink` — снимает `is_active` и чистит кэш.
- `/api/cron/capi-sync` — переведён на тот же `syncCapiPilot()` (раньше дублировал ошибочный разбор).

### 2.4 Интерфейс `/account/capi`

Читает `?status`/`?reason`, показывает баннер с причиной и подсказкой, состояние
токена (когда истекает, когда привязан, платформа, последняя ошибка), кнопку
«Диагностика» (`/api/capi/status`) и отчёт синхронизации. Стили — блок `.capi-*`
в `src/app/globals.css`.

---

## 3. Миграция БД

`supabase/migrations/20261003000000_capi_binding_diagnostics.sql` — идемпотентна,
только `ADD COLUMN IF NOT EXISTS`:

- `capi_tokens`: `platform`, `linked_at`, `last_error`, `last_error_at`;
- индекс по `frontier_id` (проверка «этот аккаунт Frontier уже привязан») и
  индекс очереди cron по `last_synced_at NULLS FIRST`;
- повтор `capi_profiles`: `mercenary_rank`, `exobiologist_rank`, `cqc_rank`,
  `loan`, `frontier_id` — у баз, залитых ранним снимком схемы, их может не быть,
  и тогда синк молча терял эти поля.

Блок добавлен и в снимок `supabase/full_schema.sql` (требование
[SQL-MIGRATIONS-AUDIT.md](SQL-MIGRATIONS-AUDIT.md)).

Применение — как обычно:

```bash
docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20261003000000_capi_binding_diagnostics.sql
```

или `UPDATE_APPLY_MIGRATIONS=1 deploy/update-project.sh`.

**Миграция не блокирует работу**: без неё `upsertResilient()` отбросит новые
колонки, запишет остальное и оставит в логе предупреждение
`В таблице capi_tokens нет колонок: …`.

---

## 4. Настройки окружения

| Переменная | Нужна | Замечание |
|---|---|---|
| `FRONTIER_REDIRECT_URI` | желательно | По умолчанию — `<NEXT_PUBLIC_SITE_URL>/api/capi/callback`. Значение обязано **точно** совпадать с адресом в Frontier Developer Zone |
| `NEXT_PUBLIC_SITE_URL` | да | Из него берётся адрес возврата и все редиректы |
| `FRONTIER_CLIENT_ID` | нет | По умолчанию ключ приложения `0d6027a7-2561-4e1b-af2e-2fe71b296bdd` |
| `FRONTIER_CLIENT_SECRET` | нет | PKCE; Shared Key от FDEV не требуется |
| `CAPI_STATE_SECRET` | нет | Ключ подписи cookie владельца потока; по умолчанию берётся `SUPABASE_SERVICE_ROLE_KEY` |

Быстрая проверка конфигурации после деплоя — `GET /api/capi/status` под своей
учётной записью (секреты не отдаются, только маски и флаги).

---

## 5. Как проверить на живом сервере

1. `/account/capi` → «Подключить Frontier Account», выбрать платформу.
2. После возврата ожидается `status=success` и заполненная карточка: имя CMDR,
   кредиты, ранги, корабль, система (станция — только если пилот пристыкован).
3. `status=partial&reason=profile_unavailable` — привязка есть, CAPI молчит
   (`418` техобслуживание или пилот ни разу не заходил в игру). Кнопка
   «Синхронизировать» через несколько минут должна дать `success`.
4. Досье `/cmdr/<имя>` и `/api/cmdr/stats` берут те же данные из `pilot_stats`.
5. Кнопка «Диагностика» показывает: совпадает ли `redirect_uri`, активен ли
   токен, когда истекает, пуста ли строка профиля, что ответил CAPI сейчас.

Частые ответы диагностики:

| Что видно | Что делать |
|---|---|
| `redirectMatchesSite: false` | Адрес в Frontier Developer Zone не совпадает с `NEXT_PUBLIC_SITE_URL` |
| `reason=expired_state` | Вход занял больше 30 минут либо cookie чистятся между доменами |
| `reason=already_linked_elsewhere` | Этот аккаунт Frontier уже привязан к другой учётной записи сайта — сначала отвязать там |
| `stored.looksEmpty: true` | Токен есть, данных нет: нажать «Синхронизировать» после входа в игру |

---

## 6. Тесты

```bash
node --test scripts/tests/capi-callback-route.test.mjs   # сквозной поток на настоящих route handlers
node --test scripts/tests/capi-profile-parse.test.mjs    # разбор /profile
node --test scripts/tests/capi-journal.test.mjs          # NDJSON, статусы 204/206/418, User-Agent
node --test scripts/tests/capi-binding.test.mjs          # cookie, подпись state, устойчивая запись
npm test                                                 # всё вместе
```

Сквозной тест проверяет: успешную привязку с реальными значениями профиля,
`418` → `partial` при сохранённом токене, пустой журнал (`204`) как норму,
отставшую схему БД, `invalid_state`/`missing_code`/`access_denied` без записи в
БД, ручной синк и видимость привязки в `/api/capi/profile` без строки
`capi_profiles`.

Чего тесты не заменяют: настоящий вход в аккаунт Frontier, поведение живого
Companion API и лимит ~1 запрос в минуту на аккаунт.
