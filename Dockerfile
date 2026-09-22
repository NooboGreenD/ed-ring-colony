# ─────────────────────────────────────────────────────────────────────
# ED Ring Colony — production image (Next.js standalone)
#
# Сборка:  docker build -t ed-ring-colony .
# Запуск:  docker run -p 3000:3000 --env-file .env.production ed-ring-colony
#
# NEXT_PUBLIC_* переменные вшиваются в клиентский бандл на этапе сборки,
# поэтому передаются как build-args. Серверные секреты (SERVICE_ROLE_KEY,
# CRON_SECRET и т.д.) передаются только при запуске через --env-file.
# ─────────────────────────────────────────────────────────────────────

# ── 1. Установка зависимостей ────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── 2. Сборка ────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Публичные переменные (безопасно вшивать в бандл)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY
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
    NEXT_TELEMETRY_DISABLED=1

# Former site CI checks now run during the server-side image build.
RUN npm test && npm run build

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

RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001

# standalone-сервер + статика + public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
