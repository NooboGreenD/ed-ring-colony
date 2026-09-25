'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  IconActivity,
  IconAlert,
  IconCheckCircle,
  IconClock,
  IconDatabase,
  IconHardDrive,
  IconKey,
  IconPackage,
  IconPlus,
  IconRefresh,
  IconSync,
  IconXCircle,
} from '@/components/Icons';
import { BACKUP_STAGES, ENV_STAGES, UPDATE_STAGES } from '../../../scripts/lib/update-state.mjs';
import { authFetch } from '@/lib/supabaseClient';
import type {
  MonitorContainer,
  MonitorDatabaseSize,
  MonitorDisk,
  MonitorJob,
  MonitorLevel,
  ServerMonitorSnapshot,
} from '@/types/monitor';

const REFRESH_MS = 20_000;
const UPDATE_POLL_MS = 2_000;

type MonitorResponse = { success: true; monitor: ServerMonitorSnapshot } | { error?: string };

interface UpdateState {
  state: string;
  active: boolean;
  // update — пересборка, backup — дамп БД, env — применение ключей окружения.
  // Тот же процессный слот и журнал; по kind выбирается словарь стадий.
  kind?: string;
  stage: string | null;
  stageLabel: string | null;
  percent: number;
  message: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  mode: string | null;
  branch: string | null;
  fromSha: string | null;
  toSha: string | null;
  migrationsApplied: number;
  error: string | null;
  log: Array<{ at: string | null; line: string }>;
}

// Ответ может прийти и успешным, и с ошибкой, и с 409 «уже идёт обновление» —
// все поля держим опциональными, чтобы не гадать над вариантами union.
type UpdateResponse = {
  success?: boolean;
  configured?: boolean;
  connected?: boolean;
  reason?: string | null;
  error?: string;
  update?: UpdateState | null;
};

// Ключи окружения из /api/admin/env: маска (длина + хвост), сырого значения
// нет — его не существует в браузере по построению.
interface EnvKeyRow {
  name: string;
  masked: string;
  length: number;
}

interface EnvKeysResponse {
  success?: boolean;
  configured?: boolean;
  keys?: EnvKeyRow[];
  error?: string;
}

// Известные ключи .env.production — подсказка для «Добавить ключ».
// Значения не привязаны: это только словарь имён с пояснением.
const KNOWN_ENV_KEYS: Array<{ name: string; hint: string }> = [
  { name: 'NEXT_PUBLIC_SUPABASE_URL', hint: 'Адрес Supabase (REST)' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', hint: 'Публичный ключ Supabase (anon)' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', hint: 'Ключ Supabase service_role' },
  { name: 'SUPABASE_PROJECT_REF', hint: 'Референс проекта Supabase' },
  { name: 'SUPABASE_ACCESS_TOKEN', hint: 'Токен Supabase CLI' },
  { name: 'SUPABASE_DB_PASSWORD', hint: 'Пароль Postgres (Supabase)' },
  { name: 'SUPABASE_DB_URL', hint: 'Прямой Postgres (альтернатива DATABASE_URL)' },
  { name: 'DATABASE_URL', hint: 'Прямой Postgres: импорт Spansh, размер БД' },
  { name: 'MONITOR_DB_URL', hint: 'Postgres для замера размера БД со стороны monitor-agent' },
  { name: 'NEXT_PUBLIC_SITE_URL', hint: 'Публичный адрес сайта (https)' },
  { name: 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', hint: 'VAPID публичный ключ (push)' },
  { name: 'VAPID_PRIVATE_KEY', hint: 'VAPID приватный ключ (push)' },
  { name: 'VAPID_SUBJECT', hint: 'Контакт VAPID (mailto:)' },
  { name: 'CRON_SECRET', hint: 'Секрет планировщика jobs' },
  { name: 'JOBS_ENABLED', hint: 'Список задач планировщика' },
  { name: 'JOBS_TRANSLATE_PASSES', hint: 'Проходов перевода за синхронизацию' },
  { name: 'MONITOR_AGENT_TOKEN', hint: 'Токен web → monitor-agent' },
  { name: 'UPDATE_AGENT_TOKEN', hint: 'Токен web → update-agent' },
  { name: 'UPDATE_AGENT_URL', hint: 'Адрес update-agent' },
  { name: 'PROJECT_REPOSITORY', hint: 'Репозиторий GitHub (owner/repo)' },
  { name: 'PROJECT_UPDATE_BRANCH', hint: 'Ветка для обновлений' },
  { name: 'PROJECT_DEPLOY_MODE', hint: 'auto | compose | systemd' },
  { name: 'PROJECT_HOST_DIR', hint: 'Путь к клону на хосте (Docker)' },
  { name: 'UPDATE_BACKUP_DIR', hint: 'Каталог дампов БД' },
  { name: 'UPDATE_BACKUP_KEEP', hint: 'Сколько копий держать' },
  { name: 'AUTH_OAUTH_PROVIDERS', hint: 'Провайдеры входа (discord, vk, yandex…)' },
  { name: 'AUTH_EMAIL_ENABLED', hint: 'Вход по почте (true/false)' },
  { name: 'YANDEX_TRANSLATE_API_KEY', hint: 'Ключ Yandex Translate API' },
  { name: 'YANDEX_TRANSLATE_IAM_TOKEN', hint: 'IAM-токен Yandex (альтернатива ключу)' },
  { name: 'YANDEX_TRANSLATE_FOLDER_ID', hint: 'Каталог Yandex Cloud' },
  { name: 'FRONTIER_REDIRECT_URI', hint: 'Колбэк Frontier CAPI' },
  { name: 'FRONTIER_CLIENT_ID', hint: 'Client ID Frontier CAPI' },
  { name: 'FRONTIER_CLIENT_SECRET', hint: 'Секрет Frontier CAPI (опционально)' },
  { name: 'INARA_API_KEY', hint: 'Ключ Inara API' },
  { name: 'DISCORD_WEBHOOK_URL', hint: 'Discord-вебхук уведомлений' },
  { name: 'RAVEN_API_BASE', hint: 'Адрес Raven Colonial API' },
  { name: 'EDDN_INGEST_SECRET', hint: 'Секрет EDDN-воркера' },
  { name: 'EDDN_INGEST_URL', hint: 'Адрес приёма EDDN' },
  { name: 'GALNET_FEED_LIMIT', hint: 'Galnet: статей за запуск' },
  { name: 'GALNET_TRANSLATE_LIMIT', hint: 'Переводов статей за проход' },
  { name: 'BILLING_STORAGE', hint: 'Хранилище биллинга (supabase/file)' },
  { name: 'VK_ID_CLIENT_ID', hint: 'VK ID: client ID' },
  { name: 'VK_ID_CLIENT_SECRET', hint: 'VK ID: секрет' },
  { name: 'YANDEX_ID_CLIENT_ID', hint: 'Яндекс ID: ClientID' },
  { name: 'YANDEX_ID_CLIENT_SECRET', hint: 'Яндекс ID: client secret' },
];


const LEVEL_META: Record<MonitorLevel, { label: string; className: string }> = {
  healthy: { label: 'В норме', className: 'healthy' },
  warning: { label: 'Требует внимания', className: 'warning' },
  critical: { label: 'Недоступно', className: 'critical' },
  unknown: { label: 'Нет данных', className: 'unknown' },
};

const UPDATE_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'Обновление не выполняется', level: 'unknown' },
  running: { label: 'Идёт обновление', level: 'warning' },
  succeeded: { label: 'Обновление завершено', level: 'healthy' },
  failed: { label: 'Обновление завершилось с ошибкой', level: 'critical' },
  aborted: { label: 'Обновление остановлено', level: 'warning' },
};

