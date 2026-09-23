# Ubuntu 20.04: безопасное обновление работающего сервера

**21 сентября 2026.** Сайт `https://edringcolony.ru`, Supabase
`https://supabase.edringcolony.ru`. Это обновление, **не новая установка**.
Код подготовлен и проверен локально; доступа к вашему SSH/Docker здесь нет.

## 1. Исходники из GitHub и команда для терминала сервера

Разработка ведётся в рабочей ветке **`arena/01a0c073-ed-ring-colony`** через PR.
Архив из чата больше не нужен: исходники скачиваются непосредственно из GitHub.
**Пока PR проверяется, не применяйте обновление на production.** Сам PR не
обновляет сервер, не меняет main и не отключает действующие расписания.

После проверки PR и подготовки к обновлению выполните блок в обычном
SSH-терминале Ubuntu 20.04. Нужны уже работающий Docker, **Compose 2.20+**,
`curl`, `tar`, Python **3.8+** и `sudo`. Node на хост ставить не нужно.
Не запускайте `install.sh`, `full_schema.sql`, `docker compose down -v`.

Команда закреплена за ревизией `97507eb2e0de1a13aff0e44d88ce8cf25b595ec0`.
Путь release содержит этот SHA; дальнейшие коммиты PR не изменяют уже
скачанный каталог. Перед production обновите ревизию после итоговой приёмки PR.

```bash
bash <<'EDRC_UPDATE'
set -euo pipefail
REV=97507eb2e0de1a13aff0e44d88ce8cf25b595ec0
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] || { echo 'Не удалось определить ревизию'; exit 1; }
RELEASE="/opt/ed-ring-colony-releases/$REV"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf 'Ревизия: %s\n' "$REV"
sudo -v
if ! sudo test -f "$RELEASE/.source-$REV-complete"; then
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    "https://github.com/NooboGreenD/ed-ring-colony/archive/$REV.tar.gz" \
    --output "$TMP/source.tar.gz"
  sudo install -d -m 755 "$RELEASE"
  sudo tar --extract --gzip --file "$TMP/source.tar.gz" \
    --directory "$RELEASE" --strip-components=1 --no-same-owner --no-same-permissions
  sudo touch "$RELEASE/.source-$REV-complete"
fi
sudo python3 "$RELEASE/deploy/selfhost/upgrade.py" plan
sudo python3 "$RELEASE/deploy/selfhost/upgrade.py" apply </dev/tty
EDRC_UPDATE
```

`plan` ничего не меняет. `apply` попросит ввести **edringcolony.ru** и, если
нужно, SMTP-настройки **локально в терминале**. Пароль SMTP вводится без эха.
В чат секреты, `docker inspect`, полный `docker compose config`, `.env` и backup
присылать не надо. `/dev/tty` в команде нужен для интерактивного ввода из heredoc.

### Что именно делает скрипт

- Находит существующие контейнеры и их **настоящие** project name, Compose-файлы
  и env; не создаёт второй Supabase и не заменяет JWT/anon/service_role ключи.
- Проверяет, что файлы не расходятся с работающими секретами, оценивает свободный
  диск: запас для backup плюс 4 GiB для сборки. Параллельные обновления блокируются.
- Сохраняет конфигурации с правами `0600`, теги прежних образов, Postgres dump
  **включая `auth`**, роли PostgreSQL и файлы Storage. Storage ненадолго
  останавливается на время согласованного снимка, затем запускается даже при ошибке
  backup. `pg_restore --list` проверяет читаемость архива — это **не полный restore-тест**.
- Собирает `web` с Node-тестами и production build, отдельно собирает `jobs`.
  До успешной сборки работающий сайт не заменяется.
- Сохраняет порты, сети, посторонние сервисы и существующий state volume jobs.
  Пересоздаёт только `web` и Supabase `auth`, проверяет health и публичный HTTPS.
- Включает подтверждение почты, безопасные шаблоны и manual identity linking.
  Существующие UUID, пароли, досье, эскадрильи и история не переустанавливаются.
- Убирает только известные фоновые вызовы из `/etc/cron.d/ed-ring-colony`.
  Плановых бэкапов в cron больше нет — копия базы делается вручную из
  **Админка → Бэкапы** (см. MONITORING.md), поэтому ночной `pg_dump` из старого
  cron-файла можно удалять вместе с остальными строками. Чужие/нестандартные
  расписания не удаляет, а останавливает обновление для проверки оператором.
- **Не запускает jobs автоматически**, пока старые Actions ещё активны.

