#!/usr/bin/env node
/**
 * Почему прямой Postgres «недоступен»: DNS и TCP по отдельности.
 *
 * Зачем отдельный скрипт, если есть `--check-db`: тот импортирует половину
 * приложения (`@supabase/supabase-js`, модуль `pg`) и живёт внутри образа.
 * Этот — не зависит ни от чего, кроме Node, поэтому его можно запустить на
 * ХОСТЕ, в чужом контейнере или на старой сборке, где новой диагностики ещё
 * нет. Он ничего не пишет и никуда не подключается как клиент Postgres:
 * только резолвит имя и открывает сокет.
 *
 * Запуск:
 *   node scripts/check-db-reachability.mjs                       # из DATABASE_URL/SUPABASE_DB_URL
 *   node scripts/check-db-reachability.mjs postgresql://…@db:5432/postgres
 *   node scripts/check-db-reachability.mjs db:5432 host.docker.internal:5432 127.0.0.1:5432
 *   docker compose exec web node /app/scripts/check-db-reachability.mjs db:5432
 *
 * Код возврата 0 — хотя бы один адрес отвечает; 1 — ни один.
 */

import { probePgReachability } from '../src/lib/pgReachability.ts';

/** `host:port`, строка подключения или голое имя — всё сводится к паре. */
function parseTarget(value) {
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname) return null;
      return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 5432) };
    } catch {
      return null;
    }
  }
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw);
  if (!match) return null;
  return { host: match[1].replace(/^\[|\]$/g, ''), port: Number(match[2] || 5432) };
}

function maskedSource() {
  const url = process.env.DATABASE_URL?.trim() || process.env.SUPABASE_DB_URL?.trim() || '';
  return url || null;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const sources = args.length ? args : [maskedSource()].filter(Boolean);

if (sources.length === 0) {
  console.error('Нечего проверять: задайте DATABASE_URL/SUPABASE_DB_URL или передайте host:port аргументом.');
  console.error('Пример: node scripts/check-db-reachability.mjs db:5432 host.docker.internal:5432 172.17.0.1:5432');
  process.exit(2);
}

let anyOk = false;
for (const source of sources) {
  const target = parseTarget(source);
  if (!target) {
    console.error(`? «${source}» — не похоже ни на строку подключения, ни на host:port`);
    continue;
  }
  const probe = await probePgReachability(target.host, target.port, { timeoutMs: 5_000 });
  const mark = probe.kind === 'ok' ? 'OK  ' : 'FAIL';
  console.log(`${mark} ${target.host}:${target.port} — ${probe.kind}`);
  console.log(`     DNS: ${probe.addresses.length ? probe.addresses.join(', ') : 'имя не резолвится'}`);
  console.log(`     ${probe.message}`);
  if (probe.kind === 'ok') anyOk = true;
}

if (!anyOk) {
  console.log('');
  console.log('Ни один адрес не отвечает. Дальше по порядку (подробно — GALAXY-IMPORT-SPEED.md, раздел 1a):');
  console.log('  1. docker network ls | grep -i supabase       — имя сети стека');
  console.log('  2. echo SUPABASE_NETWORK=… >> .env.production и поднять стек с');
  console.log('     -f docker-compose.yml -f deploy/compose.supabase-net.yml');
  console.log('  3. либо DATABASE_URL на host.docker.internal / 172.17.0.1 с опубликованным 5432');
  console.log('  4. либо залить каталог с ХОСТА: DATABASE_URL=…@127.0.0.1:5432/… node scripts/import-spansh-systems.mjs --from-shards');
}

process.exit(anyOk ? 0 : 1);