const ENV_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'Ключи не применяются', level: 'unknown' },
  running: { label: 'Идёт применение ключей', level: 'warning' },
  succeeded: { label: 'Ключи применены', level: 'healthy' },
  failed: { label: 'Применение ключей завершилось с ошибкой', level: 'critical' },
  aborted: { label: 'Применение ключей остановлено', level: 'warning' },
};

// Отдельный режим кнопки «Применить только миграции» (mode='migrations'):
// база трогается, контейнеры — нет, поэтому и подписи свои.
const MIGRATIONS_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'Миграции не выполняются', level: 'unknown' },
  running: { label: 'Применяю миграции', level: 'warning' },
  succeeded: { label: 'Миграции применены', level: 'healthy' },
  failed: { label: 'Миграции завершились с ошибкой', level: 'critical' },
  aborted: { label: 'Применение миграций остановлено', level: 'warning' },
};

function stateMetaFor(update: UpdateState | null): { label: string; level: MonitorLevel } {
  if (update?.kind === 'env') return ENV_STATE_META[update.state || 'idle'] ?? { label: '—', level: 'unknown' };
  if (update?.mode === 'migrations') return MIGRATIONS_STATE_META[update.state || 'idle'] ?? { label: '—', level: 'unknown' };
  const table = UPDATE_STATE_META;
  return table[update?.state || 'idle'] ?? { label: '—', level: 'unknown' };
}

// Стадии режима «только миграции»: сборка, переключение и проверка живости
// в этом прогоне не происходят — чек-лист их не показывает.
const MIGRATIONS_ONLY_STAGE_IDS = new Set(['prepare', 'fetch', 'compare', 'backup', 'migrate', 'done']);

function stagesForKind(update: UpdateState | null): Array<{ id: string; label: string; percent: number }> {
  if (update?.kind === 'env') return ENV_STAGES;
  if (update?.kind === 'backup') return BACKUP_STAGES;
  if (update?.mode === 'migrations') return UPDATE_STAGES.filter((stage) => MIGRATIONS_ONLY_STAGE_IDS.has(stage.id));
  return UPDATE_STAGES;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(time))
    : '—';
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('ru-RU');
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const units = [
    ['д', 86_400],
    ['ч', 3_600],
    ['м', 60],
    ['с', 1],
  ] as const;
  let rest = Math.floor(seconds);
  const parts: string[] = [];
  for (const [label, size] of units) {
    const amount = Math.floor(rest / size);
    if (amount > 0 || (label === 'с' && parts.length === 0)) parts.push(`${amount}${label}`);
    rest %= size;
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : 'не задан';
}

function StatusPill({ level, label }: { level: MonitorLevel; label?: string }) {
  const meta = LEVEL_META[level];
  return (
    <span className={`ops-status ops-status-${meta.className}`}>
      <span className="ops-status-dot" />
      {label ?? meta.label}
    </span>
  );
}

function containerLevel(container: MonitorContainer): MonitorLevel {
  if (container.state === 'missing' || container.state === 'stopped' || container.health === 'unhealthy') return 'critical';
  if (container.state !== 'running' || container.health === 'starting' || container.restartCount > 3) return 'warning';
  return 'healthy';
}

function containerLabel(container: MonitorContainer): string {
  if (container.state === 'missing') return 'Контейнер не найден';
  if (container.state === 'stopped') return `Остановлен${container.exitCode != null ? ` · код ${container.exitCode}` : ''}`;
  if (container.health === 'unhealthy') return 'Healthcheck не пройден';
  if (container.health === 'starting') return 'Запускается';
  return container.health === 'healthy' ? 'Работает · healthcheck OK' : 'Работает';
}

function jobLevel(job: MonitorJob): MonitorLevel {
  return job.status === 'healthy' ? 'healthy' : job.status === 'warning' ? 'warning' : 'unknown';
}

function projectLevel(snapshot: ServerMonitorSnapshot): MonitorLevel {
  if (snapshot.project.updateStatus === 'current') return 'healthy';
  return snapshot.project.updateStatus === 'different' ? 'warning' : 'unknown';
}

function sizeLevel(size: MonitorDatabaseSize): MonitorLevel {
  if (!size.available) return 'unknown';
  if (size.databaseBytes == null) return 'unknown';
  if (size.databaseBytes > 8 * 1024 ** 3) return 'warning';
  return 'healthy';
}

function diskLevel(disk: MonitorDisk): MonitorLevel {
  if (!disk.available || disk.usedPercent == null) return 'unknown';
  if (disk.availableBytes != null && disk.availableBytes < 1_073_741_824) return 'critical';
  if (disk.usedPercent >= 90) return 'warning';
  return 'healthy';
}

function updateLevel(update: UpdateState | null, connected: boolean): MonitorLevel {
  if (!connected) return 'unknown';
  if (!update) return 'unknown';
  return stateMetaFor(update).level;
}

function stageState(index: number, update: UpdateState | null): 'done' | 'active' | 'todo' {
  if (!update || !update.stage) return 'todo';
  if (update.state === 'succeeded') return 'done';
  const activeIndex = stagesForKind(update).findIndex((stage) => stage.id === update.stage);
  if (activeIndex < 0) return 'todo';
  if (index < activeIndex) return 'done';
  if (index === activeIndex) return 'active';
  return 'todo';
}

