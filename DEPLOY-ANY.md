# Установка на любой сервер за 15 минут

Одна команда ставит **весь проект**: сайт Next.js, базу Postgres, авторизацию,
realtime, хранилище файлов, фоновые задачи, мониторинг и раздачу Colonial Helper.
Подходит любой VPS с чистым **Ubuntu 20.04/22.04/24.04 или Debian 11/12** и
root-доступом: имя хостинга, домен, порт сайта, каталог установки и диск под
дампы задаются флагами, а не зашиты в скрипты.

> Уже работающий `edringcolony.ru` **не переустанавливайте** — он обновляется
> кнопкой «Обновить сейчас» в Админка → Мониторинг ([MONITORING.md](MONITORING.md)).
> Этот документ — для нового сервера.

---

## 1. Что нужно до запуска

| Что | Сколько | Зачем |
|---|---|---|
| Сервер | 4 ГБ RAM, 2 vCPU, 40 ГБ SSD (рекомендуется 8 ГБ / 80 ГБ) | Supabase-стек ~2 ГБ + сборка сайта ~2 ГБ |
| ОС | Ubuntu 20.04/22.04/24.04, Debian 11/12 | apt, nginx, ufw, certbot — на них рассчитан установщик |
| Доступ | root (или `sudo`) по SSH | установка ставит пакеты, Docker и nginx |
| Порты | 22, 80, 443 свободны и открыты у хостинга | 80 — проверка домена и редирект, 443 — HTTPS |
| DNS (если с доменом) | A-запись `домен` → IP сервера **и** `supabase.домен` → IP | без второй записи не работают Realtime, Storage и вход через OAuth |
| Интернет | github.com, get.docker.com, Docker Hub, registry-1.docker.io | исходники, Docker, образы Supabase |

Сервер с 2 ГБ RAM «всё в одном» не потянет — тогда база ставится отдельно
([SERVER-SETUP.md](SERVER-SETUP.md)).

## 2. Одна команда

```bash
# с доменом и HTTPS (рекомендуется)
sudo bash deploy/selfhost/install.sh --domain ring.example.com --email you@mail.com

# голый статический IP, без HTTPS
sudo bash deploy/selfhost/install.sh --ip 203.0.113.10
```

Запускать из корня репозитория или распакованного архива:

```bash
git clone https://github.com/NooboGreenD/ed-ring-colony.git
cd ed-ring-colony
sudo bash deploy/selfhost/install.sh --domain ring.example.com --email you@mail.com
```

Скрипт идемпотентен: повторный запуск продолжает с недоделанного шага и
**не пересоздаёт секреты**. Если что-то пошло не так — исправьте и запустите ту
же команду снова.

## 3. Флаги

| Флаг | По умолчанию | Когда нужен |
|---|---|---|
| `--domain ДОМЕН` | — | сайт на домене + `supabase.ДОМЕН`, HTTPS через certbot |
| `--ip АДРЕС` | — | без домена: сайт на `http://АДРЕС`, Supabase на `:8000` |
| `--email EMAIL` | — | обязателен с `--domain`: Let's Encrypt |
| `--no-certbot` | выкл. | домен есть, но сертификат выпустите позже вручную |
| `--root КАТАЛОГ` | `/opt/ed-ring-colony` | проект ставится в другое место (`/srv/…`, отдельный диск) |
| `--web-port ПОРТ` | `3000` | 3000 занят другим приложением на этом сервере |
| `--galaxy-dir ПУТЬ` | `КАТАЛОГ/data/spansh` | дампы Spansh (~10 ГиБ) на отдельный диск |
| `--supabase-ref REF` | закреплённая метка | нужна другая версия стека Supabase (`master` — самая свежая) |
| `--no-monitor` | мониторинг включён | не нужны Админка → Мониторинг и агент обновлений |
| `--no-ufw` | ufw настраивается | файрволом управляет хостинг или другой инструмент |
| `--no-cron` | каталог копий создаётся | не нужен каталог резервных копий |
| `--force` | выкл. | продолжить при предупреждениях проверки (неподдерживаемая ОС, мало RAM/диска, занятый порт) |

Пример «всё на отдельном диске»:

```bash
sudo bash deploy/selfhost/install.sh --domain ring.example.com --email you@mail.com \
  --root /srv/edrc --web-port 8080 --galaxy-dir /mnt/data/spansh
```

## 4. Что делает установщик

