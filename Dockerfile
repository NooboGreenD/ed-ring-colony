# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — production image (Next.js standalone)
#
# Сборка:  docker build -t ed-ring-colony .
# Запуск:  docker run -p 3000:3000 --env-file .env.production ed-ring-colony
#
# NEXT_PUBLIC_* переменные вшиваются в клиентский бандл на этапе сборки,
# поэтому передаются как build-args. Серверные секреты (SERVICE_ROLE_KEY,
# CRON_SECRET и т.д.) передаются только при запуске через --env-file.
#
# RUN --mount=type=cache — постоянные кэши BuildKit (frontend dockerfile:1):
# закачки npm и .next/cache переживают ЛЮБУЮ пересборку, включая --no-cache
# (кэш-маунт не зависит от кэша слоёв). На медленном VPS это разница между
# «скачать полгигабайта пакетов» и «взять с диска».
# ─────────────────────────────────────────────────────────────────────

# ── 1. Установка зависимостей ────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# «New major version of npm available!» — уведомление САМОЙ npm (её версия
# зашита в базовый образ node:22-alpine, к проекту отношения не имеет).
# Гасим для всех npm-команд этапа, чтобы не мусорить журнал каждой сборки.
ENV npm_config_update_notifier=false
COPY package.json package-lock.json ./
# Кэш-маунт /root/.npm: пакеты берутся с локального диска, а не из сети —
# холодный npm ci перестаёт быть самой долгой частью пересборки.
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ── 2. Сборка ────────────────────────────────────────────────────────
# Next 16 по умолчанию собирает Turbopack'ом — на этом проекте он быстрее
# webpack-сборки вдвое и меньше ест RAM, что критично для малого VPS
# (2 vCPU / 4 ГБ). Если когда-нибудь понадобится старый бандлер — верните
# флаги `--webpack` в package.json.
# Наследуем слой с зависимостями вместо отдельного копирования node_modules:
# на HDD под нагрузкой это копирование может занять часы ещё до next build.
FROM deps AS builder
COPY . .

# Публичные переменные (безопасно вшивать в бандл)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
# Build-time only: next.config.mjs turns this private Kong URL into an
# external rewrite. It is deliberately not a NEXT_PUBLIC_* value.
ARG SUPABASE_INTERNAL_URL
# Deployment metadata is deliberately server-only. Pass it from the release
# command; it powers the protected operations dashboard and never reaches the
# browser bundle.
ARG APP_GIT_SHA=unknown
ARG APP_GIT_REF=unknown
ARG APP_BUILD_TIME=unknown
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY \
    SUPABASE_INTERNAL_URL=$SUPABASE_INTERNAL_URL \
    NEXT_TELEMETRY_DISABLED=1

# Former site CI checks now run during the server-side image build.
# Аргумент RUN_TESTS=0 (через --build-arg / .env: RUN_TESTS=0) пропускает
# тесты в экстренном случае — например, когда сборка уже упирается в
# таймаут апдейтера. По умолчанию проверки обязательны.
ARG RUN_TESTS=1
RUN if [ "$RUN_TESTS" = "1" ]; then npm test; else echo "RUN_TESTS=0 — тесты пропущены"; fi
# Отдельный слой: повторная сборка после падения самих тестов не пересчитывает
# тестовый слой, а падение сборки видно отдельно от падения проверок.
# Инкрементальный кэш Next.js (.next/cache) живёт между сборками: без маунта
# он оставался в выброшенном слое образа, и каждая пересборка компилировала
# проект с нуля. В рантайм-образ кэш не попадает (и не нужен).
RUN --mount=type=cache,target=/app/.next/cache npm run build

# ── 3. Рантайм ───────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ARG APP_GIT_SHA=unknown
ARG APP_GIT_REF=unknown
ARG APP_BUILD_TIME=unknown
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    APP_GIT_SHA=$APP_GIT_SHA \
    APP_GIT_REF=$APP_GIT_REF \
    APP_BUILD_TIME=$APP_BUILD_TIME

RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001 \
    && apk add --no-cache su-exec

# standalone-сервер + статика + public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Каталог предварительного скачивания дампа Spansh (~6 ГиБ). В docker-compose
# на него повешен именованный том galaxy-dump — файл переживает пересборку
# образа. Папка существует в образе, чтобы copy-up тома сохранил владельца
# nextjs (иначе контейнер не смог бы писать в том).
RUN mkdir -p /app/data/spansh /data/uploader \
    && chown nextjs:nodejs /app/data/spansh /data/uploader

# Именованный том старой установки мог быть создан root:root. Перед стартом
# приводим небольшой uploader-store к uid web-процесса, затем безвозвратно
# сбрасываем права. Это устраняет HTTP 500 при генерации
# ключа/первой публикации из админки.
COPY --chown=root:root deploy/web-entrypoint.sh /usr/local/bin/web-entrypoint
RUN chmod 0755 /usr/local/bin/web-entrypoint

EXPOSE 3000
ENTRYPOINT ["web-entrypoint"]
CMD ["node", "server.js"]
