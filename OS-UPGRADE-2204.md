# Обновление ОС сервера: Ubuntu 20.04 → 22.04

**Чек-лист для работающего `edringcolony.ru`.** Это обновление ОС, а не новая
установка: `deploy/selfhost/install.sh` и `upgrade.py` здесь не запускаются, они
про приложение и стек. Приложение живёт целиком в Docker, поэтому от возраста ОС
не зависит — риск не в коде проекта, а в четырёх вещах вокруг него (Docker,
второй диск, `systemd-oomd`, `nftables`). Ниже — что подготовить, что проверить
до, что делать в окне и что проверить после.

> 22.04 — промежуточная остановка, а не цель: обычная поддержка до 2027 года.
> Дальше по той же схеме можно до 24.04 (`SERVER-SETUP.md`, `SELFHOST.md`
> рекомендуют именно её), но одним прыжком через версию не ходим.

---

## 0. Что НЕ делать

| Не делать | Почему |
|---|---|
| `do-release-upgrade` на забитом диске | распаковка пакетов + старые ядра + 1–2 ГБ загрузки: обновление встанет на середине, а это худший сценарий |
| `deploy/selfhost/install.sh`, `full_schema.sql` | это установка с нуля; для работающего сервера — только `MONITORING.md` → «Обновить сейчас» и этот документ |
| `docker compose down -v` | флаг `-v` удаляет тома: база и файлы Storage |
| Нажимать «Обновить сейчас» / «Сделать бэкап» в админке во время окна | update-agent полезет в Docker и базу ровно тогда, когда их обновляет apt |
| `apt upgrade` всех пакетов непосредственно перед апгрейдом ОС | `do-release-upgrade` делает это сам; лишний прогон только добавляет неопределённости |

---

## 1. До начала: два условия

1. **Место на диске.** `do-release-upgrade` скачивает и распаковывает пакеты,
   старое ядро остаётся до первой уборки. Минимум — 3 ГБ свободных там, где
   лежит `/`:
   ```bash
   df -h /
   sudo bash deploy/docker-disk-report.sh   # если места мало — сначала разбор
   ```
2. **Снимок всей виртуальной машины у провайдера.** Это единственный настоящий
   откат: приложение откатывается образами Docker, ОС — только снапшотом.

Отдельно: **окно в 30–90 минут плюс перезагрузка**, работу в `tmux`, консоль
провайдера (KVM/VNC) открытой в браузере — SSH рвётся на середине почти всегда,
и без консоли остаёшься смотреть в мёртвое соединение.

---

## 2. Инвентарь: снять «как было»

Одна команда, складывает всё в `/root/pre-os-upgrade/` (доступ только root):

```bash
sudo bash -c 'mkdir -p /root/pre-os-upgrade && cd /root/pre-os-upgrade && chmod 700 . && {
  date
  docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"
  docker images --format "table {{.Repository}}:{{.Tag}}\t{{.Size}}"
  docker volume ls
  docker network ls
  docker version && docker compose version && docker buildx version
  findmnt -rno TARGET,SOURCE,FSTYPE
  df -h
  cat /etc/os-release
  apt-cache policy docker-ce docker.io docker-compose-plugin | head -20
  python3 --version
} > snapshot.txt 2>&1
tar czf etc.tgz /etc/nginx /etc/letsencrypt /etc/fstab /etc/docker /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null
tar czf env.tgz /opt/ed-ring-colony/src/.env.production /opt/ed-ring-colony/update-state 2>/dev/null
ls -la'
```

`env.tgz` содержит секреты: файл остаётся на сервере с правами 700, никуда не
пересылается и в чат не попадает.

Что именно важно сохранить и где это лежит:

| Что | Путь | Зачем |
|---|---|---|
| Дамп базы (`pg_dump -Fc` всей базы, включая схему `auth`) | `/opt/ed-ring-colony/backups/edrc-*.dump` | без `auth` не восстановить пользователей и входы |
| `.env` сайта | `/opt/ed-ring-colony/src/.env.production` | ключи Supabase, `CRON_SECRET`, токены агентов |
| `.env` стека Supabase | `/opt/supabase/.env` | JWT/anon/service_role, SMTP, ключи Storage |
| Compose-файлы | `/opt/ed-ring-colony/src/docker-compose.yml`, `/opt/supabase/docker-compose.yml` (+ override) | вернуть «как было», если apt что-то перепишет |
| nginx и сертификаты | `/etc/nginx`, `/etc/letsencrypt` | HTTPS и прокси на `127.0.0.1:8000` |
| Состояние обновлений | `/opt/ed-ring-colony/update-state/` | журнал, план, отметки миграций |
| Релизы Helper | `/opt/ed-ring-colony/backups/uploader-releases/` | история пакетов, к ОС не относится — просто не удалять |
| Дампы Spansh и каталог | `/mnt/sdb/ed-ring-colony/spansh` (`GALAXY_DATA_HOST_DIR`) | ~6 ГиБ на дамп, отдельный диск |

**Копия базы** делается из админки (**Админка → Бэкапы**) — это штатный путь,
скрипт `deploy/db-backup.sh` поднимает update-agent. Если нужно руками с хоста:

