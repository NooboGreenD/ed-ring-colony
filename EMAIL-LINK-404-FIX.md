# Письмо подтверждения ведёт на Supabase и отвечает 404

**Дата:** 18.11.2026 · **Версия сайта:** 2.28.2

## Что видел пользователь

Новый пилот регистрируется, получает письмо «Подтвердите почту» и попадает на
адрес вида:

```
https://supabase.edringcolony.ru/auth/v1/verify?token=82878dcb…&type=signup&redirect_to=https://supabase.edringcolony.ru
```

Браузер отвечает «страницы не существует» (404). Адрес остаётся
неподтверждённым: войти нельзя, а повторная регистрация тем же адресом
выглядит как «письмо отправлено» и снова приводит на тот же 404.

## Причина

Ссылку собирает GoTrue (сервис `auth` стека Supabase) из своей переменной
`SITE_URL`, а не сайт. Значение было адресом **API Supabase**, поэтому:

1. GoTrue отправлял письмо встроенным шаблоном (наш шаблон
   `GOTRUE_MAILER_TEMPLATES_CONFIRMATION` не подключён). Встроенный шаблон
   содержит `{{ .ConfirmationURL }}`, то есть `{SITE_URL}/auth/v1/verify?token=…` —
   эндпоинт самого Supabase, а не страница сайта.
2. Запрос на `supabase.edringcolony.ru/auth/v1/verify` шёл в шлюз (Kong) стека
   Supabase: для браузера такой «страницы» нет, вместо подтверждения приходит
   404. Токен так и не был обменян — адрес остался неподтверждённым.
3. `redirect_to` в ссылке тоже указывал на адрес Supabase: даже при удачном
   обмене пилота вернуло бы на API, а не в кабинет.

Наш собственный шаблон (`src/app/auth/templates/[template]/route.ts`) этой
ошибке не подвержен: он кладёт `.TokenHash` в `{ .SiteURL }/auth/email#token_hash=…`,
и подтверждение идёт через `POST /api/auth/email/verify`. Но пока GoTrue шлёт
встроенное письмо, всё равно нужен правильный `SITE_URL` — иначе ссылка уводит
на API.

## Что исправлено

| Где | Что |
|---|---|
| `deploy/apply-smtp.sh` | перед SMTP-проверками приводит `SITE_URL` стека к публичному адресу сайта (`NEXT_PUBLIC_SITE_URL`, панель может передать `SITE_URL` сама) и пишет в журнал прежнее значение; проверяет, что сайт отдаёт шаблоны `/auth/templates/signup|recovery`, и после пересоздания `auth` сверяет `GOTRUE_MAILER_TEMPLATES_*` в его окружении — пустое значение или адрес API означают встроенное письмо со ссылкой `/auth/v1/verify` |
| `deploy/selfhost/upgrade.py` | `GOTRUE_SITE_URL` для `auth` — адрес сайта (`SITE`); адрес API остаётся в `API_EXTERNAL_URL` и в callback провайдеров |
| `scripts/update-agent.mjs` | `GET /smtp` отдаёт `siteUrl` и `siteUrlIsApi`: панель видит, что в `SITE_URL` лежит адрес API; `isSupabaseApiUrl()` ловит `supabase.<домен>`, `/api/supabase` и совпадение с `NEXT_PUBLIC_SUPABASE_URL`. В окружение применения почты добавлен `SITE_URL` |
| `src/app/api/admin/email-health/route.ts` | новая проверка «Адрес сайта в письмах (SITE_URL стека Supabase)» с действием `fix-site-url`; при недоступном агенте проверки просто нет, а не «всё хорошо» |
| `src/components/Admin/MailSettingsCard.tsx` | красное предупреждение «SITE_URL указывает на API» с кнопкой «Включить и применить» (та же `apply-smtp.sh` пишет адрес сайта и пересоздаёт `auth`), оранжевое — если override не передаёт адреса шаблонов |
| `src/app/auth/email/page.tsx` | старый формат письма (`token=…` без `token_hash`) теперь распознаётся и объясняется по-человечески: «письмо отправлено по старому шаблону, запросите новое». Раньше пилот видел общее «ссылка неверного формата» |
| `src/lib/i18n/translations.ts` | новые ключи (`ae.oldLink`, `mail.titleMailSiteUrl`, `mail.mailSiteUrlOk`, `mail.mailSiteUrlApi`, `mail.mailSiteUrlFix`, `mail.siteUrlFixing`) во всех семи локалях |

Тесты: `update-agent.test.mjs` (4 новых: `SITE_URL` исправляется, верный не
переписывается, отсутствие шаблонов попадает в журнал, `siteUrlIsApi` виден
панели), `email-auth.test.mjs` (2 новых: шаблоны строят ссылку от сайта, старый
формат распознан), `email-health.test.mjs` (3 новых: проверка адреса, верный
адрес, недоступный агент).

## Как починить на работающем сервере

Быстрый путь: **Админка → Авторизация → «Отправка писем» → «Диагностика»**.
Красная строка «Адрес сайта в письмах» → «Включить и применить»: скрипт запишет
`SITE_URL=<адрес сайта>` в `/opt/supabase/.env` и пересоздаст `auth`.

Вручную:

```bash
grep -n 'SITE_URL' /opt/supabase/.env          # должен быть адрес САЙТА
# SITE_URL=https://edringcolony.ru
# API_EXTERNAL_URL=https://supabase.edringcolony.ru   ← адрес API остаётся здесь
bash /opt/ed-ring-colony/src/deploy/apply-smtp.sh   # или «Применить и перезапустить» в панели
docker exec supabase-auth sh -c 'echo "$GOTRUE_SITE_URL"'
docker exec supabase-auth sh -c 'echo "$GOTRUE_MAILER_TEMPLATES_CONFIRMATION"'
```

Ожидаемо: `GOTRUE_SITE_URL` — адрес сайта, `GOTRUE_MAILER_TEMPLATES_CONFIRMATION`
— `https://<домен>/auth/templates/signup`. Письма, отправленные **до**
исправления, со старым `token=` не работают: их нужно запросить заново
(«Повторить подтверждение» на странице входа). Новые письма приходят со ссылкой
на `/auth/email#token_hash=…` и подтверждаются кнопкой на сайте.

Проверка без ожидания письма:

```bash
curl -fsS https://edringcolony.ru/auth/templates/signup | grep TokenHash
```

Должна вернуться строка шаблона — значит письмо возьмёт ссылку с сайта.