| Шаг | Действие |
|---|---|
| 0 | **Проверка сервера**: ОС, RAM, свободное место, занятые порты, DNS домена. Ничего не меняет; при проблеме останавливается с объяснением (или продолжает с `--force`) |
| 1 | Пакеты (`curl`, `nginx`, `openssl`, `rsync`, `cron`), ufw (22/80/443), swap 2 ГБ (с запасным путём для btrfs/ZFS) |
| 2 | Docker Engine и плагин compose |
| 3 | Исходники в `КАТАЛОГ/src` (rsync без `.env`, `node_modules`, `.next`) |
| 4 | Секреты: пароль Postgres, JWT-ключи, anon/service_role, `CRON_SECRET`, токены мониторинга и обновления → `КАТАЛОГ/credentials.txt` (0600) |
| 5 | Стек Supabase закреплённой версии в `/opt/supabase`, `.env` стека, лимит Storage 70 МиБ |
| 6 | Схема БД: `supabase/full_schema.sql` (+ индекс доставки), проверка «таблиц ≥ 50» |
| 7 | nginx: сайт → `127.0.0.1:ПОРТ`, `supabase.ДОМЕН` → Kong, длинные таймауты для поиска кольца и карты |
| 7a | HTTPS (certbot) — **неудача не обрывает установку**: сайт остаётся на http, команда повторного выпуска печатается |
| 8 | `.env.production` (все адреса и ключи), сборка образов по одному, запуск `web`, `jobs`, агентов |
| 9 | Каталог резервных копий и релизов Helper |
| 9a | Смоук-тест (§5) прямо в конце установки |
| 10 | Сводка: адреса, каталоги, где лежат секреты и как проверять |

Несекретные параметры установки записываются в `КАТАЛОГ/install-info.txt`
(режим, адрес, порт, версия стека, каталоги) — по ним ориентируются повторные
запуски и смоук-тест.

## 5. Проверка

Установщик запускает проверку сам, но её можно (и полезно) запускать отдельно —
после переезда, обновления или «сайт не открывается»:

```bash
sudo bash deploy/selfhost/smoke-test.sh --root /opt/ed-ring-colony
```

Проверяются: контейнеры `web`, `jobs`, `monitor-agent`, `update-agent`;
`db`/`auth`/`rest`/`storage`; ответ `/api/health` напрямую и через nginx;
`pg_isready` и число таблиц в `public`; шлюз Kong (`/auth/v1/health`,
`/storage/v1/version`); **запись в `/app/data/spansh` и `/data/uploader` от имени
пользователя сайта (uid 1001)**; свободное место; состояние фоновых задач.

Итог: `Итого: ✓ N · ✗ M · предупреждений K`, код возврата 1 при ошибках.
Предупреждение — не поломка: например, `monitor-agent` мог быть выключен
(`--no-monitor`) или каталог дампов ещё пуст.

Руками:

```bash
curl -I https://ring.example.com                  # сайт
curl -s http://127.0.0.1:3000/api/health          # приложение (порт — ваш)
docker compose -f /opt/supabase/docker-compose.yml ps
```

## 6. После установки (по порядку)

1. **Первый администратор.** Регистрация на новом стенде закрыта
   (`DISABLE_SIGNUP=true`), поэтому пользователь создаётся в Supabase Studio
   (логин `admin`, пароль в `credentials.txt`): *Authentication → Users →
   Add user* с подтверждённым e-mail. Studio открывается так:
   - режим `--ip` — `http://IP:8000` (порт открыт в ufw);
   - режим `--domain` — Kong слушает только `127.0.0.1:8000`, поэтому
     SSH-туннель: `ssh -L 8000:127.0.0.1:8000 root@ДОМЕН`, затем
     `http://127.0.0.1:8000` в браузере (наружу Studio намеренно закрыта:
     nginx отдаёт по сабдомену только API).

   Профиль создастся сам, останется выдать права:

   ```sql
   UPDATE public.profiles SET role = 'admin' WHERE email = 'you@example.com';
   ```

   Тот же SQL можно выполнить в Studio → SQL Editor или
   `docker exec -it supabase-db psql -U postgres -d postgres`.

2. **Почта.** Админка → «Авторизация» → SMTP (или `deploy/apply-smtp.sh`).
   Без SMTP не уходят подтверждения регистрации и восстановление пароля;
   включать `ENABLE_EMAIL_AUTOCONFIRM` не нужно и не следует.

3. **Мониторинг.** Админка → Мониторинг: состояние сервисов, обновление
   проекта, миграции, бэкапы ([MONITORING.md](MONITORING.md)). Ключи уже в
   `credentials.txt`, вкладка должна открываться сразу.

