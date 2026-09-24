# ED Ring Colony за Synology Reverse Proxy

Эта инструкция фиксирует production-схему, где Synology завершает публичный
HTTPS, а виртуальная машина `192.168.8.177` предоставляет два независимых HTTP
backend:

```text
https://edringcolony.ru
  → Synology Reverse Proxy :443
  → http://192.168.8.177:9000
  → Docker web :3000

https://supabase.edringcolony.ru
  → Synology Reverse Proxy :443
  → http://192.168.8.177:9100
  → Supabase API gateway
```

Одинаковый публичный IP у двух доменов нормален: Synology выбирает правило по
SNI/`Host`. Для обоих назначений используется **HTTP**, потому что TLS уже
завершён на Synology.

## Однократная настройка VM

После обновления репозитория выполните из его корня одну команду:

```bash
bash deploy/configure-synology-ports.sh
```

Скрипт сам определит LAN IP маршрута по умолчанию. Для нестандартного адреса:

```bash
SITE_BIND_IP=192.168.8.177 bash deploy/configure-synology-ports.sh
```

Он выполняет переключение с автоматическим откатом при ошибке:

1. проверяет, что Supabase отвечает по HTTP на `127.0.0.1:9100`;
2. сохраняет резервные копии `.env.production` и nginx-конфига;
3. оставляет `127.0.0.1:3000:3000` для локальных проверок;
4. задаёт `SYNOLOGY_SITE_BIND=LAN_IP:9000` и подключает
   `deploy/compose.synology.yml`;
5. удаляет только конфликтующие `listen 9000 ...` из nginx на VM — его
   listener `443` и `proxy_pass` не затрагиваются;
6. пересоздаёт web штатным `deploy/start-docker.sh` и проверяет оба backend.

Ожидаемые слушатели после настройки:

```text
127.0.0.1:3000       docker-proxy → web:3000 (локальный health-check)
192.168.8.177:9000   docker-proxy → web:3000 (Synology, HTTP)
0.0.0.0:9100         docker-proxy → Supabase (Synology, HTTP)
```

Проверка на VM:

```bash
curl -i http://192.168.8.177:9000/api/health
curl -i http://192.168.8.177:9100/auth/v1/health
```

Первый запрос должен вернуть:

```json
{"ok":true,"service":"ed-ring-colony"}
```

## Правила Synology

### Основной сайт

```text
Источник:    HTTPS, edringcolony.ru, 443
Назначение:  HTTP,  192.168.8.177, 9000
Host:        edringcolony.ru
```

### Supabase

```text
Источник:    HTTPS, supabase.edringcolony.ru, 443
Назначение:  HTTP,  192.168.8.177, 9100
Host:        supabase.edringcolony.ru
WebSocket:   включён (Upgrade / Connection)
```

Сертификат Synology должен включать оба имени и быть назначен обоим правилам.
Порты `9000` и `9100` не нужно пробрасывать с WAN напрямую: к ним обращается
Synology внутри LAN.

## Как не потерять публикацию при следующем обновлении

Не запускайте для этого стека голую команду `docker compose up`: она не знает
об optional override для Synology. Используйте штатные точки входа — все они
подключают один набор override-файлов через `deploy/compose-lib.sh`:

```bash
bash deploy/start-docker.sh
bash deploy/start-docker.sh --restart
bash deploy/rebuild-now.sh
bash deploy/start-monitoring.sh
```

Обновление из админки использует тот же helper. Постоянные значения в
`.env.production` должны оставаться такими:

```dotenv
PORT=3000
PORT_BIND=127.0.0.1:3000:3000
SYNOLOGY_SITE_BIND=192.168.8.177:9000
```

`PORT=9000` задавать нельзя: это внутренний порт процесса Next.js, а не порт
публикации хоста. Установка `PORT=9000` рассинхронизирует контейнер и mapping.

При аварийном завершении настроечный скрипт восстанавливает конфигурацию сам.
Пути оставленных резервных копий он печатает перед переключением.
