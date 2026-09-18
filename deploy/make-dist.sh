#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Сборка дистрибутива для переноса на сервер БЕЗ git/интернета.
#
# Использование (из корня репозитория):
#   ./deploy/make-dist.sh [имя-архива.tar.gz]
#
# По умолчанию создаёт ./ed-ring-colony-dist.tar.gz — самодостаточный
# архив: исходники сайта, Dockerfile/compose, все SQL (full_schema.sql),
# конфиги nginx/systemd/cron и инструкции (UBUNTU20-INSTALL.md и др.).
# node_modules и артефакты сборки не включаются — сборка идёт на сервере
# внутри Docker.
#
# На сервере:
#   scp ed-ring-colony-dist.tar.gz deploy@ВАШ_IP:/tmp/
#   sudo mkdir -p /opt/ed-ring-colony && sudo chown $USER: /opt/ed-ring-colony
#   tar xzf /tmp/ed-ring-colony-dist.tar.gz -C /opt/ed-ring-colony
#   mv /opt/ed-ring-colony/ed-ring-colony /opt/ed-ring-colony/src
#   → дальше по UBUNTU20-INSTALL.md
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

OUT="${1:-ed-ring-colony-dist.tar.gz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$(dirname "$OUT")"

tar czf "$OUT" \
  -C "$(dirname "$ROOT")" \
  --exclude='ed-ring-colony/.git' \
  --exclude='ed-ring-colony/node_modules' \
  --exclude='ed-ring-colony/.next' \
  --exclude='ed-ring-colony/dist' \
  --exclude='ed-ring-colony/deploy-out' \
  --exclude='ed-ring-colony/*.tar.gz' \
  --exclude='ed-ring-colony/dist-archive' \
  --exclude='ed-ring-colony/.env' \
  --exclude='ed-ring-colony/.env.local' \
  --exclude='ed-ring-colony/.env.production' \
  --exclude='ed-ring-colony/uploader/build' \
  --exclude='ed-ring-colony/uploader/dist' \
  "ed-ring-colony"

echo "Готово: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Контрольная сумма: $(sha256sum "$OUT" | cut -d' ' -f1)"
