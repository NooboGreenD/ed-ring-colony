# Регистрация «временно закрыта» при рабочем SMTP

**Дата:** 28.10.2026 · **PR:** #228 · **Версия сайта:** 2.25.3

## Что видел пользователь

Гость открывает регистрацию и получает:

```
Новые регистрации временно закрыты.
```

Письма при этом уходят: почта настроена, подтверждение адреса не
автоподтверждается. Диагностика (Админка → Авторизация → «Отправка писем» →
«Диагностика») показывает одну красную строку из шести:

```
✓ AUTH_EMAIL_ENABLED на сайте
✓ NEXT_PUBLIC_SUPABASE_ANON_KEY
✓ Доступность GoTrue из web
✓ Подтверждение почты в GoTrue — mailer_autoconfirm выключен
✗ Регистрация в GoTrue — disable_signup=true
   как починить: Выставьте GOTRUE_DISABLE_SIGNUP=false.
✓ Провайдер email в GoTrue
```

## Причина (по фактам, а не по догадке)

Сообщение выдаёт сам сайт, в одном месте — `src/lib/emailAuth.ts`
(`requireEmailDelivery(signup=true)`): он спрашивает у GoTrue
`/auth/v1/settings` и отказывает, если `disable_signup !== false`. Значит
GoTrue действительно запущен с закрытой регистрацией.

Дальше — как значение туда попадает:

1. Стек Supabase (GoTrue, сервис `auth`) получает настройку **из переменной
   контейнера** `GOTRUE_DISABLE_SIGNUP`.
2. Эту переменную задаёт не `.env` стека напрямую, а управляемый
   compose-override `deploy/selfhost/supabase-auth.override.yml`:

   ```yaml
   GOTRUE_DISABLE_SIGNUP: ${DISABLE_SIGNUP:-true}
   ```

   то есть compose берёт **`DISABLE_SIGNUP`** из `/opt/supabase/.env`, а если
   ключа нет — подставляет `true` (закрыто). Так ставит `deploy/selfhost/
   install.sh`.
3. Поэтому строка `GOTRUE_DISABLE_SIGNUP=false` в `.env` стека **не делает
   ничего**: compose читает `.env` только как источник подстановок, а имя
   `GOTRUE_DISABLE_SIGNUP` внутри контейнера занято подстановкой `${DISABLE_SIGNUP}`.
   Прежняя подсказка диагностики советовала именно эту строку — отсюда
   «выставил, а регистрация по-прежнему закрыта».
4. Вторая половина проблемы: GoTrue читает окружение **на старте**. Правка
   `.env` без `up -d --no-deps --force-recreate auth` ничего не меняет даже при
   верном имени ключа.

Типичный сценарий, который к этому приводит: SMTP настроили вручную (или
давно), `install.sh` при установке оставил `DISABLE_SIGNUP=true`, а job
применения почты (`kind=smtp`) после этого не запускали.

## Что исправлено

| Где | Что |
|---|---|
| `deploy/apply-smtp.sh` | перед проверкой SMTP-ключей: нашёл `GOTRUE_DISABLE_SIGNUP` — переименовал в `DISABLE_SIGNUP` (значение сохраняется), в журнал задачи пишет, что именно переименовал. Новая стадия `smtp_signup` спрашивает у GoTrue его `/settings` **изнутри контейнера** и, если `disable_signup` всё ещё `true`, валит задачу с причиной вместо «настройки почты применены» |
| `src/app/api/admin/email-health/route.ts` | подсказка называет рабочее имя ключа (`DISABLE_SIGNUP`) и второй обязательный шаг (пересоздание `auth`); добавлено машинное поле `action` (`enable-signup`, `enable-site-forms`, `configure-smtp`) |
| `src/components/Admin/MailSettingsCard.tsx` | у красной строки диагностики — кнопка «Включить и применить»: пишет `DISABLE_SIGNUP=false` (или `AUTH_EMAIL_ENABLED=true`) и запускает job `kind=smtp`. Предупреждение, если в `.env` лежит `GOTRUE_DISABLE_SIGNUP` |
| `scripts/update-agent.mjs`, `src/app/api/admin/smtp/route.ts`, `src/lib/updateAgent.ts` | панель видит «чужое» имя ключа в `.env` (`legacySignupKey`) и объясняет, почему оно не работает |
| `scripts/lib/update-state.mjs` | стадия `smtp_signup` в списке `SMTP_STAGES` (видна в панели) |
| `UBUNTU20-UPGRADE.md`, `MONITORING.md` | правильное имя ключа и раздел «Регистрация отвечает „Новые регистрации временно закрыты“» с ручными командами |

## Как починить на работающем сервере

Быстрый путь: **Админка → Авторизация → «Отправка писем» → «Диагностика» →
«Включить и применить»** у красной строки «Регистрация в GoTrue».

Вручную:

```bash
grep -n 'DISABLE_SIGNUP' /opt/supabase/.env          # рабочее имя — DISABLE_SIGNUP
sed -i 's/^DISABLE_SIGNUP=.*/DISABLE_SIGNUP=false/' /opt/supabase/.env
grep -q '^DISABLE_SIGNUP=' /opt/supabase/.env || echo 'DISABLE_SIGNUP=false' >> /opt/supabase/.env

cd /opt/supabase
# свой docker-compose.override.yml подключайте, только если он есть
docker compose -f docker-compose.yml -f docker-compose.smtp-override.yml \
  up -d --no-deps --force-recreate auth

# проверка не по логам, а по ответу GoTrue
docker exec supabase-auth wget -qO- http://127.0.0.1:9999/settings | grep -o '"disable_signup":[a-z]*'
```

Ожидаемый ответ — `"disable_signup":false`; после этого регистрация создаёт
пользователей, а письмо подтверждения приходит на адрес.

## Чего делать не нужно

* **Не включать `mailer_autoconfirm`.** Сайт намеренно отказывает при
  автоподтверждении: иначе адрес, указанный кем угодно, считался бы
  подтверждённым.
* **Не писать `GOTRUE_DISABLE_SIGNUP` в `.env` стека.** Такая строка молча
  игнорируется; её наличие теперь подсвечивается в панели и переименовывается
  при применении почты.
* **Не править `.env` без пересоздания `auth`.** Файл и контейнер — разные
  вещи: GoTrue читает окружение на старте.

## Проверки

* `scripts/tests/update-agent.test.mjs`: переименование ключа, падение задачи
  при `disable_signup=true`, подтверждение открытой регистрации, видимость
  `legacySignupKey` для панели.
* `scripts/tests/email-health.test.mjs`: подсказка называет `DISABLE_SIGNUP` и
  пересоздание `auth`, `action` приходит для чинимых проверок, кнопка в панели
  пишет именно `DISABLE_SIGNUP=false` и запускает `/smtp/apply`.
* `npm test` — набор сайта; `uploader` не затронут.