/** Панель «Диск и размер базы данных». */
function DiskPanel({ size, disk }: { size: MonitorDatabaseSize; disk: MonitorDisk }) {
  const total = size.schemaBytes ?? size.databaseBytes ?? 0;
  const biggest = size.largest[0]?.totalBytes ?? 0;
  return (
    <section className="ops-panel">
      <div className="ops-panel-head">
        <div>
          <h3>Диск и размер базы данных</h3>
          <p>
            Размер считается прямым запросом к Postgres (<code>pg_database_size</code>, <code>pg_total_relation_size</code>) и не
            сохраняется: ни строк, ни имён пользователей панель не видит.
          </p>
        </div>
        <StatusPill
          level={sizeLevel(size)}
          label={size.available ? 'Замер получен' : 'Нет прямого подключения'}
        />
      </div>

      {!size.available && (
        <div className="ops-notice ops-notice-warning">
          <IconAlert size={16} /> {size.note ?? 'Размер БД недоступен.'}
        </div>
      )}

      {size.available && (
        <>
          <div className="ops-disk-grid">
            <div className="ops-disk-fact">
              <span>База целиком</span>
              <strong>{formatBytes(size.databaseBytes)}</strong>
              <small>{size.databaseName ?? 'postgres'}</small>
            </div>
            <div className="ops-disk-fact">
              <span>Схема public</span>
              <strong>{formatBytes(size.schemaBytes)}</strong>
              <small>таблицы + индексы + TOAST</small>
            </div>
            <div className="ops-disk-fact">
              <span>Данные</span>
              <strong>{formatBytes(size.tableBytes)}</strong>
              <small>без индексов</small>
            </div>
            <div className="ops-disk-fact">
              <span>Индексы</span>
              <strong>{formatBytes(size.indexBytes)}</strong>
              <small>{size.schemaBytes ? `${Math.round(((size.indexBytes ?? 0) / size.schemaBytes) * 100)}% схемы` : '—'}</small>
            </div>
            <div className="ops-disk-fact">
              <span>TOAST (большие поля)</span>
              <strong>{formatBytes(size.toastBytes)}</strong>
              <small>тексты статей и отчётов</small>
            </div>
            <div className="ops-disk-fact">
              <span>Свободно на диске</span>
              <strong>{disk.available ? formatBytes(disk.availableBytes) : '—'}</strong>
              <small>{disk.available ? `из ${formatBytes(disk.totalBytes)} · занято ${disk.usedPercent}%` : 'monitor-agent не отдаёт statfs'}</small>
            </div>
          </div>

          {disk.available && disk.availableBytes != null && disk.availableBytes < 5 * 1024 ** 3 && (
            <div className="ops-notice ops-notice-warning">
              <IconHardDrive size={16} /> На томе осталось {formatBytes(disk.availableBytes)} — перед импортом каталога Spansh (~6 GiB)
              и следующей пересборкой образ стоит почистить.
            </div>
          )}

          {size.largest.length > 0 ? (
            <>
              <div className="ops-subhead">Самые крупные таблицы</div>
              <div className="ops-table-bars">
                {size.largest.map((table) => (
                  <div className="ops-table-bar" key={table.name}>
                    <div className="ops-table-bar-name" title={table.kind}>
                      {table.name}
                      <small>{table.liveRows != null ? `${formatCount(table.liveRows)} строк` : '—'}</small>
                    </div>
                    <div className="ops-bar">
                      <div
                        className={`ops-bar-fill${table.totalBytes === biggest ? ' ops-bar-warn' : ''}`}
                        style={{ width: `${biggest > 0 ? Math.max(2, Math.round((table.totalBytes / biggest) * 100)) : 100}%` }}
                      />
                    </div>
                    <div className="ops-bar-text">
                      {formatBytes(table.totalBytes)}
                      {total > 0 ? ` · ${Math.round((table.totalBytes / total) * 100)}%` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="ops-empty">В схеме public нет таблиц — судя по всему, миграции ещё не применены.</div>
          )}
          <div className="ops-measured">Замерено: {formatDate(size.measuredAt)}</div>
        </>
      )}
    </section>
  );
}

export default function ServerMonitorTab() {
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [updateConnected, setUpdateConnected] = useState(false);
  const [updateConfigured, setUpdateConfigured] = useState(false);
  const [updateReason, setUpdateReason] = useState<string | null>(null);
  // Флажки «Обновление проекта»: что именно входит в прогон — тесты, бэкап
  // БД и накат миграций. Передаются в агент вместе с confirm при запуске.
  const [applyMigrations, setApplyMigrations] = useState(true);
  const [runTests, setRunTests] = useState(true);
  const [backupBefore, setBackupBefore] = useState(true);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [contentBusy, setContentBusy] = useState('');
  const [contentMessage, setContentMessage] = useState('');
  const [envKeys, setEnvKeys] = useState<EnvKeyRow[] | null>(null);
  const [envConfigured, setEnvConfigured] = useState(false);
  const [envBusy, setEnvBusy] = useState('');
  const [envMessage, setEnvMessage] = useState('');
  const [editingKey, setEditingKey] = useState<{ name: string; value: string } | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [applyAll, setApplyAll] = useState(false);
  const inFlight = useRef(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const loadUpdate = useCallback(async () => {
    try {
      const response = await authFetch('/api/admin/monitor/update', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok && !('update' in data)) throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      setUpdateConfigured(data.configured === true);
      setUpdateConnected(data.connected === true);
      setUpdateReason('reason' in data ? data.reason ?? null : null);
      if (data.update) setUpdate(data.update);
    } catch {
      setUpdateConnected(false);
    }
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const response = await authFetch('/api/admin/monitor', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as MonitorResponse;
      if (!response.ok || !('success' in data) || data.success !== true) {
        throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      }
      setSnapshot(data.monitor);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось получить статус');
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadUpdate();
  }, [load, loadUpdate]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  // Прогресс обновления опрашивается чаще, чем остальной мониторинг, и только
  // пока процесс активен: панель должна «дожить» даже если web-контейнер
  // пересоздаётся прямо во время сборки.
  const active = update?.active === true;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void loadUpdate(), UPDATE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, loadUpdate]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [update?.log.length]);

  const startUpdate = useCallback(async () => {
    const ahead = snapshot?.project.aheadBy;
    const pending = snapshot?.project.pendingMigrations.length ?? 0;
    const migrationNote = pending ? ` Будет применено миграций: ${pending}.` : '';
    const options = [
      runTests ? 'тесты: прогнать' : 'тесты: пропустить',
      backupBefore ? 'бэкап БД: сделать' : 'бэкап БД: не делать',
      applyMigrations ? 'миграции: применить' : 'миграции: не применять',
    ].join(' · ');
    const confirmText = `Пересобрать проект${ahead ? ` (свежих коммитов: ${ahead})` : ''} и перезапустить сервисы?${migrationNote}\nОпции: ${options}.\nСайт на время сборки может быть недоступен.`;
    if (!window.confirm(confirmText)) return;
    setUpdateBusy(true);
    setUpdateMessage('');
    try {
      const response = await authFetch('/api/admin/monitor/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, applyMigrations, backup: backupBefore, runTests }),
      });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok) throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      if ('update' in data && data.update) setUpdate(data.update);
      setUpdateMessage('Обновление запущено — прогресс ниже.');
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : 'Не удалось запустить обновление');
    } finally {
      setUpdateBusy(false);
    }
  }, [applyMigrations, backupBefore, runTests, snapshot]);

  // «Применить только миграции»: синхронизация исходников + накат миграций
  // (с бэкапом, если отмечен флажок), без сборки и переключения контейнеров.
  const startMigrationsOnly = useCallback(async () => {
    const pending = snapshot?.project.pendingMigrations.length ?? 0;
    const options = backupBefore ? 'бэкап БД: сделать' : 'бэкап БД: не делать';
    const confirmText = `Применить только миграции${pending ? ` (${pending})` : ''} без пересборки?\n`
      + `Исходники сначала синхронизируются с веткой ${snapshot?.project.upstreamBranch ?? 'main'}, потом миграции применяются к базе.\n`
      + `Опции: ${options}. Контейнеры не перезапускаются — код сайта не меняется.`;
    if (!window.confirm(confirmText)) return;
    setUpdateBusy(true);
    setUpdateMessage('');
    try {
      const response = await authFetch('/api/admin/monitor/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, migrationsOnly: true, backup: backupBefore }),
      });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok) throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      if ('update' in data && data.update) setUpdate(data.update);
      setUpdateMessage('Миграции запущены — прогресс ниже.');
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : 'Не удалось запустить миграции');
    } finally {
      setUpdateBusy(false);
    }
  }, [backupBefore, snapshot]);

  const abortUpdate = useCallback(async () => {
    if (!window.confirm('Остановить обновление? Сборка будет прервана, развёрнутая версия останется прежней.')) return;
    setUpdateBusy(true);
    try {
      const response = await authFetch('/api/admin/monitor/update', { method: 'DELETE' });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok) throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      if ('update' in data && data.update) setUpdate(data.update);
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : 'Не удалось остановить обновление');
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  const runContent = useCallback(async (action: 'sync' | 'translate') => {
    setContentBusy(action);
    setContentMessage('');
    try {
      const response = await authFetch(`/api/admin/content?action=${action}`, { method: 'POST' });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errors = Array.isArray(data.errors) ? (data.errors as string[]) : [];
      if (!response.ok) {
        throw new Error(String(data.error || errors[0] || `HTTP ${response.status}`));
      }
      if (action === 'sync') {
        setContentMessage(`Лента: ${data.inserted ?? 0} новых, ${data.updated ?? 0} обновлено, ${data.translated ?? 0} переведено; в очереди ${data.pendingGalnetTranslations ?? 0}`);
      } else {
        setContentMessage(`Обработано ${data.processed ?? 0}, переведено ${data.translated ?? 0}, ошибок ${data.failed ?? 0}`);
      }
      void load();
    } catch (cause) {
      setContentMessage(cause instanceof Error ? cause.message : 'Пайплайн недоступен');
    } finally {
      setContentBusy('');
    }
  }, [load]);

  // ── API-ключи (.env.production) ────────────────────────────────────
  // Список и правки идут через /api/admin/env → update-agent; браузер видит
  // только маски. «Применить» запускает job вида kind='env' в общем слоте
  // обновления, поэтому его прогресс и журнал рендерятся тем же блоком.
  const loadEnvKeys = useCallback(async () => {
    if (!updateConfigured) return;
    try {
      const response = await authFetch('/api/admin/env', { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as EnvKeysResponse;
      if (!response.ok) {
        setEnvKeys(null);
        return;
      }
      setEnvConfigured(data.configured === true);
      setEnvKeys(Array.isArray(data.keys) ? data.keys : []);
    } catch {
      setEnvKeys(null);
    }
  }, [updateConfigured]);

  useEffect(() => {
    void loadEnvKeys();
  }, [loadEnvKeys]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void loadEnvKeys(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadEnvKeys]);

  // Когда применение ключей завершилось, список пересобираем сразу.
  const envJobFinished = update?.kind === 'env' && update.active === false && update.state !== 'idle';
  useEffect(() => {
    if (envJobFinished) void loadEnvKeys();
  }, [envJobFinished, loadEnvKeys]);

  const saveEnvKeyEdit = useCallback(async () => {
    if (!editingKey) return;
    setEnvBusy('save');
    setEnvMessage('');
    try {
      const response = await authFetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: editingKey.name, value: editingKey.value }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setEnvMessage(`Ключ ${editingKey.name} сохранён. Не забудьте «Применить».`);
      setEditingKey(null);
      void loadEnvKeys();
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : 'Не удалось сохранить ключ');
    } finally {
      setEnvBusy('');
    }
  }, [editingKey, loadEnvKeys]);

  const addEnvKey = useCallback(async () => {
    const key = newKeyName.trim();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) {
      setEnvMessage('Имя ключа: заглавные A–Z, цифры и _ (1–128 символов)');
      return;
    }
    if (!newKeyValue) {
      setEnvMessage('Введите значение ключа');
      return;
    }
    setEnvBusy('add');
    setEnvMessage('');
    try {
      const response = await authFetch('/api/admin/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: newKeyValue }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; created?: boolean };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setEnvMessage(`Ключ ${key} ${data.created ? 'добавлен' : 'обновлён'}. Не забудьте «Применить».`);
      setNewKeyName('');
      setNewKeyValue('');
      void loadEnvKeys();
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : 'Не удалось добавить ключ');
    } finally {
      setEnvBusy('');
    }
  }, [newKeyName, newKeyValue, loadEnvKeys]);

  const removeEnvKey = useCallback(async (name: string) => {
    if (!window.confirm(`Удалить ключ ${name} из файла окружения? Действие вступит в силу после «Применить».`)) return;
    setEnvBusy('delete');
    setEnvMessage('');
    try {
      const response = await authFetch(`/api/admin/env?key=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setEnvMessage(`Ключ ${name} удалён. Не забудьте «Применить».`);
      void loadEnvKeys();
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : 'Не удалось удалить ключ');
    } finally {
      setEnvBusy('');
    }
  }, [loadEnvKeys]);

  const applyEnvKeys = useCallback(async () => {
    const target = applyAll ? 'web, jobs и monitor-agent' : 'web';
    if (!window.confirm(`Пересоздать ${target}, чтобы новые ключи вступили в силу?\nСайт будет недоступен несколько секунд.`)) return;
    setEnvBusy('apply');
    setEnvMessage('');
    try {
      const response = await authFetch('/api/admin/env/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: applyAll ? 'all' : 'web' }),
      });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.update) setUpdate(data.update);
      setEnvMessage('Применение запущено — прогресс в блоке «Обновление проекта».');
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : 'Не удалось применить изменения');
    } finally {
      setEnvBusy('');
    }
  }, [applyAll]);

  const dashboard = snapshot && (
    <>
      <section className="ops-summary-grid" aria-label="Сводка состояния">
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconActivity size={16} /> Приложение</div>
          <StatusPill level="healthy" label="Отвечает" />
          <div className="ops-summary-value">{formatDuration(snapshot.application.uptimeSeconds)}</div>
          <div className="ops-summary-note">аптайм · Node {snapshot.application.nodeVersion}</div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconPackage size={16} /> База данных</div>
          <StatusPill level={snapshot.database.status} label={snapshot.database.status === 'healthy' ? 'Доступна' : undefined} />
          <div className="ops-summary-value">{snapshot.database.latencyMs == null ? '—' : `${snapshot.database.latencyMs} мс`}</div>
          <div className="ops-summary-note">
            {snapshot.database.configured ? 'проверка через Supabase REST' : 'не настроен service role key'}
          </div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconDatabase size={16} /> Место на диске</div>
          <StatusPill level={sizeLevel(snapshot.database.size)} label={snapshot.database.size.available ? formatBytes(snapshot.database.size.databaseBytes) : 'нет данных'} />
          <div className="ops-summary-value">{formatBytes(snapshot.database.size.schemaBytes)}</div>
          <div className="ops-summary-note">
            схема public · {snapshot.disk.available ? `свободно ${formatBytes(snapshot.disk.availableBytes)}` : 'свободное место недоступно'}
          </div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconActivity size={16} /> Docker</div>
          <StatusPill
            level={!snapshot.agent.connected ? 'unknown' : !snapshot.docker.available ? 'critical' : snapshot.docker.containers.some((item) => containerLevel(item) === 'critical') ? 'critical' : snapshot.docker.containers.some((item) => containerLevel(item) === 'warning') ? 'warning' : 'healthy'}
            label={!snapshot.agent.connected ? 'Агент недоступен' : !snapshot.docker.available ? 'Нет доступа' : undefined}
          />
          <div className="ops-summary-value">{snapshot.docker.containers.length || '—'}</div>
          <div className="ops-summary-note">контейнеров проекта</div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconClock size={16} /> Обновления</div>
          <StatusPill level={projectLevel(snapshot)} />
          <div className="ops-summary-value ops-summary-sha">{shortSha(snapshot.project.currentSha)}</div>
          <div className="ops-summary-note">
            {snapshot.project.aheadBy ? `свежих коммитов: ${snapshot.project.aheadBy}` : 'текущая сборка'}
          </div>
        </article>
      </section>

      <div className="ops-grid">
        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>Контейнеры Docker</h3>
              <p>Только сервисы этого Compose-проекта. Логи, переменные и конфигурация не выводятся.</p>
            </div>
            {snapshot.agent.connected && snapshot.docker.available && <StatusPill level="healthy" label="Агент подключён" />}
          </div>
          {!snapshot.agent.configured && (
            <div className="ops-notice ops-notice-warning">
              <IconAlert size={16} /> Монитор Docker выключен: задайте <code>MONITOR_AGENT_TOKEN</code> в <code>.env.production</code> и пересоберите сервисы.
            </div>
          )}
          {snapshot.agent.configured && !snapshot.agent.connected && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> Приватный monitor-agent не отвечает. Проверьте статус сервиса и совпадение <code>MONITOR_AGENT_TOKEN</code>.
            </div>
          )}
          {snapshot.agent.connected && !snapshot.docker.available && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> Agent запущен, но Docker daemon недоступен. Внутренние данные Docker не раскрываются в интерфейсе.
            </div>
          )}
          {snapshot.agent.connected && snapshot.docker.available && (
            <div className="ops-container-list">
              {snapshot.docker.containers.map((container) => {
                const level = containerLevel(container);
                return (
                  <article className="ops-container-card" key={container.service}>
                    <div className="ops-container-topline">
                      <div>
                        <div className="ops-container-service">{container.service}</div>
                        <div className="ops-container-detail">{containerLabel(container)}</div>
                      </div>
                      <StatusPill level={level} />
                    </div>
                    <dl className="ops-facts">
                      <div><dt>Запущен</dt><dd>{formatDate(container.startedAt)}</dd></div>
                      <div><dt>Перезапуски</dt><dd>{container.restartCount}</dd></div>
                      <div><dt>Память</dt><dd>{container.metrics ? `${formatBytes(container.metrics.memoryBytes)}${container.metrics.memoryLimitBytes ? ` / ${formatBytes(container.metrics.memoryLimitBytes)}` : ''}` : '—'}</dd></div>
                      <div><dt>CPU</dt><dd>{container.metrics?.cpuPercent == null ? '—' : `${container.metrics.cpuPercent}%`}</dd></div>
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>Фоновые задачи</h3>
              <p>Последний запуск из защищённого state-файла планировщика: успехи и последняя ошибка, если задача падает.</p>
            </div>
            <StatusPill
              level={!snapshot.scheduler.available ? 'unknown' : snapshot.scheduler.jobs.some((job) => job.status === 'warning') ? 'warning' : snapshot.scheduler.jobs.every((job) => job.status === 'healthy') && snapshot.scheduler.jobs.length ? 'healthy' : 'unknown'}
              label={snapshot.scheduler.available ? undefined : 'Нет state-файла'}
            />
          </div>
          {!snapshot.agent.connected ? (
            <div className="ops-empty">Подключите monitor-agent, чтобы видеть выполнение задач.</div>
          ) : !snapshot.scheduler.available ? (
            <div className="ops-empty">Планировщик ещё не записал состояние или state-файл недоступен.</div>
          ) : snapshot.scheduler.jobs.length === 0 ? (
            <div className="ops-empty">В <code>JOBS_ENABLED</code> нет включённых задач.</div>
          ) : (
            <div className="ops-jobs-list">
              {snapshot.scheduler.jobs.map((job) => {
                const failing = !!job.lastError && !!job.lastFailureAt;
                return (
                  <article className="ops-job-row" key={job.name}>
                    <div className="ops-job-name"><StatusPill level={jobLevel(job)} /> <code>{job.name}</code></div>
                    {failing && (
                      <div className="ops-job-fact ops-job-error" title={job.lastError ?? undefined}>
                        <span>Последняя ошибка</span>
                        <strong>{job.lastError}</strong>
                      </div>
                    )}
                    {failing && (
                      <div className="ops-job-fact">
                        <span>Сбой</span>
                        <strong>{formatDate(job.lastFailureAt ?? null)}{job.failures ? ` · подряд: ${job.failures}` : ''}</strong>
                      </div>
                    )}
                    <div className="ops-job-fact"><span>Последний успех</span><strong>{formatDate(job.lastSuccessAt)}</strong></div>
                    <div className="ops-job-fact"><span>Давность</span><strong>{formatDuration(job.ageSeconds)}</strong></div>
                    <div className="ops-job-fact"><span>Следующий слот</span><strong>{formatDate(job.nextRunAt)}</strong></div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <DiskPanel size={snapshot.database.size} disk={snapshot.disk} />

      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3>Контент и переводы</h3>
            <p>Результат последней синхронизации Galnet и размер очереди переводов. Кнопки выполняют те же шаги, что и планировщик, но сразу.</p>
          </div>
          <StatusPill
            level={!snapshot.content.available ? 'unknown' : snapshot.content.lastSync?.status === 'error' ? 'critical' : (snapshot.content.pendingTotal ?? 0) > 0 ? 'warning' : 'healthy'}
            label={snapshot.content.available ? undefined : 'Нет данных'}
          />
        </div>
        {!snapshot.content.available && (
          <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {snapshot.content.note ?? 'Очередь переводов недоступна.'}</div>
        )}
        {snapshot.content.available && (
          <>
            <div className="ops-disk-grid">
              <div className="ops-disk-fact">
                <span>Последняя синхронизация</span>
                <strong>{formatDate(snapshot.content.lastSync?.at)}</strong>
                <small>{snapshot.content.lastSync ? `${snapshot.content.lastSync.status ?? '—'} · статей ${snapshot.content.lastSync.articlesCount ?? 0}, новых ${snapshot.content.lastSync.newCount ?? 0}` : 'записей нет'}</small>
              </div>
              <div className="ops-disk-fact">
                <span>Galnet ждёт перевода</span>
                <strong>{formatCount(snapshot.content.queue.find((item) => item.table === 'galnet_news')?.pending)}</strong>
                <small>pending / failed / partial</small>
              </div>
              <div className="ops-disk-fact">
                <span>Новости ждут перевода</span>
                <strong>{formatCount(snapshot.content.queue.find((item) => item.table === 'news')?.pending)}</strong>
                <small>таблица news</small>
              </div>
              <div className="ops-disk-fact">
                <span>Yandex Translate</span>
                <strong>{snapshot.content.translateConfigured ? 'настроен' : 'не задан'}</strong>
                <small>YANDEX_TRANSLATE_API_KEY</small>
              </div>
            </div>
            {snapshot.content.lastSync?.error && (
              <div className="ops-notice ops-notice-warning"><IconAlert size={16} /> {snapshot.content.lastSync.error}</div>
            )}
            {!snapshot.content.translateConfigured && (
              <div className="ops-notice ops-notice-critical">
                <IconXCircle size={16} /> Без <code>YANDEX_TRANSLATE_API_KEY</code> статьи собираются, но не переводятся — они и останутся в статусе pending.
              </div>
            )}
            {snapshot.content.note && (
              <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {snapshot.content.note}</div>
            )}
            <div className="ops-update-actions">
              <button type="button" className="ops-refresh-button" disabled={contentBusy !== ''} onClick={() => void runContent('sync')}>
                <IconSync size={14} /> {contentBusy === 'sync' ? 'Синхронизация…' : 'Синхронизировать Galnet'}
              </button>
              <button type="button" className="ops-refresh-button" disabled={contentBusy !== ''} onClick={() => void runContent('translate')}>
                <IconRefresh size={14} /> {contentBusy === 'translate' ? 'Перевод…' : 'Догнать переводы'}
              </button>
              {contentMessage && <span className="ops-inline-note">{contentMessage}</span>}
            </div>
          </>
        )}
      </section>

      <div className="ops-grid">
        <section className="ops-panel ops-project-panel">
          <div className="ops-panel-head">
            <div>
              <h3>Версия проекта</h3>
              <p>Сверка текущей сборки с веткой <code>{snapshot.project.upstreamBranch}</code> на GitHub выполняется не чаще раза в 5 минут.</p>
            </div>
            <StatusPill level={projectLevel(snapshot)} />
          </div>
          <div className="ops-project-grid">
            <div className="ops-project-item"><span>Текущий commit</span><strong><code>{shortSha(snapshot.project.currentSha)}</code></strong></div>
            <div className="ops-project-item"><span>Ветка сборки</span><strong>{snapshot.project.currentRef ?? '—'}</strong></div>
            <div className="ops-project-item"><span>Собрано</span><strong>{formatDate(snapshot.project.builtAt)}</strong></div>
            <div className="ops-project-item"><span>GitHub {snapshot.project.upstreamBranch}</span><strong><code>{shortSha(snapshot.project.upstreamSha)}</code></strong></div>
            <div className="ops-project-item"><span>Свежих коммитов</span><strong>{snapshot.project.aheadBy == null ? '—' : snapshot.project.aheadBy}</strong></div>
          </div>
          {snapshot.project.updateStatus === 'current' && (
            <div className="ops-notice ops-notice-healthy"><IconCheckCircle size={16} /> Сборка совпадает с последней ревизией main, проверенной {formatDate(snapshot.project.upstreamCheckedAt)}.</div>
          )}
          {snapshot.project.updateStatus === 'different' && (
            <div className="ops-notice ops-notice-warning"><IconAlert size={16} /> Ревизия main отличается от развёрнутой. Обновите проект кнопкой справа — планировщик пересборки ждать не нужно.</div>
          )}
          {snapshot.project.updateStatus === 'unknown' && (
            <div className="ops-notice ops-notice-info"><IconAlert size={16} /> Точную сверку нельзя выполнить. Перед сборкой передайте <code>APP_GIT_SHA</code>, <code>APP_GIT_REF</code> и <code>APP_BUILD_TIME</code>.</div>
          )}
        </section>

        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>Обновление проекта</h3>
              <p>Ручная пересборка: git pull → бэкап БД → миграции → сборка → перезапуск сервисов → проверка живости. Флажки ниже выбирают, что войдёт в прогон; кнопка «Применить только миграции» обновляет базу без сборки.</p>
            </div>
            <StatusPill
              level={updateConnected ? (update ? stateMetaFor(update).level : 'unknown') : updateConfigured ? 'critical' : 'unknown'}
              label={updateConnected ? stateMetaFor(update).label : updateConfigured ? 'Update-агент не отвечает' : 'Агент не настроен'}
            />
          </div>

          {!updateConfigured && (
            <div className="ops-notice ops-notice-info">
              <IconAlert size={16} /> Кнопка появится, когда на хосте будет запущен приватный update-agent
              (<code>node scripts/update-agent.mjs</code>), а в <code>.env.production</code> заданы
              <code> UPDATE_AGENT_URL</code> и <code>UPDATE_AGENT_TOKEN</code>. Запуск одной командой:
              <code> bash deploy/start-update-agent.sh</code>.
            </div>
          )}
          {updateConfigured && !updateConnected && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> {updateReason || 'Update-агент недоступен: обновление не запустится, сайт продолжает работать.'}
            </div>
          )}

          {update && (update.active || update.state !== 'idle') && (
            <>
              <div className="ops-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent || 0)}>
                <div className="ops-progress-fill" style={{ width: `${Math.max(2, Math.min(100, Math.round(update.percent || 0)))}%` }} />
              </div>
              <ul className="ops-update-stages">
                {stagesForKind(update).map((stage, index) => (
                  <li className="ops-update-stage" key={stage.id} data-state={stageState(index, update)}>
                    {stageState(index, update) === 'done' ? <IconCheckCircle size={11} /> : <IconClock size={11} />}
                    {stage.label}
                  </li>
                ))}
              </ul>
              <dl className="ops-facts">
                <div><dt>Стадия</dt><dd>{update.stageLabel || update.stage || '—'}</dd></div>
                <div><dt>Начало</dt><dd>{formatDate(update.startedAt)}</dd></div>
                <div><dt>Обновлено</dt><dd>{formatDate(update.updatedAt)}</dd></div>
                {update.kind === 'env' ? (
                  <div><dt>Область</dt><dd>{update.mode === 'all' ? 'web + jobs + monitor-agent' : 'web'}</dd></div>
                ) : (
                  <>
                    <div><dt>Режим</dt><dd>{update.mode === 'migrations' ? 'только миграции (без сборки)' : update.mode || '—'}</dd></div>
                    <div><dt>Ревизия</dt><dd>{update.fromSha ? `${update.fromSha.slice(0, 12)} → ${(update.toSha || '').slice(0, 12)}` : '—'}</dd></div>
                    <div><dt>Миграций применено</dt><dd>{update.migrationsApplied ?? 0}</dd></div>
                  </>
                )}
              </dl>
              {update.message && <div className="ops-inline-note ops-inline-progress">{update.message}</div>}
              {update.error && (
                <div className={`ops-notice ${update.state === 'failed' ? 'ops-notice-critical' : 'ops-notice-warning'}`}>
                  <IconAlert size={16} /> {update.error}{update.exitCode != null ? ` (код ${update.exitCode})` : ''}
                </div>
              )}
              {update.log.length > 0 && (
                <pre className="ops-log" ref={logRef}>
                  {update.log.map((entry, index) => (
                    <div key={`${entry.at ?? ''}-${index}`}>
                      {entry.at ? <time>{new Date(entry.at).toLocaleTimeString('ru-RU')}</time> : null}
                      {entry.line}
                    </div>
                  ))}
                </pre>
              )}
            </>
          )}

          {snapshot.project.pendingMigrations.length > 0 && (
            <div className="ops-migrations">
              <span>Неприменённые миграции (будут применены автоматически, если включено ниже):</span>
              {snapshot.project.pendingMigrations.map((name) => <code key={name}>{name}</code>)}
            </div>
          )}

          <div className="ops-update-actions">
            <label title="npm test во время сборки (RUN_TESTS в образе / npm test в systemd-режиме). Без тестов сборка быстрее.">
              <input type="checkbox" checked={runTests} onChange={(event) => setRunTests(event.target.checked)} />
              с тестами
            </label>
            <label title="pg_dump базы данных перед обновлением (каталог UPDATE_BACKUP_DIR).">
              <input type="checkbox" checked={backupBefore} onChange={(event) => setBackupBefore(event.target.checked)} />
              с бэкапом БД
            </label>
            <label title="Применить неприменённые supabase/migrations/*.sql перед пересборкой.">
              <input type="checkbox" checked={applyMigrations} onChange={(event) => setApplyMigrations(event.target.checked)} />
              с миграциями
            </label>
          </div>

          <div className="ops-update-actions">
            <button
              type="button"
              className="ops-button-primary"
              disabled={!updateConnected || updateBusy || update?.active === true}
              onClick={() => void startUpdate()}
            >
              <IconRefresh size={14} />
              {updateBusy ? 'Запускаю…' : update?.active ? 'Идёт обновление…' : 'Обновить сейчас'}
            </button>
            <button
              type="button"
              className="ops-refresh-button"
              title="Синхронизировать исходники и применить неприменённые миграции — без сборки и перезапуска контейнеров"
              disabled={!updateConnected || updateBusy || update?.active === true}
              onClick={() => void startMigrationsOnly()}
            >
              <IconDatabase size={14} /> Применить только миграции
            </button>
            {update?.active === true && (
              <button type="button" className="ops-refresh-button ops-button-danger" disabled={updateBusy} onClick={() => void abortUpdate()}>
                <IconXCircle size={14} /> Остановить
              </button>
            )}
            {snapshot.project.updateStatus === 'current' && (
              <span className="ops-inline-note">
                Отставания от {snapshot.project.upstreamBranch} нет — кнопка всё равно применит недостающие миграции
                и пересоберёт проект (так чинятся сорвавшиеся сборки и пропущенные миграции).
              </span>
            )}
            {updateMessage && <span className="ops-inline-note">{updateMessage}</span>}
          </div>
        </section>
      </div>

      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3><IconKey size={15} /> API-ключи сайта</h3>
            <p>
              Ключи окружения (.env.production на сервере): редактирование и добавление прямо с сайта,
              без SSH. Значения выводятся в маске — сырой ключ в браузер не передаётся, «Изменить»
              заменяет значение целиком. После правки нажмите «Применить»: сервисы пересоздаются без
              пересборки. Ключи <code>NEXT_PUBLIC_*</code> вшиваются в бандл при сборке — они требуют
              «Обновить сейчас».
            </p>
          </div>
          <StatusPill
            level={!updateConfigured ? 'unknown' : envKeys == null ? 'unknown' : envConfigured ? 'healthy' : 'critical'}
            label={!updateConfigured ? 'Агент не настроен' : envKeys == null ? 'Нет данных' : envConfigured ? `Ключей: ${envKeys.length}` : 'Файл окружения не найден'}
          />
        </div>

        {!updateConfigured && (
          <div className="ops-notice ops-notice-info">
            <IconAlert size={16} /> Управление ключами появляется после запуска приватного update-agent
            (<code>bash deploy/start-update-agent.sh</code>) — он единственный имеет доступ к файлу окружения на хосте.
          </div>
        )}
        {updateConfigured && envKeys == null && (
          <div className="ops-notice ops-notice-info"><IconAlert size={16} /> Update-агент не ответил: проверьте UPDATE_AGENT_URL/TOKEN в .env.production.</div>
        )}
        {updateConfigured && envKeys != null && !envConfigured && (
          <div className="ops-notice ops-notice-critical">
            <IconXCircle size={16} /> Файл окружения не найден на хосте — добавьте ключи ниже, файл будет создан.
          </div>
        )}

        {updateConfigured && envKeys != null && envConfigured && (
          <>
            {envKeys.length === 0 ? (
              <div className="ops-empty">В файле окружения пока нет ключей.</div>
            ) : (
              <div className="ops-env-list">
                {envKeys.map((key) => (
                  <div className="ops-env-row" key={key.name}>
                    <code className="ops-env-name">{key.name}</code>
                    <span className="ops-env-masked" title="Сырое значение не передаётся в браузер">{key.masked}</span>
                    <div className="ops-env-actions">
                      {editingKey?.name === key.name ? (
                        <>
                          <input
                            type="password"
                            className="ops-env-input"
                            value={editingKey.value}
                            placeholder="новое значение"
                            onChange={(event) => setEditingKey({ ...editingKey, value: event.target.value })}
                          />
                          <button type="button" disabled={envBusy !== '' || !editingKey.value} onClick={() => void saveEnvKeyEdit()}>
                            {envBusy === 'save' ? 'Сохраняю…' : 'Сохранить'}
                          </button>
                          <button type="button" disabled={envBusy !== ''} onClick={() => setEditingKey(null)}>Отмена</button>
                        </>
                      ) : (
                        <>
                          <button type="button" disabled={envBusy !== ''} onClick={() => setEditingKey({ name: key.name, value: '' })}>
                            Изменить
                          </button>
                          <button type="button" disabled={envBusy !== ''} onClick={() => void removeEnvKey(key.name)}>
                            {envBusy === 'delete' ? 'Удаляю…' : 'Удалить'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="ops-env-add">
              <div className="ops-env-add-title">Добавить / переопределить ключ</div>
              <div className="ops-env-add-row">
                <select
                  className="ops-env-input"
                  value={newKeyName}
                  onChange={(event) => setNewKeyName(event.target.value)}
                >
                  <option value="">— выбрать ключ —</option>
                  {KNOWN_ENV_KEYS
                    .filter((known) => !envKeys.some((key) => key.name === known.name))
                    .map((known) => (
                      <option key={known.name} value={known.name} title={known.hint}>
                        {known.name} — {known.hint}
                      </option>
                    ))}
                </select>
                <input
                  className="ops-env-input"
                  value={newKeyName}
                  placeholder="ИЛИ своё имя: MY_API_KEY"
                  onChange={(event) => setNewKeyName(event.target.value.toUpperCase())}
                />
                <input
                  type="password"
                  className="ops-env-input"
                  value={newKeyValue}
                  placeholder="значение ключа"
                  onChange={(event) => setNewKeyValue(event.target.value)}
                />
                <button type="button" className="ops-refresh-button" disabled={envBusy !== ''} onClick={() => void addEnvKey()}>
                  <IconPlus size={14} /> {envBusy === 'add' ? 'Добавляю…' : 'Добавить ключ'}
                </button>
              </div>
            </div>

            {(update?.kind === 'env' && update.active === true) && (
              <div className="ops-env-applying">
                <div className="ops-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent || 0)}>
                  <div className="ops-progress-fill" style={{ width: `${Math.max(2, Math.min(100, Math.round(update.percent || 0)))}%` }} />
                </div>
                <div className="ops-inline-note">
                  {update.stageLabel || 'Применение ключей…'} — {Math.round(update.percent || 0)}%
                  {update.error ? ` · ${update.error}` : ''}
                </div>
              </div>
            )}

            <div className="ops-update-actions">
              <button
                type="button"
                className="ops-button-primary"
                disabled={envBusy !== '' || update?.active === true}
                onClick={() => void applyEnvKeys()}
              >
                <IconRefresh size={14} />
                {envBusy === 'apply' || (update?.kind === 'env' && update.active === true)
                  ? 'Применяю…'
                  : 'Применить (пересоздать web)'}
              </button>
              <label>
                <input type="checkbox" checked={applyAll} onChange={(event) => setApplyAll(event.target.checked)} />
                web + jobs + monitor-agent
              </label>
              {envMessage && <span className="ops-inline-note">{envMessage}</span>}
            </div>
          </>
        )}
      </section>

      <section className="ops-panel ops-technical-panel">
        <h3>Технические сведения</h3>
        <dl className="ops-facts ops-technical-facts">
          <div><dt>Старт приложения</dt><dd>{formatDate(snapshot.application.startedAt)}</dd></div>
          <div><dt>Память процесса</dt><dd>{formatBytes(snapshot.application.memory.rssBytes)} RSS · {formatBytes(snapshot.application.memory.heapUsedBytes)} heap</dd></div>
          <div><dt>Проверка БД</dt><dd>{snapshot.database.latencyMs == null ? 'нет ответа' : `${snapshot.database.latencyMs} мс`}</dd></div>
          <div><dt>Размер БД</dt><dd>{snapshot.database.size.available ? `${formatBytes(snapshot.database.size.databaseBytes)} · замер ${formatDate(snapshot.database.size.measuredAt)}` : 'нет прямого подключения'}</dd></div>
          <div><dt>Диск</dt><dd>{snapshot.disk.available ? `${formatBytes(snapshot.disk.usedBytes)} из ${formatBytes(snapshot.disk.totalBytes)} · свободно ${formatBytes(snapshot.disk.availableBytes)}` : 'monitor-agent не отдаёт statfs'}</dd></div>
          <div><dt>Обновлено</dt><dd>{formatDate(snapshot.checkedAt)}</dd></div>
        </dl>
      </section>
    </>
  );

  return (
    <div className="ops-monitor">
      <div className="ops-monitor-header">
        <div>
          <div className="ops-kicker">Operations center</div>
          <h2>Мониторинг сервера</h2>
          <p>Состояние сайта, базы данных и диска, Docker, фоновых задач и развёрнутой версии проекта.</p>
        </div>
        <div className="ops-header-actions">
          {snapshot && <StatusPill level={snapshot.overall} label={LEVEL_META[snapshot.overall].label} />}
          <label className="ops-auto-refresh">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            автообновление 20 с
          </label>
          <button type="button" className="ops-refresh-button" disabled={loading} onClick={() => void load()}>
            <IconRefresh size={14} /> {loading ? 'Обновление…' : 'Обновить'}
          </button>
        </div>
      </div>
      {error && <div className="ops-notice ops-notice-critical"><IconXCircle size={16} /> {error}</div>}
      {!snapshot && !error && <div className="ops-loading">Собираем безопасный статус сервисов…</div>}
      {dashboard}
    </div>
  );
}