Ожидается стандартная схема: **два Compose-проекта**, сервисы `web` и
`auth`/`db`/`storage`, локальный Docker socket, Storage — обычный bind mount.
Единый нестандартный стек, remote Docker и неожиданные тома скрипт не переделывает
наугад. Для них ниже есть ручной путь. S3 backup/versioning настраивается у
провайдера; локальный tar не подменяет копию внешнего bucket.

Если не найден единственный контейнер, посмотрите **только имена**:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
# Повторите plan/apply из каталога release с фактическими именами:
# .../upgrade.py plan --web-container ИМЯ_WEB --auth-container ИМЯ_AUTH
# Дополнительно доступны --site-env /путь/.env.production --supabase-env /путь/.env
```

### Почта

Существующая реальная SMTP-конфигурация сохраняется. `supabase-mail`/Inbucket,
пустые настройки и демонстрационные пароли не считаются рабочим SMTP.
Проверочный запрос отправляет **восстановление на адрес вашего существующего
аккаунта**; само письмо/его открытие пароль не меняют. Доставку нужно проверить
в почтовом ящике, включая спам. HTTP 200 от GoTrue не доказывает доставку.

Без SMTP или при пропуске проверки:

- прежний email/password-вход и существующие OAuth-аккаунты продолжают работать;
- `AUTH_EMAIL_ENABLED=false`, `GOTRUE_DISABLE_SIGNUP=true`: **новые регистрации,
  в том числе новые OAuth-аккаунты, закрыты**;
- нельзя «починить» это автоподтверждением адресов. Настройте SMTP.

Позже настроить/исправить SMTP **без пересборки**:

```bash
sudo python3 /var/lib/ed-ring-colony/upgrade.py configure-auth --edit-smtp
```

Для домена отправителя нужны корректные SPF/DKIM/DMARC у почтового провайдера.
После ошибки лимита GoTrue повторите тест позднее; не переключайте autoconfirm.

## 2. Discord и дополнительные способы входа

У провайдера callback всегда:

```text
https://supabase.edringcolony.ru/auth/v1/callback
```

Это **не** `edringcolony.ru/api/auth/callback` — последний является callback сайта.
Скрипт сохраняет настроенные ключи и исправляет адрес GoTrue. Портал Discord /
Google / GitHub менять без владельца приложения нельзя.

Если Discord ещё не настроен, создайте/откройте приложение в Discord Developer
Portal, внесите callback выше, затем в терминале:

```bash
sudo python3 /var/lib/ed-ring-colony/upgrade.py configure-auth --provider discord
# По желанию, после настройки соответствующих OAuth-приложений:
# sudo python3 /var/lib/ed-ring-colony/upgrade.py configure-auth --provider google --provider github
```

Client ID / Client Secret вводятся локально. **GitHub PAT и пароль аккаунта
не нужны и не принимаются**. Флаги/секреты попадают именно в GoTrue `auth`,
список кнопок — в `web`. При ошибке проверки настройки возвращаются, код и БД
не откатываются. Проверка UI: email-вход → привязать Discord → выйти → Discord
вход должен открыть **тот же UUID**. Проверьте CMDR, эскадрилью, досье и доставки.

## 3. Передача расписания с GitHub на сервер

Делайте это **после успешного apply**, не оставляйте переключение незавершённым.
Новая защита HTTP задач уже требует корректный `CRON_SECRET`.

Отключить эти шесть workflows и дождаться/отменить их активные запуски:

- [Auto Translate](https://github.com/NooboGreenD/ed-ring-colony/actions/workflows/auto-translate.yml)
- [CAPI Sync](https://github.com/NooboGreenD/ed-ring-colony/actions/workflows/cron-capi-sync.yml)
- [CG Check](https://github.com/NooboGreenD/ed-ring-colony/actions/workflows/cron-cg-check.yml)
- [EDDN Cleanup](https://github.com/NooboGreenD/ed-ring-colony/actions/workflows/cron-eddn-cleanup.yml)
- [Galnet Sync](https://github.com/NooboGreenD/ed-ring-colony/actions/workflows/galnet-sync.yml)
- [Update progress](https://github.com/NooboGreenD/ed-ring-colony/actions/workflows/update-progress.yml)

**Build Colonial Helper EXE оставить включённым.** После успешного `apply` можно сообщить агенту «сервер готов к переключению» —
он отключит эти workflows без передачи токенов в чат. Альтернатива — отключить
их через интерфейс GitHub самостоятельно. Сейчас удаление YAML в рабочей ветке ещё не отключает default-branch
расписания. Скрипт проверяет не только состояние workflows, но и незавершённые runs.

Убедитесь, что нет второго site scheduler в crontab/systemd/PM2, затем:

```bash
sudo python3 /var/lib/ed-ring-colony/upgrade.py activate-jobs --confirm-no-other-schedulers
sudo python3 /var/lib/ed-ring-colony/upgrade.py status
sudo python3 /var/lib/ed-ring-colony/upgrade.py logs
```

При недоступном GitHub API возможен **только после отдельной ручной проверки**
флаг `--confirm-github-schedulers-stopped`. Если API доступен и видит активные
задачи, флаг не обходит запрет. Первый запуск jobs выполняет один догон каждой
включённой задачи; это реальные записи в БД и возможный расход квоты переводчика.
Расписание, лимиты и поля `lastSuccess` описаны в [POST-MIGRATION.md](POST-MIGRATION.md).
`--list` проверяет конфигурацию, а не успешность выполнения фоновых заданий.

## 4. Управление и откат

Текущий план хранится в закрытом `/var/lib/ed-ring-colony/current.json`.
Конфигурации и архивы — в `/var/lib/ed-ring-colony/backups/<дата>/`.
Скрипт сохраняет выбранный Compose project name и оригинальный project directory.

**После такого обновления не запускайте обычный `docker compose up --build` из
старого каталога:** он вернёт прежнюю конфигурацию. Используйте управляющий скрипт.
Старый каталог, каталоги release и state volume пока не удаляйте. Новый apply
из следующего release определит текущие конфиги по Docker labels.

```bash
sudo python3 /var/lib/ed-ring-colony/upgrade.py status
sudo python3 /var/lib/ed-ring-colony/upgrade.py logs
# В случае проблемы — интерактивное подтверждение ROLLBACK:
sudo python3 /var/lib/ed-ring-colony/upgrade.py rollback
```

Откат остановит jobs и вернёт прежние образы web/auth. **Живую БД он не
восстанавливает из дампа**: пользовательские изменения после backup сохраняются.
Расписание не включается автоматически: выберите ровно один прежний источник.
Откат возвращает также прежние уязвимости/поведение регистрации — это временная
аварийная мера, а не безопасная постоянная конфигурация.

## 5. Приёмка и ограничения

При ошибке `WebSocket connection failed` начните с [REALTIME-FIX.md](REALTIME-FIX.md):
там отдельная read-only диагностика и настройка Upgrade. Полное обновление
стека или переустановка БД для диагностики Realtime не требуются.


- Сначала проверьте обычный вход существующим паролем. Никакого массового сброса
  или повторного подтверждения старых пользователей скрипт не делает.
- Новый email: регистрация → письмо → явная кнопка подтверждения → аккаунт.
  `token_hash` в новых письмах находится **после `#`**, поэтому не попадает в HTTP
  access logs. На GET одноразовая ссылка не расходуется; URL убирается из истории.
