# Критическая уязвимость: персональные данные profiles и самоназначение админом

Дата: 2026-10-15. Жалоба: «сторонний пользователь может получить
персональные данные с аккаунта и получить доступ к БД через ключ».

## Что было

Три дыры одного класса — «браузерный ключ Supabase открывает больше, чем
сайт»:

### 1. Email всех аккаунтов выгружался анонимным ключом

`001_rls_policies.sql` открывал таблицу профилей всем:

```sql
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO anon, authenticated USING (true);
```

`NEXT_PUBLIC_SUPABASE_ANON_KEY` лежит в JS-бандле каждой страницы, а шлюз
`/api/supabase` (или `supabase.<домен>`) принимает его напрямую. Поэтому
любой посетитель — без регистрации — мог одним curl выгрузить всю таблицу:

```
GET /rest/v1/profiles?select=id,email,cmdr_name,role
apikey: <анонимный ключ из бандла сайта>
```

Вместе с email уходили `role`, `privacy_settings` и `language`. Тот же
запрос делал и сайт: `DirectChat.tsx` при открытии чата забирал
`select("id,cmdr_name,email,avatar_url")` — список всех пилотов с адресами
— в браузер каждому вошедшему.

### 2. Любой вошедший мог сделать себя админом

`profiles_update` проверял только владение **строкой**:

```sql
CREATE POLICY profiles_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR …admin…)
  WITH CHECK (id = auth.uid() OR …admin…);
```

RLS — row-level: `WITH CHECK` не ограничивает **колонки**. Прямой запрос
к PostgREST повышал роль до админа, и с ней открывалась вся админка —
биллинг, список пилотов, мониторинг:

```js
await supabase.from('profiles').update({ role: 'admin' }).eq('id', myId);
```

Тот же трюк работал и на INSERT (профиль создаётся при первом входе, и до
этого момента строку можно вставить сразу с `role = 'admin'`), и с
`email`: подделка адреса в `profiles.email` маскировала пилота под другого
человека в глазах поддержки.

### 3. Приватность досье обходилась прямым запросом

`deliveries` читалась кем угодно (`USING (true)` для anon). Настройки
«груз» и «доставки» в `/account` фильтровали только то, что собирает
страница досье, — а напрямую из базы выгружались все перевозки любого
пилота. Ровно это уже чинили для `pilot_stats`/`capi_profiles` в
`20260917000000` — `deliveries` осталась незамеченной.

## Исправление

Миграция `supabase/migrations/20261015000000_profiles_rls_hardening.sql`
(зеркально — в `supabase/full_schema.sql`):

* **`profiles_select`** — только владелец строки и персонал
  (`admin`/`moderator`/`support_manager`) через новую функцию
  `request_is_staff()` — ту же схему, что `request_is_admin()` из
  `20261006000000`. `REVOKE SELECT … FROM anon` закрывает анонимный ключ.
* **Представление `public_profiles`** — те же строки, но только публичные
  колонки: `id, cmdr_name, avatar_url, squadron, created_at, updated_at,
  forum_posts_count`. Оно читается всеми (anon и authenticated), поэтому
  публичные места сайта — имена авторов форума/вики/комментариев, список
  пилотов, поиск друзей, составы эскадрилий и проектов — работают как
  раньше. `email`/`role`/`privacy_settings`/`language` в представлении нет.
* **Триггер `trg_protect_profile_privileged_columns`** — менять `role`
  может только администратор (или сервер: service_role и psql, где
  `auth.uid() IS NULL`), `email` синхронизируется только сервером. INSERT
  с чужой ролью тоже отклоняется.
* **`deliveries_select`** — владелец и персонал; `REVOKE … FROM anon`.

Код переведён на новую схему:

| Место | Что изменилось |
| --- | --- |
| `components/DirectChat.tsx` | список пилотов из `public_profiles`, **без email** |
| `components/FriendsPanel.tsx`, `app/cmdrs/page.tsx`, `app/squadrons/[id]/page.tsx` (приглашение) | поиск/список пилотов из `public_profiles` |
| имена авторов: `api/comments`, `api/forum/*`, `api/squadrons/[id]/chat`, страницы форума и вики, `lib/squadronData.ts` | гидрация авторов из `public_profiles` |
| `api/forum/latest` | service-role клиент: встроенная связь `author:profiles(...)` теперь видна только персоналу |
| `app/cmdr/[name]` (досье) | `profiles` и `deliveries` читает service-role клиент; фильтрация по `privacy_settings` осталась серверной и не изменилась |
| `api/leaderboard`, `api/leaderboard/stats` | агрегаты по `deliveries` собирает service-role клиент; наружу как и раньше — только имя и тонны |
| `app/projects/[id]/page.tsx` | браузерный fallback берёт имена участников из `public_profiles` отдельным запросом вместо embed `profiles(...)` |
| `api/home-data`, `api/forum/categories` | счётчик пилотов — по `public_profiles` |

Что не менялось: чтение собственного профиля (страница аккаунта,
`UserMenu`, выбор языка и приватности), админка и саппорт (персонал видит
все строки по-прежнему), все записи — `deliveries` и так писались только
владельцу и через service-role.

## Развёртывание

1. Накатить миграцию (`supabase/migrations/20261015000000_…sql`); её
   финальный `NOTIFY pgrst, 'reload schema'` сам перезагружает схему
   PostgREST, представление `public_profiles` появляется в REST сразу.
2. Переменные окружения не меняются.
3. Отката, ломающего сайт, нет: если код старый, а миграция новая, публичные
   страницы получат пустые имена авторов (читают `profiles` браузером) —
   поэтому миграция и код выходят одним изменением.
4. **Сменить ключи**: пока `SUPABASE_SERVICE_ROLE_KEY` не утекал (он
   серверный), считается, что утечек через anon-ключ после фикса больше
   нет. Если есть подозрение на эксплуатацию до деплоя — проверить
   `profiles.updated_at`/`role` на неожиданные изменения и сменить
   `SUPABASE_DB_PASSWORD` + JWT-секрет по инструкции SELFHOST.md.

## Проверка

`scripts/tests/profiles-rls-hardening.test.mjs` — функциональный тест на
настоящей базе (pglite): накатывает «уязвимое» состояние, затем миграцию и
проверяет роли:

* anon больше не может читать `profiles` и `deliveries` (permission denied);
* `public_profiles` отдаёт все строки, но не содержит `email`, `role`,
  `privacy_settings`, `language`, и не позволяет запись;
* вошедший видит только свой профиль и свои доставки;
* персонал видит все строки;
* `UPDATE … SET role='admin'` от обычного пользователя отклоняется
  триггером (эскалация закрыта), вставка строки сразу с ролью — тоже,
  подделка `email` — тоже;
* администратор по-прежнему меняет роли через админку; service_role
  работает как раньше.

Текстовые проверки миграции — там же (политики не содержат anon-веток,
представление — только безопасные колонки). Синтаксис SQL проверяется
`migrations-sql.test.mjs` (libpg-query).