```bash
cd /opt/ed-ring-colony/src && sudo bash deploy/db-backup.sh
```

По умолчанию копия **без** `public.galaxy_systems` (десятки гигабайт, полностью
восстанавливается импортом дампа Spansh) — для обновления ОС этого достаточно.
`BACKUP_FULL=1` вернёт полную копию, но диск и время вырастут.

> Копию базы всё равно вывези с сервера (`scp`) до начала работ: снапшот VM
> может не понадобиться, но и он не заменяет бэкап за пределами машины.

---

## 3. Четыре места, где обновление ОС реально ломает

### 3.1. Docker перестанет получать обновления (главное)

Docker ставился через `get.docker.com` — это сторонний apt-репозиторий
`download.docker.com`. `do-release-upgrade` **отключает сторонние источники**,
чтобы не сломать систему пакетами от другой версии. Сам Docker продолжит
работать, но репозиторий останется помеченным под `focal` и обновлений не будет.

После апгрейда — проверить и вернуть:

```bash
docker version && docker compose version && docker buildx version
```

Нужны Docker **≥ 20.10** (cgroup v2), Compose **v2** и **buildx**. Без buildx
сборка идёт legacy-билдером, а кэш-маунты `RUN --mount=type=cache` в `Dockerfile`
требуют BuildKit — обновления станут медленнее (см. `MONITORING.md`, «Бюджет
кэш-маунтов»). Если репозиторий отключён, его возвращают заново по инструкции
Docker для `jammy` (`docs.docker.com/engine/install/ubuntu/`), затем:

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Каталог данных Docker (`docker info --format '{{.DockerRootDir}}'`, по умолчанию
`/var/lib/docker`) при переустановке **не** трогается — образы, тома и база
остаются на месте.

### 3.2. Второй диск `/mnt/sdb`

На нём дампы Spansh и часть копий. Если после смены ядра он не смонтируется,
данные уйдут на корневой диск — ровно та история про «сотни гигабайт под точкой
монтирования» (`DISK-LEAK-CONTAINER-CONFLICT-FIX.md` §3).

**До перезагрузки** проверить `/etc/fstab`: запись должна быть по `UUID=`, а не
по `/dev/sdb1` — имена устройств после апгрейда могут поменяться.

```bash
grep -n sdb /etc/fstab
sudo blkid | grep -i sdb     # сверить UUID
```

**После перезагрузки — до запуска стека:** `findmnt /mnt/sdb`. Пусто — сначала
монтировать, потом поднимать сайт, иначе импорт дампа и бэкапы запишут гигабайты
на корень.

### 3.3. `systemd-oomd` в Ubuntu 22.04

22.04 включает `systemd-oomd`: он убивает процессы при нехватке памяти. Сборка
Next.js хочет ~2 ГБ, и на 4 ГБ RAM это может выглядеть как «сборка падает без
причины» (`Killed`). Диагностика:

```bash
systemctl status systemd-oomd --no-pager
journalctl -u systemd-oomd --since '-1 day' --no-pager | tail -30
```

Если он убивает сборку — swap (`/swapfile` в `fstab` переживает апгрейд) и
`UPDATE_RUN_TESTS=0` в панели обновления; при необходимости политику `oomd`
ослабляют в `/etc/systemd/oomd.conf`, а не отключают вслепую.

### 3.4. `nftables`, `ufw` и `certbot`

22.04 переводит фильтрацию на `nftables`. Правила `ufw` (22/80/443, 8000 в
режиме IP) переезжают автоматически, а самодельные правила из `/etc/iptables/*`
могут перестать применяться — их надо проверить отдельно. Сертификаты
Let's Encrypt от ОС не зависят, но если `certbot` ставился снапом, после
апгрейда стоит прогнать проверку:

```bash
sudo certbot renew --dry-run
sudo nginx -t && systemctl reload nginx
```

---

## 4. Окно обновления

Порядок важен: сначала тишина в проекте, потом ОС.

```bash
# 1) tmux, чтобы сессия пережила обрыв SSH
tmux new -s osupgrade

# 2) остановить то, что пишет в базу и дёргает Docker
cd /opt/ed-ring-colony/src
docker compose --env-file .env.production -f docker-compose.yml --profile monitoring stop update-agent jobs monitor-agent
```

Сайт (`web`) и стек Supabase при этом продолжают работать.

```bash
# 3) страховка от «полуобновлённого» состояния
sudo apt-get update
command -v do-release-upgrade || sudo apt-get install -y update-manager-core
cat /etc/update-manager/release-upgrades       # ожидается Prompt=lts

# 4) само обновление (занимает 30–90 минут)
sudo do-release-upgrade
```

Что отвечать по ходу:

| Вопрос / экран | Ответ |
|---|---|
| «Continue running under SSH?» (предлагает дополнительный SSH-порт) | `y` — второй порт не помешает |
| Изменённые конфиги (`nginx.conf`, `sshd_config`) | «keep the local version» / `N` на замену: nginx настроен проектом |
| Сторонние репозитории (Docker) | можно оставить выключенными и вернуть вручную (§3.1) |
| Удаление устаревших пакетов | согласиться, но ядра оставить хотя бы одно прежнее |
| `Restart services without asking` | `y` |
| Перезагрузка в конце | согласиться |