- Восстановление: письмо → подтверждение → новый пароль за 10 минут → новый вход.
  Отзываются refresh-сеансы и API-токены Uploader. Уже выданный access JWT может
  жить до своего `exp`. Привязанные OAuth-методы сохраняются: при подозрении на
  взлом отдельно проверьте/отвяжите чужие методы.
- Старые аккаунты, созданные через прежнее автоподтверждение email, не становятся
  ретроспективно проверенными. Нужна адресная проверка спорных аккаунтов, не
  массовое удаление UUID/паролей. Почтовые ссылки старого формата отправьте заново.
- Проверка `/api/health` — liveness Node, **не** доказательство здоровья БД/SMTP.
  Следите за jobs logs, возрастом `lastSuccess`, диском, TLS и расходами API.
- Web должен быть за доверенным reverse proxy, который перезаписывает X-Real-IP /
  корректно формирует X-Forwarded-For; порт приложения не открывайте в Интернет.
  Лимиты формы локальны процессу; при масштабировании нужен общий rate limiter.
- Сохраните backup за пределами этого сервера и проверьте настоящее восстановление.
  Автоматическое удаление архивов не добавлено: контролируйте место и ротацию.
- Ubuntu 20.04 вне обычной поддержки: включите Ubuntu Pro/ESM либо планируйте
  обновление ОС. Этот скрипт намеренно не обновляет ОС, Docker, PostgreSQL и GoTrue.

Проверено в среде разработки: production build Next 16, Node/Python-тесты и
браузерные сценарии Chromium/WebGL2. **Реальный Docker, ваш SMTP и OAuth-консоли
из этой среды недоступны**; проверки Compose/interpolation/health выполняются
скриптом на сервере **до запуска jobs**. Не считать тесты с mock Supabase
проверкой реальных провайдеров.

Для нестандартного Compose-стека используйте ручные этапы из
[POST-MIGRATION.md](POST-MIGRATION.md): backup → сборка → настройка auth →
проверка входа → остановка старых расписаний → jobs. Существующие `-p`, `-f`,
`--env-file`, сети, тома и TLS сохраняйте; полного SQL install не требуется.