4. **Frontier CAPI** (данные пилота): свой Client ID — в
   `user.frontierstore.net/developer`, Redirect URI —
   `https://ДОМЕН/api/capi/callback`.

5. **Каталог систем (/atlas).** Первый импорт Spansh — вручную из админки
   (полный дамп ~6 ГиБ); дальше ночная дельта. Подробности и требования к
   диску: [SPANSH-IMPORT.md](SPANSH-IMPORT.md).

6. **Colonial Helper.** Первая сборка/публикация — Админка → Обновления Helper
   (собирается на сервере, GitHub Actions не нужны):
   [UPLOADER-UPDATE-STRUCTURE.md](UPLOADER-UPDATE-STRUCTURE.md).

7. **Резервные копии.** Админка → Бэкапы, раз в неделю вручную (на время дампа
   сайт показывает заглушку). Скопируйте `credentials.txt` в надёжное место:
   без него не восстановить ни базу, ни вход.

## 7. Если что-то не так

| Симптом | Причина и что делать |
|---|---|
| `✗ ОС … не проверялась` | не Debian/Ubuntu. Для AlmaLinux/Rocky замените в скрипте apt→dnf, ufw→firewalld или разверните проект в Docker отдельно; `--force` не починит пакеты |
| `порт 3000 уже занят` | на сервере другое приложение: `--web-port 8080` (порт сайта на хосте; внутри контейнера остаётся 3000) |
| `RAM … МБ` / сборка падает с OOM | меньше 4 ГБ: добавьте swap или возьмите сервер побольше; база отдельно — [SERVER-SETUP.md](SERVER-SETUP.md) |
| HTTPS не выпустился | A-записи `домен` и `supabase.домен` ещё не указывают на сервер либо закрыт 80. Проверьте: `dig +short домен`. Потом: `certbot --nginx -d домен -d supabase.домен` |
| Сайт открывается, но «не загружаются картинки» | упал Storage: `docker logs supabase-storage`, Админка → Мониторинг → «Хранилище файлов», [STORAGE-RESTART.md](STORAGE-RESTART.md) |
| Дамп Spansh не скачивается, `permission denied` | каталог дампов не принадлежит uid 1001 (часто после монтирования нового диска): `sudo chown -R 1001:1001 /путь/к/spansh` |
| Облако точек карты не загружается, 413 | глобальный лимит Storage остался 50 МиБ: `sudo bash deploy/selfhost/fix-storage-limit.sh` (проверить заранее — с `--check`). Скрипт подставляет `${FILE_SIZE_LIMIT:-52428800}` в compose стека, ставит `FILE_SIZE_LIMIT=73400320` в его `.env` и пересоздаёт только `storage` |
| `supabase default network …` / `getaddrinfo EAI_AGAIN db` | сайт потерял сеть Supabase: `bash deploy/diag-after-update.sh` подскажет, что именно |
| Хочу сменить домен или порт после установки | домен: правьте `NEXT_PUBLIC_SITE_URL` в `КАТАЛОГ/src/.env.production`, конфиг nginx и `.env` стека Supabase → пересоберите `web`. Порт: `WEB_HOST_PORT` там же + `proxy_pass` в nginx → `docker compose up -d web`. Секреты при этом не меняются |
| Нужен только сайт, база — облачная | `SERVER-SETUP.md`: тот же `Dockerfile`, Supabase Cloud, без локального стека |

Диагностика одной командой (ничего не меняет):

```bash
bash deploy/diag-after-update.sh      # сеть Supabase, PostgREST, сайт
bash deploy/docker-disk-report.sh     # куда уходит диск
bash deploy/diag-cookies.sh           # 400/431 из-за больших cookie
```

## 8. Смежные документы

- [SELFHOST.md](SELFHOST.md) — как всё устроено внутри, ручные шаги без установщика;
- [UBUNTU20-INSTALL.md](UBUNTU20-INSTALL.md) — то же пошагово для Ubuntu 20.04 с переносом архивом;
- [SERVER-SETUP.md](SERVER-SETUP.md) — сайт на сервере, база в облаке;
- [MONITORING.md](MONITORING.md) — эксплуатация: обновления, миграции, бэкапы, ключи;
- [SPANSH-IMPORT.md](SPANSH-IMPORT.md), [POST-MIGRATION.md](POST-MIGRATION.md), [.env.example](.env.example).