Контейнеры с `restart: unless-stopped` поднимутся сами; остановленные на шаге 2
(`update-agent`, `jobs`, `monitor-agent`) — **нет**, их поднимаем руками.

---

## 5. После перезагрузки: проверка по порядку

```bash
# 1) ОС
cat /etc/os-release | head -3; uname -r

# 2) диски — ДО стека
findmnt /mnt/sdb || echo 'ВНИМАНИЕ: /mnt/sdb не смонтирован — не запускать стек'
df -h / /mnt/sdb

# 3) Docker и то, что вернулось само
docker version && docker compose version && docker buildx version
docker ps -a --format 'table {{.Names}}\t{{.Status}}'

# 4) стек сайта в полном составе
cd /opt/ed-ring-colony/src
docker compose --env-file .env.production -f docker-compose.yml --profile monitoring up -d web jobs monitor-agent

# 5) nginx и HTTPS
sudo nginx -t && sudo systemctl status nginx --no-pager
curl -sI https://edringcolony.ru | head -3

# 6) приложение
curl -s https://edringcolony.ru/api/health
```

Дальше — по одному пункту, каждый закрывает свой класс поломок:

| Проверка | Как | Если плохо |
|---|---|---|
| Вход существующим паролем | вручную в браузере | `auth` не поднялся: `docker logs supabase-auth`, `SIGNUP-DISABLED-FIX.md` |
| Realtime (WebSocket) | открыть чат/уведомления | `REALTIME-FIX.md` — там read-only диагностика |
| Storage | Админка → Мониторинг → «Хранилище файлов» → «Проверить» | `STORAGE-RESTART.md`, `sudo python3 deploy/selfhost/storage-check.py` |
| Фоновые задачи | Админка → Мониторинг → `jobs`, возраст `lastSuccess` | поднять `jobs`, `MONITORING.md` |
| Обновления Helper | Админка → Обновления Helper (версии и каналы на месте) | `HELPER-LAUNCHER-LINK.md` |
| Пробная пересборка | «Обновить сейчас» (без миграций), потом обычная | §3.1 (buildx) и §3.3 (`oomd`) |
| Диск и журналы | `sudo bash deploy/docker-disk-report.sh` | новый отчёт покажет, кто занял место |

---

## 6. Если что-то пошло не так

| Симптом | Что это скорее всего | Действие |
|---|---|---|
| Сайт 502, `web` в рестарте | не смонтирован `/mnt/sdb` или кончилось место | `findmnt`, `df -h`, `docker logs web` |
| `Cannot connect to the Docker daemon` | Docker не стартовал после смены ядра | `systemctl status docker`, `journalctl -u docker -n 100` |
| Контейнеры есть, но их нет в `docker ps` | они были остановлены до апгрейда | `up -d` из §5 |
| Сайт открывается без стилей/картинок | Storage или Kong | `STORAGE-RESTART.md` |
| Вход не работает у всех | `auth` потерял конфиг или `.env` стека | сверить `.env` с `env.tgz`, `docker compose up -d auth` |
| Обновление проекта падает на сборке | legacy-билдер (нет buildx) или `oomd` | §3.1, §3.3 |
| Всё сломалось непонятно как | — | снапшот VM, затем разбор (снапшот — единственный полный откат) |

Откат приложения после неудачной пересборки — **Админка → Обновления Helper** и
образы Docker (`docker images`), они остаются от прежней версии до очистки.
Том базы откат приложения не трогает, поэтому пользовательские данные после
бэкапа сохраняются — восстановление из дампа нужно только при порче самой БД.

---

## 7. Чего в этом документе нет

- Пошаговой инструкции на 24.04 — путь тот же, но `do-release-upgrade` пойдёт
  через 22.04; сначала закрыть этот этап и пожить на нём.
- Автоматизации: обновление ОС — операция с перезагрузкой и интерактивными
  вопросами, поэтому скрипта в репозитории нет намеренно.
- Проверок на реальном сервере: команды собраны по `deploy/selfhost/install.sh`,
  `deploy/*.sh` и `MONITORING.md`, но прогонялись не на боевой машине.
  Всё, что зависит от твоего железа (имя диска, версия Docker, наличие swap),
  сверяется пунктом 2 «Инвентарь».

Смежное: [MONITORING.md](MONITORING.md) (обновление проекта, диск, место),
[DISK-LEAK-CONTAINER-CONFLICT-FIX.md](DISK-LEAK-CONTAINER-CONFLICT-FIX.md)
(«место есть, а папок нет»), [SELFHOST.md](SELFHOST.md) (устройство стека),
[UBUNTU20-INSTALL.md](UBUNTU20-INSTALL.md) (как всё ставилось),
[REALTIME-FIX.md](REALTIME-FIX.md), [STORAGE-RESTART.md](STORAGE-RESTART.md).
