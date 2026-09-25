# Анализ изменений портов после коммита eec6ea3

Дата анализа: 2026-09-25 (HEAD = 9e024f0, 2026-09-25 00:24)
Цель: вернуть портовую конфигурацию к состоянию 24 часа назад (2026-09-24 00:24, коммит 195c75a)

## Исходное состояние — коммит eec6ea3 (2026-09-21 00:29)

eec6ea3 = Merge PR #13 "Self-hosted migration: Uploader, OAuth and server jobs"

На момент eec6ea3:
- `docker-compose.yml`: `web.ports = "127.0.0.1:3000:3000"` — жёстко зашит, только localhost, наружу отдаёт nginx
- `.env.example`: нет PORT_BIND, нет SYNOLOGY_SITE_BIND
- `deploy/compose-lib.sh`: простая логика — добавляет `-f deploy/compose.supabase-net.yml` если сеть Supabase существует, иначе ничего
- Нет файлов: `compose.synology.yml`, `configure-synology-ports.sh`, `ed-ring-colony-docker.service`, `start-docker.sh`, `SYNOLOGY.md`

Это базовая схема: сайт слушает 127.0.0.1:3000, nginx проксирует 443 → 127.0.0.1:3000.

## Промежуточный фикс — 195c75a (2026-09-24 00:23) — целевое состояние "24 часа назад"

Коммит: `fix(deploy): fix apply-env line 99 error by passing base docker-compose.yml with overrides`

Что изменилось по портам:
- Исправлена критичная ошибка: `apply-env.sh`, `start-monitoring.sh`, `update-project.sh` теперь ВСЕГДА передают `-f docker-compose.yml` + extra файлы. До этого при передаче только `compose.supabase-net.yml` как единственного файла, Compose считал его единственной конфигурацией и терял секцию `ports` (сайт переставал слушать).
- `compose-lib.sh`: добавлена проверка `docker network inspect` — если сеть Supabase не существует, extra файл не подключается, чтобы не падал `compose up`.
- Порты остались `127.0.0.1:3000:3000` — без параметризации.

Это состояние считается "24 часа назад" от HEAD (9e024f0 = 2026-09-25 00:24). Следующие коммиты уже после этого порога.

## Коммит 9920cf5 (2026-09-24 19:07) — параметризация портов

`fix(docker): восстановить конфигурацию портов и добавить скрипт старта deploy/start-docker.sh`

Изменения:
- `docker-compose.yml`: `ports` стал `"${PORT_BIND:-127.0.0.1:${PORT:-3000}:3000}"` — теперь можно переопределить через env `PORT_BIND`
- `.env.example`: добавлен комментарий `PORT_BIND=127.0.0.1:3000:3000`
- Добавлен `deploy/start-docker.sh` (201 строка): штатный запуск, `--restart` для восстановления портов, проверка health, передача метаданных ревизии, подключение Supabase сети через `compose-lib.sh`
- Добавлен `deploy/ed-ring-colony-docker.service`: systemd unit для автозапуска Docker-стека, вызывает `start-docker.sh`
- `deploy/selfhost/upgrade.py`: добавлена логика восстановления `ports` из шаблона, если в старом compose их нет
- `package.json`: добавлены скрипты `docker:start`, `docker:restart`, `docker:status`, `docker:stop`
- `DEPLOY.md`: добавлены разделы "Штатный запуск, перезапуск и восстановление портов" и "Автозапуск через systemd" и про `PORT_BIND`
- Тесты: `docker-compose.yml: порты параметризованы через PORT_BIND`, `ed-ring-colony-docker.service`, `start-docker.sh`

Цель коммита — решить проблему "слетели порты" когда контейнер пересоздаётся без `-p`.

## Коммит cd5b2ac (2026-09-24 23:30) — Synology Reverse Proxy

`fix(deploy): закрепить порты Synology для сайта и Supabase`

Изменения:
- `.env.example`: добавлен `SYNOLOGY_SITE_BIND=192.168.8.177:9000` + комментарии про :9000 и :9100
- `deploy/compose-lib.sh`: теперь возвращает ДВА extra файла: `-f compose.supabase-net.yml -f compose.synology.yml`, если задан `SYNOLOGY_SITE_BIND`
- Новый `deploy/compose.synology.yml`: добавляет вторую публикацию `${SYNOLOGY_SITE_BIND}:3000` — то есть сайт слушает одновременно `127.0.0.1:3000` (для health) и `LAN_IP:9000` (для Synology)
- Новый `deploy/configure-synology-ports.sh` (200 строк): безопасное переключение с откатом, проверяет Supabase на :9100, сохраняет бэкапы env и nginx, удаляет конфликтующий `listen 9000 ssl` из nginx, задаёт `PORT=3000`, `PORT_BIND=127.0.0.1:3000:3000`, `SYNOLOGY_SITE_BIND=LAN:9000`, пересоздаёт web через `start-docker.sh`
- Новый `SYNOLOGY.md` (118 строк): фиксирует схему `edringcolony.ru → Synology :443 → VM HTTP :9000 → web:3000`, `supabase → :9100`
- `DEPLOY.md` и `README.md`: добавлены упоминания Synology
- `package.json`: добавлен `docker:synology`
- Тест `synology-deploy.test.mjs`

Итоговая схема после cd5b2ac:
```
127.0.0.1:3000       → web:3000 (health)
192.168.8.177:9000   → web:3000 (Synology HTTP)
0.0.0.0:9100         → Supabase (Synology HTTP)
```

## Что было откачено к состоянию 24 часа назад (195c75a)

Целевое состояние = 195c75a (2026-09-24 00:23) — до 9920cf5 и cd5b2ac.

Выполненные действия:
1. `docker-compose.yml`: вернул `127.0.0.1:3000:3000` (было `${PORT_BIND:-...}`), сохранил `RUN_TESTS` arg из более позднего коммита 3dd2680 как не относящийся к портам
2. `.env.example`: удалил секции `PORT_BIND` и `SYNOLOGY_SITE_BIND`, сохранил `UPDATE_TIMEOUT_MINUTES` и `RUN_TESTS` (не портовые, но полезные)
3. `deploy/compose-lib.sh`: вернул простую версию без Synology — только `compose.supabase-net.yml`, логика проверки сети сохранена
4. Удалены файлы, которых не было 24 часа назад:
   - `deploy/compose.synology.yml`
   - `deploy/configure-synology-ports.sh`
   - `deploy/ed-ring-colony-docker.service`
   - `deploy/start-docker.sh`
   - `SYNOLOGY.md`
   - `scripts/tests/synology-deploy.test.mjs`
5. `package.json`: удалил `docker:start`, `docker:restart`, `docker:status`, `docker:stop`, `docker:synology`
6. `DEPLOY.md`: удалил разделы про `start-docker.sh`, `PORT_BIND`, Synology `:9000/:9100`, systemd docker service; оставил `rebuild-now.sh` (добавлен в 45dd570, не портовый)
7. `README.md`: удалил упоминание Synology
8. `scripts/tests/update-agent.test.mjs`: удалил тесты для PORT_BIND и start-docker.sh, заменил на проверку фиксированного порта `127.0.0.1:3000:3000` и отсутствия `PORT_BIND`/`SYNOLOGY_SITE_BIND`

Результат: портовая схема снова простая и предсказуемая:
- `web` слушает только `127.0.0.1:3000:3000`
- Нет дополнительной публикации `:9000`, нет зависимости от `SYNOLOGY_SITE_BIND`
- `compose-lib.sh` подключает только Supabase сеть
- Все compose-команды должны использовать `-f docker-compose.yml $EXTRA` (фикс из 195c75a сохранён)

Если позже понадобится Synology схема, её можно вернуть одной командой `bash deploy/configure-synology-ports.sh`, но сейчас она удалена по требованию отката.
