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
import { useI18n } from '@/lib/i18n/I18nContext';
import { BACKUP_STAGES, ENV_STAGES, SMTP_STAGES, STORAGE_STAGES, UPDATE_STAGES } from '../../../scripts/lib/update-state.mjs';
import StorageHealthPanel from '@/components/Admin/StorageHealthPanel';
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

/**
 * Сведения о самом update-agent (GET /api/admin/monitor/update → agent).
 *
 * В foreground обновление не пересоздаёт контейнер апдейтера — иначе оно
 * оборвало бы само себя. После успешного health-check его заменяет detached
 * helper; до этого агент может кратко работать на предыдущей версии. Такой
 * переход показываем явно, чтобы не выглядело как «галочки не влияют».
 */
interface AgentInfo {
  protocol: number;
  expectedProtocol: number;
  outdated: boolean;
  stale: boolean;
  fromRepo: boolean;
  revision: string | null;
  repoRevision: string | null;
  startedAt: string | null;
  migrationsOnlySupported: boolean;
  /** Ручная команда из панели поддерживается независимо от автоматики. */
  canRestart: boolean;
  /** UPDATE_AGENT_SELF_RESTART: автоматический выход после обновления. */
  autoRestart: boolean;
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
  agent?: AgentInfo | null;
};

/**
 * Склейка нового снимка прогресса с уже показанным.
 *
 * Журнал приходит не в каждом ответе: POST/DELETE возвращают документ без
 * хвоста, а раньше и GET мог получить из кэша «публичную» версию без лога.
 * Прямая подстановка такого снимка стирала журнал на экране — он мигал,
 * появляясь и пропадая каждые пару секунд. Для одного и того же прогона
 * (`startedAt`) держим самый длинный виденный хвост; новый прогон начинает
 * журнал с чистого листа.
 */
function mergeUpdate(previous: UpdateState | null, next: UpdateState): UpdateState {
  if (!previous || previous.startedAt !== next.startedAt) return next;
  const log = next.log.length >= previous.log.length ? next.log : previous.log;
  return { ...next, log };
}

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
  { name: 'NEXT_PUBLIC_SUPABASE_URL', hint: 'mon.envHint.nextPublicSupabaseUrl' },
  { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', hint: 'mon.envHint.nextPublicSupabaseAnonKey' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', hint: 'mon.envHint.supabaseServiceRoleKey' },
  { name: 'SUPABASE_PROJECT_REF', hint: 'mon.envHint.supabaseProjectRef' },
  { name: 'SUPABASE_ACCESS_TOKEN', hint: 'mon.envHint.supabaseAccessToken' },
  { name: 'SUPABASE_DB_PASSWORD', hint: 'mon.envHint.supabaseDbPassword' },
  { name: 'SUPABASE_DB_URL', hint: 'mon.envHint.supabaseDbUrl' },
  { name: 'DATABASE_URL', hint: 'mon.envHint.databaseUrl' },
  { name: 'MONITOR_DB_URL', hint: 'mon.envHint.monitorDbUrl' },
  { name: 'NEXT_PUBLIC_SITE_URL', hint: 'mon.envHint.nextPublicSiteUrl' },
  { name: 'NEXT_PUBLIC_VAPID_PUBLIC_KEY', hint: 'mon.envHint.nextPublicVapidPublicKey' },
  { name: 'VAPID_PRIVATE_KEY', hint: 'mon.envHint.vapidPrivateKey' },
  { name: 'VAPID_SUBJECT', hint: 'mon.envHint.vapidSubject' },
  { name: 'CRON_SECRET', hint: 'mon.envHint.cronSecret' },
  { name: 'JOBS_ENABLED', hint: 'mon.envHint.jobsEnabled' },
  { name: 'JOBS_TRANSLATE_PASSES', hint: 'mon.envHint.jobsTranslatePasses' },
  { name: 'MONITOR_AGENT_TOKEN', hint: 'mon.envHint.monitorAgentToken' },
  { name: 'UPDATE_AGENT_TOKEN', hint: 'mon.envHint.updateAgentToken' },
  { name: 'UPDATE_AGENT_URL', hint: 'mon.envHint.updateAgentUrl' },
  { name: 'PROJECT_REPOSITORY', hint: 'mon.envHint.projectRepository' },
  { name: 'PROJECT_UPDATE_BRANCH', hint: 'mon.envHint.projectUpdateBranch' },
  { name: 'PROJECT_DEPLOY_MODE', hint: 'mon.envHint.projectDeployMode' },
  { name: 'PROJECT_HOST_DIR', hint: 'mon.envHint.projectHostDir' },
  { name: 'UPDATE_BACKUP_DIR', hint: 'mon.envHint.updateBackupDir' },
  { name: 'UPDATE_BACKUP_KEEP', hint: 'mon.envHint.updateBackupKeep' },
  { name: 'AUTH_OAUTH_PROVIDERS', hint: 'mon.envHint.authOauthProviders' },
  { name: 'AUTH_EMAIL_ENABLED', hint: 'mon.envHint.authEmailEnabled' },
  { name: 'YANDEX_TRANSLATE_API_KEY', hint: 'mon.envHint.yandexTranslateApiKey' },
  { name: 'YANDEX_TRANSLATE_IAM_TOKEN', hint: 'mon.envHint.yandexTranslateIamToken' },
  { name: 'YANDEX_TRANSLATE_FOLDER_ID', hint: 'mon.envHint.yandexTranslateFolderId' },
  { name: 'FRONTIER_REDIRECT_URI', hint: 'mon.envHint.frontierRedirectUri' },
  { name: 'FRONTIER_CLIENT_ID', hint: 'mon.envHint.frontierClientId' },
  { name: 'FRONTIER_CLIENT_SECRET', hint: 'mon.envHint.frontierClientSecret' },
  { name: 'INARA_API_KEY', hint: 'mon.envHint.inaraApiKey' },
  { name: 'DISCORD_WEBHOOK_URL', hint: 'mon.envHint.discordWebhookUrl' },
  { name: 'RAVEN_API_BASE', hint: 'mon.envHint.ravenApiBase' },
  { name: 'EDDN_INGEST_SECRET', hint: 'mon.envHint.eddnIngestSecret' },
  { name: 'EDDN_INGEST_URL', hint: 'mon.envHint.eddnIngestUrl' },
  { name: 'GALNET_FEED_LIMIT', hint: 'mon.envHint.galnetFeedLimit' },
  { name: 'GALNET_TRANSLATE_LIMIT', hint: 'mon.envHint.galnetTranslateLimit' },
  { name: 'BILLING_STORAGE', hint: 'mon.envHint.billingStorage' },
  { name: 'VK_ID_CLIENT_ID', hint: 'mon.envHint.vkIdClientId' },
  { name: 'VK_ID_CLIENT_SECRET', hint: 'mon.envHint.vkIdClientSecret' },
  { name: 'YANDEX_ID_CLIENT_ID', hint: 'mon.envHint.yandexIdClientId' },
  { name: 'YANDEX_ID_CLIENT_SECRET', hint: 'mon.envHint.yandexIdClientSecret' },
];


const LEVEL_META: Record<MonitorLevel, { label: string; className: string }> = {
  healthy: { label: 'mon.levelHealthy', className: 'healthy' },
  warning: { label: 'mon.levelWarning', className: 'warning' },
  critical: { label: 'mon.levelCritical', className: 'critical' },
  unknown: { label: 'mon.levelUnknown', className: 'unknown' },
};

const UPDATE_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'mon.updIdle', level: 'unknown' },
  running: { label: 'mon.updRunning', level: 'warning' },
  succeeded: { label: 'mon.updSucceeded', level: 'healthy' },
  failed: { label: 'mon.updFailed', level: 'critical' },
  aborted: { label: 'mon.updAborted', level: 'warning' },
};

const ENV_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'mon.envIdle', level: 'unknown' },
  running: { label: 'mon.envRunning', level: 'warning' },
  succeeded: { label: 'mon.envSucceeded', level: 'healthy' },
  failed: { label: 'mon.envFailed', level: 'critical' },
  aborted: { label: 'mon.envAborted', level: 'warning' },
};

// Отдельный режим кнопки «Применить только миграции» (mode='migrations'):
// база трогается, контейнеры — нет, поэтому и подписи свои.
const MIGRATIONS_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'mon.migIdle', level: 'unknown' },
  running: { label: 'mon.migRunning', level: 'warning' },
  succeeded: { label: 'mon.migSucceeded', level: 'healthy' },
  failed: { label: 'mon.migFailed', level: 'critical' },
  aborted: { label: 'mon.migAborted', level: 'warning' },
};

// Job kind='smtp': пересоздание auth стека Supabase и web ради настроек
// почты (Админка → Авторизация → «Отправка писем»).
const SMTP_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'mon.smtpIdle', level: 'unknown' },
  running: { label: 'mon.smtpRunning', level: 'warning' },
  succeeded: { label: 'mon.smtpSucceeded', level: 'healthy' },
  failed: { label: 'mon.smtpFailed', level: 'critical' },
  aborted: { label: 'mon.smtpAborted', level: 'warning' },
};

// Job kind='storage': проверка и перезапуск сервиса Storage стека Supabase.
// Он живёт вне compose сайта, поэтому у него свои подписи и свои этапы.
const STORAGE_STATE_META: Record<string, { label: string; level: MonitorLevel }> = {
  idle: { label: 'mon.storeIdle', level: 'unknown' },
  running: { label: 'mon.storeRunning', level: 'warning' },
  succeeded: { label: 'mon.storeSucceeded', level: 'healthy' },
  failed: { label: 'mon.storeFailed', level: 'critical' },
  aborted: { label: 'mon.storeAborted', level: 'warning' },
};

function stateMetaFor(update: UpdateState | null): { label: string; level: MonitorLevel } {
  if (update?.kind === 'env') return ENV_STATE_META[update.state || 'idle'] ?? { label: '—', level: 'unknown' };
  if (update?.kind === 'storage') return STORAGE_STATE_META[update.state || 'idle'] ?? { label: '—', level: 'unknown' };
  if (update?.kind === 'smtp') return SMTP_STATE_META[update.state || 'idle'] ?? { label: '—', level: 'unknown' };
  if (update?.mode === 'migrations') return MIGRATIONS_STATE_META[update.state || 'idle'] ?? { label: '—', level: 'unknown' };
  const table = UPDATE_STATE_META;
  return table[update?.state || 'idle'] ?? { label: '—', level: 'unknown' };
}

// Стадии режима «только миграции»: сборка, переключение и проверка живости
// в этом прогоне не происходят — чек-лист их не показывает.
const MIGRATIONS_ONLY_STAGE_IDS = new Set(['prepare', 'fetch', 'compare', 'backup', 'migrate', 'done']);

function stagesForKind(update: UpdateState | null): Array<{ id: string; label: string; percent: number }> {
  if (update?.kind === 'env') return ENV_STAGES;
  if (update?.kind === 'smtp') return SMTP_STAGES;
  if (update?.kind === 'storage') return STORAGE_STAGES;
  if (update?.kind === 'backup') return BACKUP_STAGES;
  if (update?.mode === 'migrations') return UPDATE_STAGES.filter((stage) => MIGRATIONS_ONLY_STAGE_IDS.has(stage.id));
  return UPDATE_STAGES;
}

type TFn = (key: string, params?: Record<string, string | number>) => string;

function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(time))
    : '—';
}

function formatBytes(value: number | null | undefined, t: TFn): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  const units = [t('mon.unitB'), t('mon.unitKB'), t('mon.unitMB'), t('mon.unitGB'), t('mon.unitTB')];
  const index = Math.min(units.length - 1, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatCount(value: number | null | undefined, locale: string): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(locale);
}

function formatDuration(seconds: number | null | undefined, t: TFn): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const second = t('mon.unitSecond');
  const units = [
    [t('mon.unitDay'), 86_400],
    [t('mon.unitHour'), 3_600],
    [t('mon.unitMinute'), 60],
    [second, 1],
  ] as const;
  let rest = Math.floor(seconds);
  const parts: string[] = [];
  for (const [label, size] of units) {
    const amount = Math.floor(rest / size);
    if (amount > 0 || (label === second && parts.length === 0)) parts.push(`${amount}${label}`);
    rest %= size;
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}

function shortSha(value: string | null | undefined, t: TFn): string {
  return value ? value.slice(0, 12) : t('mon.notSet');
}

function StatusPill({ level, label }: { level: MonitorLevel; label?: string }) {
  const { t } = useI18n();
  const meta = LEVEL_META[level];
  return (
    <span className={`ops-status ops-status-${meta.className}`}>
      <span className="ops-status-dot" />
      {label ?? t(meta.label)}
    </span>
  );
}

function containerLevel(container: MonitorContainer): MonitorLevel {
  if (container.state === 'missing' || container.state === 'stopped' || container.health === 'unhealthy') return 'critical';
  if (container.state !== 'running' || container.health === 'starting' || container.restartCount > 3) return 'warning';
  return 'healthy';
}

function containerLabel(container: MonitorContainer, t: TFn): string {
  if (container.state === 'missing') return t('mon.containerMissing');
  if (container.state === 'stopped') {
    return `${t('mon.containerStopped')}${container.exitCode != null ? t('mon.exitCodeSuffix', { code: container.exitCode }) : ''}`;
  }
  if (container.health === 'unhealthy') return t('mon.healthcheckFailed');
  if (container.health === 'starting') return t('mon.startingLabel');
  return container.health === 'healthy' ? t('mon.runningOk') : t('mon.running');
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
  const { t, locale } = useI18n();
  const total = size.schemaBytes ?? size.databaseBytes ?? 0;
  const biggest = size.largest[0]?.totalBytes ?? 0;
  return (
    <section className="ops-panel">
      <div className="ops-panel-head">
        <div>
          <h3>{t('mon.diskTitle')}</h3>
          <p>
            {t('mon.diskNoteBefore')} (<code>pg_database_size</code>, <code>pg_total_relation_size</code>) {t('mon.diskNoteAfter')}
          </p>
        </div>
        <StatusPill
          level={sizeLevel(size)}
          label={size.available ? t('mon.measuredOk') : t('mon.noDirectConn')}
        />
      </div>

      {!size.available && (
        <div className="ops-notice ops-notice-warning">
          <IconAlert size={16} /> {size.note ?? t('mon.sizeUnavailable')}
        </div>
      )}

      {size.available && (
        <>
          <div className="ops-disk-grid">
            <div className="ops-disk-fact">
              <span>{t('mon.dbWhole')}</span>
              <strong>{formatBytes(size.databaseBytes, t)}</strong>
              <small>{size.databaseName ?? 'postgres'}</small>
            </div>
            <div className="ops-disk-fact">
              <span>{t('mon.publicSchema')}</span>
              <strong>{formatBytes(size.schemaBytes, t)}</strong>
              <small>{t('mon.tablesIdxToast')}</small>
            </div>
            <div className="ops-disk-fact">
              <span>{t('mon.data')}</span>
              <strong>{formatBytes(size.tableBytes, t)}</strong>
              <small>{t('mon.withoutIndexes')}</small>
            </div>
            <div className="ops-disk-fact">
              <span>{t('mon.indexes')}</span>
              <strong>{formatBytes(size.indexBytes, t)}</strong>
              <small>{size.schemaBytes ? t('mon.pctOfSchema', { value: Math.round(((size.indexBytes ?? 0) / size.schemaBytes) * 100) }) : '—'}</small>
            </div>
            <div className="ops-disk-fact">
              <span>{t('mon.toast')}</span>
              <strong>{formatBytes(size.toastBytes, t)}</strong>
              <small>{t('mon.toastHint')}</small>
            </div>
            <div className="ops-disk-fact">
              <span>{t('mon.diskFree')}</span>
              <strong>{disk.available ? formatBytes(disk.availableBytes, t) : '—'}</strong>
              <small>{disk.available ? t('mon.diskUsageLine', { total: formatBytes(disk.totalBytes, t), percent: disk.usedPercent ?? 0 }) : t('mon.noStatfs')}</small>
            </div>
          </div>

          {disk.available && disk.availableBytes != null && disk.availableBytes < 5 * 1024 ** 3 && (
            <div className="ops-notice ops-notice-warning">
              <IconHardDrive size={16} /> {t('mon.diskWarning', { free: formatBytes(disk.availableBytes, t) })}
            </div>
          )}

          {size.largest.length > 0 ? (
            <>
              <div className="ops-subhead">{t("mon.topTables")}</div>
              <div className="ops-table-bars">
                {size.largest.map((table) => (
                  <div className="ops-table-bar" key={table.name}>
                    <div className="ops-table-bar-name" title={table.kind}>
                      {table.name}
                      <small>{table.liveRows != null ? t('mon.rowsCount', { count: formatCount(table.liveRows, locale) }) : '—'}</small>
                    </div>
                    <div className="ops-bar">
                      <div
                        className={`ops-bar-fill${table.totalBytes === biggest ? ' ops-bar-warn' : ''}`}
                        style={{ width: `${biggest > 0 ? Math.max(2, Math.round((table.totalBytes / biggest) * 100)) : 100}%` }}
                      />
                    </div>
                    <div className="ops-bar-text">
                      {formatBytes(table.totalBytes, t)}
                      {total > 0 ? ` · ${Math.round((table.totalBytes / total) * 100)}%` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="ops-empty">{t("mon.noTables")}</div>
          )}
          <div className="ops-measured">{t("mon.measuredAt", { when: formatDate(size.measuredAt, locale) })}</div>
        </>
      )}
    </section>
  );
}

export default function ServerMonitorTab() {
  const { t, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [updateConnected, setUpdateConnected] = useState(false);
  const [updateConfigured, setUpdateConfigured] = useState(false);
  const [updateReason, setUpdateReason] = useState<string | null>(null);
  // Флажки «Обновление проекта»: что именно входит в прогон — тесты, бэкап
  // БД и накат миграций. Передаются в агент вместе с confirm при запуске.
  const [applyMigrations, setApplyMigrations] = useState(true);
  const [runTests, setRunTests] = useState(true);
  const [backupBefore, setBackupBefore] = useState(true);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [agentRestarting, setAgentRestarting] = useState(false);
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
      const nextAgent = data.agent ?? null;
      setAgentInfo(nextAgent);
      if (data.update) {
        const fresh = data.update;
        setUpdate((previous) => mergeUpdate(previous, fresh));
      }
      return nextAgent;
    } catch {
      setUpdateConnected(false);
      return null;
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
      setError(cause instanceof Error ? cause.message : t('mon.statusFailed'));
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
    const migrationNote = pending ? t('mon.migrationsPendingNote', { count: pending }) : '';
    const options = [
      runTests ? t('mon.optRunTests') : t('mon.optSkipTests'),
      backupBefore ? t('mon.optBackup') : t('mon.optNoBackup'),
      applyMigrations ? t('mon.optMigrate') : t('mon.optNoMigrate'),
    ].join(' · ');
    const confirmText = t('mon.rebuildConfirm', {
      commits: ahead ? t('mon.freshCommitsNote', { count: ahead }) : '',
      migrations: migrationNote,
      options,
    });
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
      if ('update' in data && data.update) { const fresh = data.update; setUpdate((previous) => mergeUpdate(previous, fresh)); }
      setUpdateMessage(t('mon.updateStarted'));
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : t('mon.updateStartFailed'));
    } finally {
      setUpdateBusy(false);
    }
  }, [applyMigrations, backupBefore, runTests, snapshot]);

  // «Применить только миграции»: синхронизация исходников + накат миграций
  // (с бэкапом, если отмечен флажок), без сборки и переключения контейнеров.
  const startMigrationsOnly = useCallback(async () => {
    const pending = snapshot?.project.pendingMigrations.length ?? 0;
    const options = backupBefore ? t('mon.optBackup') : t('mon.optNoBackup');
    const confirmText = [
      t('mon.migrateConfirm', { migrations: pending ? ` (${pending})` : '' }),
      t('mon.migrateSync', { branch: snapshot?.project.upstreamBranch ?? 'main' }),
      t('mon.migrateOptions', { options }),
    ].join('\n');
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
      if ('update' in data && data.update) { const fresh = data.update; setUpdate((previous) => mergeUpdate(previous, fresh)); }
      setUpdateMessage(t('mon.migrationsStarted'));
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : t('mon.migrationsStartFailed'));
    } finally {
      setUpdateBusy(false);
    }
  }, [backupBefore, snapshot]);

  const abortUpdate = useCallback(async () => {
    if (!window.confirm(t('mon.stopConfirm'))) return;
    setUpdateBusy(true);
    try {
      const response = await authFetch('/api/admin/monitor/update', { method: 'DELETE' });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok) throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      if ('update' in data && data.update) { const fresh = data.update; setUpdate((previous) => mergeUpdate(previous, fresh)); }
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : t('mon.stopFailed'));
    } finally {
      setUpdateBusy(false);
    }
  }, []);

  /**
   * Перезапуск update-agent из панели.
   *
   * Нужен для старых/host-run установок, где автоматическая безопасная замена
   * контейнера не сработала. В Docker обычный полный update запускает такую
   * замену detached helper-ом после health-check.
   */
  const restartAgent = useCallback(async () => {
    if (!window.confirm(t('mon.agentRestartConfirm'))) return;
    const previousStartedAt = agentInfo?.startedAt ?? null;
    setAgentRestarting(true);
    setUpdateMessage('');
    try {
      const response = await authFetch('/api/admin/monitor/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      });
      const data = await response.json().catch(() => ({})) as UpdateResponse;
      if (!response.ok) throw new Error(('error' in data && data.error) || `HTTP ${response.status}`);
      setUpdateMessage(t('mon.agentRestartMsg'));

      // Агент отвечает до выхода с задержкой, затем Docker/systemd ещё нужно
      // несколько секунд на запуск. Один прежний таймер на 6 с срабатывал
      // слишком рано и оставлял в панели старое предупреждение навсегда.
      let restarted = false;
      for (const delayMs of [4_000, 6_000, 8_000, 10_000]) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        const freshAgent = await loadUpdate();
        if (freshAgent && freshAgent.startedAt !== previousStartedAt) {
          restarted = true;
          break;
        }
      }
      setUpdateMessage(restarted
        ? t('mon.agentRestarted')
        : t('mon.agentRestartNoAnswer'));
    } catch (cause) {
      setUpdateMessage(cause instanceof Error ? cause.message : t('mon.agentRestartFailed'));
    } finally {
      setAgentRestarting(false);
    }
  }, [agentInfo?.startedAt, loadUpdate]);

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
        setContentMessage(t('mon.contentSyncLine', {
          new: Number(data.inserted ?? 0),
          updated: Number(data.updated ?? 0),
          translated: Number(data.translated ?? 0),
          pending: Number(data.pendingGalnetTranslations ?? 0),
        }));
      } else {
        setContentMessage(t('mon.contentTranslateLine', {
          processed: Number(data.processed ?? 0),
          translated: Number(data.translated ?? 0),
          failed: Number(data.failed ?? 0),
        }));
      }
      void load();
    } catch (cause) {
      setContentMessage(cause instanceof Error ? cause.message : t('mon.pipelineUnavailable'));
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

  // Когда применение ключей (или настроек почты — они тоже меняют .env сайта)
  // завершилось, список пересобираем сразу.
  const envJobFinished = (update?.kind === 'env' || update?.kind === 'smtp') && update.active === false && update.state !== 'idle';
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
      setEnvMessage(t('mon.envKeySaved', { name: editingKey.name }));
      setEditingKey(null);
      void loadEnvKeys();
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : t('mon.envSaveFailed'));
    } finally {
      setEnvBusy('');
    }
  }, [editingKey, loadEnvKeys]);

  const addEnvKey = useCallback(async () => {
    const key = newKeyName.trim();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) {
      setEnvMessage(t('mon.envNameRule'));
      return;
    }
    if (!newKeyValue) {
      setEnvMessage(t('mon.envValueRequired'));
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
      setEnvMessage(t('mon.envKeyStored', { name: key, action: data.created ? t('mon.envAdded') : t('mon.envUpdated') }));
      setNewKeyName('');
      setNewKeyValue('');
      void loadEnvKeys();
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : t('mon.envAddFailed'));
    } finally {
      setEnvBusy('');
    }
  }, [newKeyName, newKeyValue, loadEnvKeys]);

  const removeEnvKey = useCallback(async (name: string) => {
    if (!window.confirm(t('mon.envDeleteConfirm', { name }))) return;
    setEnvBusy('delete');
    setEnvMessage('');
    try {
      const response = await authFetch(`/api/admin/env?key=${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setEnvMessage(t('mon.envKeyDeleted', { name }));
      void loadEnvKeys();
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : t('mon.envDeleteFailed'));
    } finally {
      setEnvBusy('');
    }
  }, [loadEnvKeys]);

  const applyEnvKeys = useCallback(async () => {
    const target = applyAll ? t('mon.scopeAll') : 'web';
    if (!window.confirm(t('mon.envApplyConfirm', { target }))) return;
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
      if (data.update) { const fresh = data.update; setUpdate((previous) => mergeUpdate(previous, fresh)); }
      setEnvMessage(t('mon.envApplyStarted'));
    } catch (cause) {
      setEnvMessage(cause instanceof Error ? cause.message : t('mon.envApplyFailed'));
    } finally {
      setEnvBusy('');
    }
  }, [applyAll]);

  const dashboard = snapshot && (
    <>
      <section className="ops-summary-grid" aria-label={t('mon.ariaSummary')}>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconActivity size={16} /> {t('mon.app')}</div>
          <StatusPill level="healthy" label={t('mon.responding')} />
          <div className="ops-summary-value">{formatDuration(snapshot.application.uptimeSeconds, t)}</div>
          <div className="ops-summary-note">{t('mon.uptimeNode', { version: snapshot.application.nodeVersion })}</div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconPackage size={16} /> {t('mon.database')}</div>
          <StatusPill level={snapshot.database.status} label={snapshot.database.status === 'healthy' ? t('mon.available') : undefined} />
          <div className="ops-summary-value">{snapshot.database.latencyMs == null ? '—' : t('mon.msValue', { value: snapshot.database.latencyMs })}</div>
          <div className="ops-summary-note">
            {snapshot.database.configured ? t('mon.viaRest') : t('mon.noServiceKey')}
          </div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconDatabase size={16} /> {t('mon.diskSpace')}</div>
          <StatusPill level={sizeLevel(snapshot.database.size)} label={snapshot.database.size.available ? formatBytes(snapshot.database.size.databaseBytes, t) : t('mon.noDataShort')} />
          <div className="ops-summary-value">{formatBytes(snapshot.database.size.schemaBytes, t)}</div>
          <div className="ops-summary-note">
            {t('mon.schemaFreePublic', { free: snapshot.disk.available ? t('mon.freeSpaceShort', { free: formatBytes(snapshot.disk.availableBytes, t) }) : t('mon.diskFreeUnavailable') })}
          </div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconActivity size={16} /> Docker</div>
          <StatusPill
            level={!snapshot.agent.connected ? 'unknown' : !snapshot.docker.available ? 'critical' : snapshot.docker.containers.some((item) => containerLevel(item) === 'critical') ? 'critical' : snapshot.docker.containers.some((item) => containerLevel(item) === 'warning') ? 'warning' : 'healthy'}
            label={!snapshot.agent.connected ? t('mon.agentUnavailable') : !snapshot.docker.available ? t('mon.noAccess') : undefined}
          />
          <div className="ops-summary-value">{snapshot.docker.containers.length || '—'}</div>
          <div className="ops-summary-note">{t("mon.projectContainers")}</div>
        </article>
        <article className="ops-summary-card">
          <div className="ops-summary-heading"><IconClock size={16} /> {t('mon.updates')}</div>
          <StatusPill level={projectLevel(snapshot)} />
          <div className="ops-summary-value ops-summary-sha">{shortSha(snapshot.project.currentSha, t)}</div>
          <div className="ops-summary-note">
            {snapshot.project.aheadBy ? t('mon.freshCommitsShort', { count: snapshot.project.aheadBy }) : t('mon.currentBuild')}
          </div>
        </article>
      </section>

      <div className="ops-grid">
        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>{t('mon.dockerTitle')}</h3>
              <p>{t('mon.dockerNote')}</p>
            </div>
            {snapshot.agent.connected && snapshot.docker.available && <StatusPill level="healthy" label={t('mon.agentConnected')} />}
          </div>
          {!snapshot.agent.configured && (
            <div className="ops-notice ops-notice-warning">
              <IconAlert size={16} /> {t('mon.dockerMonitorOff')}
            </div>
          )}
          {snapshot.agent.configured && !snapshot.agent.connected && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> {t('mon.agentNoResponse')}
            </div>
          )}
          {snapshot.agent.connected && !snapshot.docker.available && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> {t('mon.dockerDaemonDown')}
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
                        <div className="ops-container-detail">{containerLabel(container, t)}</div>
                      </div>
                      <StatusPill level={level} />
                    </div>
                    <dl className="ops-facts">
                      <div><dt>{t('mon.startedLabel')}</dt><dd>{formatDate(container.startedAt, locale)}</dd></div>
                      <div><dt>{t('mon.restarts')}</dt><dd>{container.restartCount}</dd></div>
                      <div><dt>{t('mon.memory')}</dt><dd>{container.metrics ? `${formatBytes(container.metrics.memoryBytes, t)}${container.metrics.memoryLimitBytes ? ` / ${formatBytes(container.metrics.memoryLimitBytes, t)}` : ''}` : '—'}</dd></div>
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
              <h3>{t('mon.jobsTitle')}</h3>
              <p>{t('mon.jobsNote')}</p>
            </div>
            <StatusPill
              level={!snapshot.scheduler.available ? 'unknown' : snapshot.scheduler.jobs.some((job) => job.status === 'warning') ? 'warning' : snapshot.scheduler.jobs.every((job) => job.status === 'healthy') && snapshot.scheduler.jobs.length ? 'healthy' : 'unknown'}
              label={snapshot.scheduler.available ? undefined : t('mon.noStateFile')}
            />
          </div>
          {!snapshot.agent.connected ? (
            <div className="ops-empty">{t("mon.connectAgent")}</div>
          ) : !snapshot.scheduler.available ? (
            <div className="ops-empty">{t("mon.schedulerNoState")}</div>
          ) : snapshot.scheduler.jobs.length === 0 ? (
            <div className="ops-empty">{t("mon.noJobsEnabled")}</div>
          ) : (
            <div className="ops-jobs-list">
              {snapshot.scheduler.jobs.map((job) => {
                const failing = !!job.lastError && !!job.lastFailureAt;
                return (
                  <article className="ops-job-row" key={job.name}>
                    <div className="ops-job-name"><StatusPill level={jobLevel(job)} /> <code>{job.name}</code></div>
                    {failing && (
                      <div className="ops-job-fact ops-job-error" title={job.lastError ?? undefined}>
                        <span>{t('mon.lastError')}</span>
                        <strong>{job.lastError}</strong>
                      </div>
                    )}
                    {failing && (
                      <div className="ops-job-fact">
                        <span>{t('mon.failure')}</span>
                        <strong>{formatDate(job.lastFailureAt ?? null, locale)}{job.failures ? t('mon.consecutive', { count: job.failures }) : ''}</strong>
                      </div>
                    )}
                    <div className="ops-job-fact"><span>{t('mon.lastSuccess')}</span><strong>{formatDate(job.lastSuccessAt, locale)}</strong></div>
                    <div className="ops-job-fact"><span>{t('mon.age')}</span><strong>{formatDuration(job.ageSeconds, t)}</strong></div>
                    <div className="ops-job-fact"><span>{t('mon.nextSlot')}</span><strong>{formatDate(job.nextRunAt, locale)}</strong></div>
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
            <h3>{t('mon.contentTitle')}</h3>
            <p>{t('mon.contentNote')}</p>
          </div>
          <StatusPill
            level={!snapshot.content.available ? 'unknown' : snapshot.content.lastSync?.status === 'error' ? 'critical' : (snapshot.content.pendingTotal ?? 0) > 0 ? 'warning' : 'healthy'}
            label={snapshot.content.available ? undefined : t('mon.levelUnknown')}
          />
        </div>
        {!snapshot.content.available && (
          <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {snapshot.content.note ?? t('mon.queueUnavailable')}</div>
        )}
        {snapshot.content.available && (
          <>
            <div className="ops-disk-grid">
              <div className="ops-disk-fact">
                <span>{t('mon.lastSync')}</span>
                <strong>{formatDate(snapshot.content.lastSync?.at, locale)}</strong>
                <small>{snapshot.content.lastSync ? t('mon.syncDetail', { status: snapshot.content.lastSync.status ?? '—', articles: snapshot.content.lastSync.articlesCount ?? 0, new: snapshot.content.lastSync.newCount ?? 0 }) : t('mon.noRecords')}</small>
              </div>
              <div className="ops-disk-fact">
                <span>{t('mon.galnetPending')}</span>
                <strong>{formatCount(snapshot.content.queue.find((item) => item.table === 'galnet_news')?.pending, locale)}</strong>
                <small>pending / failed / partial</small>
              </div>
              <div className="ops-disk-fact">
                <span>{t('mon.newsPending')}</span>
                <strong>{formatCount(snapshot.content.queue.find((item) => item.table === 'news')?.pending, locale)}</strong>
                <small>{t('mon.newsTable')}</small>
              </div>
              <div className="ops-disk-fact">
                <span>Yandex Translate</span>
                <strong>{snapshot.content.translateConfigured ? t('mon.configured') : t('mon.notSetLabel')}</strong>
                <small>YANDEX_TRANSLATE_API_KEY</small>
              </div>
            </div>
            {snapshot.content.lastSync?.error && (
              <div className="ops-notice ops-notice-warning"><IconAlert size={16} /> {snapshot.content.lastSync.error}</div>
            )}
            {!snapshot.content.translateConfigured && (
              <div className="ops-notice ops-notice-critical">
                <IconXCircle size={16} /> {t('mon.translateMissing')}
              </div>
            )}
            {snapshot.content.note && (
              <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {snapshot.content.note}</div>
            )}
            <div className="ops-update-actions">
              <button type="button" className="ops-refresh-button" disabled={contentBusy !== ''} onClick={() => void runContent('sync')}>
                <IconSync size={14} /> {contentBusy === 'sync' ? t('mon.syncShort') : t('mon.syncGalnet')}
              </button>
              <button type="button" className="ops-refresh-button" disabled={contentBusy !== ''} onClick={() => void runContent('translate')}>
                <IconRefresh size={14} /> {contentBusy === 'translate' ? t('mon.translateShort') : t('mon.translateCatchUp')}
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
              <h3>{t('mon.projectVersion')}</h3>
              <p>{t('mon.projectVersionNote', { branch: snapshot.project.upstreamBranch })}</p>
            </div>
            <StatusPill level={projectLevel(snapshot)} />
          </div>
          <div className="ops-project-grid">
            <div className="ops-project-item"><span>{t('mon.currentCommit')}</span><strong><code>{shortSha(snapshot.project.currentSha, t)}</code></strong></div>
            <div className="ops-project-item"><span>{t('mon.buildBranch')}</span><strong>{snapshot.project.currentRef ?? '—'}</strong></div>
            <div className="ops-project-item"><span>{t('mon.builtAt')}</span><strong>{formatDate(snapshot.project.builtAt, locale)}</strong></div>
            <div className="ops-project-item"><span>GitHub {snapshot.project.upstreamBranch}</span><strong><code>{shortSha(snapshot.project.upstreamSha, t)}</code></strong></div>
            <div className="ops-project-item"><span>{t('mon.freshCommitsCount')}</span><strong>{snapshot.project.aheadBy == null ? '—' : snapshot.project.aheadBy}</strong></div>
          </div>
          {snapshot.project.updateStatus === 'current' && (
            <div className="ops-notice ops-notice-healthy"><IconCheckCircle size={16} /> {t('mon.upToDate', { when: formatDate(snapshot.project.upstreamCheckedAt, locale) })}</div>
          )}
          {snapshot.project.updateStatus === 'different' && (
            <div className="ops-notice ops-notice-warning"><IconAlert size={16} /> {t('mon.upstreamDifferent')}</div>
          )}
          {snapshot.project.updateStatus === 'unknown' && (
            <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {t('mon.exactCheck')}</div>
          )}
        </section>

        <section className="ops-panel">
          <div className="ops-panel-head">
            <div>
              <h3>{t('mon.updateTitle')}</h3>
              <p>{t('mon.updateNote')}</p>
            </div>
            <StatusPill
              level={updateConnected ? (update ? stateMetaFor(update).level : 'unknown') : updateConfigured ? 'critical' : 'unknown'}
              label={updateConnected ? t(stateMetaFor(update).label) : updateConfigured ? t('mon.agentNoAnswerShort') : t('mon.agentNotConfigured')}
            />
          </div>

          {!updateConfigured && (
            <div className="ops-notice ops-notice-info">
              <IconAlert size={16} /> {t('mon.agentSetupHint')}
              <code> bash deploy/start-update-agent.sh</code>.
            </div>
          )}
          {updateConfigured && !updateConnected && (
            <div className="ops-notice ops-notice-critical">
              <IconXCircle size={16} /> {updateReason || t('mon.agentUnavailableLong')}
            </div>
          )}
          {updateConnected && agentInfo?.outdated === true && (
            <div className="ops-notice ops-notice-warning">
              <IconAlert size={16} />
              <span>
                {t('mon.agentPrevCode')}
                {agentInfo.revision && agentInfo.repoRevision && agentInfo.revision !== agentInfo.repoRevision
                  ? t('mon.agentRevision', { revision: agentInfo.revision, repo: agentInfo.repoRevision })
                  : ''}
                {t('mon.agentFlagsNote')}
                {agentInfo.migrationsOnlySupported ? '' : t('mon.agentMigrationsNote')}
                {t('mon.agentFlagsTail')}
                {agentInfo.canRestart
                  ? agentInfo.autoRestart
                    ? t('mon.agentSelfRestartOn')
                    : t('mon.agentSelfRestartOff')
                  : t('mon.agentNoRestartSupport')}
              </span>
              {agentInfo.canRestart && (
                <button
                  type="button"
                  className="ops-refresh-button"
                  disabled={updateBusy || agentRestarting || update?.active === true}
                  onClick={() => void restartAgent()}
                >
                  <IconRefresh size={14} /> {agentRestarting ? t('mon.restarting') : t('mon.restartAgent')}
                </button>
              )}
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
                <div><dt>{t('mon.stage')}</dt><dd>{update.stageLabel || update.stage || '—'}</dd></div>
                <div><dt>{t('mon.startLabel')}</dt><dd>{formatDate(update.startedAt, locale)}</dd></div>
                <div><dt>{t('mon.updatedLabel')}</dt><dd>{formatDate(update.updatedAt, locale)}</dd></div>
                {update.kind === 'env' ? (
                  <div><dt>{t('mon.scope')}</dt><dd>{update.mode === 'all' ? 'web + jobs + monitor-agent' : 'web'}</dd></div>
                ) : update.kind === 'smtp' ? (
                  <div><dt>{t('mon.scope')}</dt><dd>auth (Supabase) + web</dd></div>
                ) : update.kind === 'storage' ? (
                  <div><dt>{t('mon.scope')}</dt><dd>{t('mon.storageScope')}</dd></div>
                ) : (
                  <>
                    <div><dt>{t('mon.mode')}</dt><dd>{update.mode === 'migrations' ? t('mon.migrationsOnlyMode') : update.mode || '—'}</dd></div>
                    <div><dt>{t('mon.revision')}</dt><dd>{update.fromSha ? `${update.fromSha.slice(0, 12)} → ${(update.toSha || '').slice(0, 12)}` : '—'}</dd></div>
                    <div><dt>{t('mon.migrationsApplied')}</dt><dd>{update.migrationsApplied ?? 0}</dd></div>
                  </>
                )}
              </dl>
              {update.message && update.state !== 'failed' && (
                <div className="ops-inline-note ops-inline-progress">{update.message}</div>
              )}
              {(update.error || update.state === 'failed') && (
                <div className={`ops-notice ${update.state === 'failed' ? 'ops-notice-critical' : 'ops-notice-warning'}`}>
                  <IconAlert size={16} />
                  <span>
                    {update.error || t('mon.runFailed')}
                    {update.exitCode != null ? t('mon.exitCodeNote', { code: update.exitCode }) : ''}
                  </span>
                </div>
              )}
              {update.log.length > 0 && (
                <pre className="ops-log" ref={logRef}>
                  {update.log.map((entry, index) => (
                    <div key={`${entry.at ?? ''}-${index}`}>
                      {entry.at ? <time>{new Date(entry.at).toLocaleTimeString(locale)}</time> : null}
                      {entry.line}
                    </div>
                  ))}
                </pre>
              )}
            </>
          )}

          {snapshot.project.pendingMigrations.length > 0 && (
            <div className="ops-migrations">
              <span>{t('mon.pendingMigrations')}</span>
              {snapshot.project.pendingMigrations.map((name) => <code key={name}>{name}</code>)}
            </div>
          )}

          <div className="ops-update-actions">
            <label title={t('mon.flagTestsTitle')}>
              <input type="checkbox" checked={runTests} onChange={(event) => setRunTests(event.target.checked)} />
              {t('mon.flagWithTests')}
            </label>
            <label title={t('mon.flagBackupTitle')}>
              <input type="checkbox" checked={backupBefore} onChange={(event) => setBackupBefore(event.target.checked)} />
              {t('mon.flagWithBackup')}
            </label>
            <label title={t('mon.flagMigrationsTitle')}>
              <input type="checkbox" checked={applyMigrations} onChange={(event) => setApplyMigrations(event.target.checked)} />
              {t('mon.flagWithMigrations')}
            </label>
          </div>

          <div className="ops-update-actions">
            <button
              type="button"
              className="ops-button-primary"
              disabled={!updateConnected || updateBusy || agentRestarting || update?.active === true}
              onClick={() => void startUpdate()}
            >
              <IconRefresh size={14} />
              {updateBusy ? t('mon.startingApply') : update?.active ? t('mon.updatingNow') : t('mon.updateNow')}
            </button>
            <button
              type="button"
              className="ops-refresh-button"
              title={t('mon.applyMigrationsTitle')}
              disabled={!updateConnected || updateBusy || agentRestarting || update?.active === true}
              onClick={() => void startMigrationsOnly()}
            >
              <IconDatabase size={14} /> {t('mon.applyMigrations')}
            </button>
            {update?.active === true && (
              <button type="button" className="ops-refresh-button ops-button-danger" disabled={updateBusy} onClick={() => void abortUpdate()}>
                <IconXCircle size={14} /> {t('mon.stop')}
              </button>
            )}
            {snapshot.project.updateStatus === 'current' && (
              <span className="ops-inline-note">
                {t('mon.noBehind', { branch: snapshot.project.upstreamBranch })}
              </span>
            )}
            {updateMessage && <span className="ops-inline-note">{updateMessage}</span>}
          </div>
        </section>
      </div>

      <StorageHealthPanel
        agentConfigured={updateConfigured}
        agentConnected={updateConnected}
        // Конец задачи kind=storage — повод перечитать состояние сразу.
        refreshToken={update?.kind === 'storage' && update.active === false ? update.finishedAt : null}
        onStarted={() => void loadUpdate()}
      />

      <section className="ops-panel">
        <div className="ops-panel-head">
          <div>
            <h3><IconKey size={15} /> {t('mon.envTitle')}</h3>
            <p>
              {t('mon.envNote1')} <code>NEXT_PUBLIC_*</code> {t('mon.envNote2')}
            </p>
          </div>
          <StatusPill
            level={!updateConfigured ? 'unknown' : envKeys == null ? 'unknown' : envConfigured ? 'healthy' : 'critical'}
            label={!updateConfigured ? t('mon.agentNotConfigured') : envKeys == null ? t('mon.levelUnknown') : envConfigured ? t('mon.keysCount', { count: envKeys.length }) : t('mon.envFileMissing')}
          />
        </div>

        {!updateConfigured && (
          <div className="ops-notice ops-notice-info">
            <IconAlert size={16} /> {t('mon.envManageHint')}
          </div>
        )}
        {updateConfigured && envKeys == null && (
          <div className="ops-notice ops-notice-info"><IconAlert size={16} /> {t('mon.envAgentNoAnswer')}</div>
        )}
        {updateConfigured && envKeys != null && !envConfigured && (
          <div className="ops-notice ops-notice-critical">
            <IconXCircle size={16} /> {t('mon.envFileWillBeCreated')}
          </div>
        )}

        {updateConfigured && envKeys != null && envConfigured && (
          <>
            {envKeys.length === 0 ? (
              <div className="ops-empty">{t("mon.envNoKeys")}</div>
            ) : (
              <div className="ops-env-list">
                {envKeys.map((key) => (
                  <div className="ops-env-row" key={key.name}>
                    <code className="ops-env-name">{key.name}</code>
                    <span className="ops-env-masked" title={t('mon.envRawHidden')}>{key.masked}</span>
                    <div className="ops-env-actions">
                      {editingKey?.name === key.name ? (
                        <>
                          <input
                            type="password"
                            className="ops-env-input"
                            value={editingKey.value}
                            placeholder={t('mon.envNewValue')}
                            onChange={(event) => setEditingKey({ ...editingKey, value: event.target.value })}
                          />
                          <button type="button" disabled={envBusy !== '' || !editingKey.value} onClick={() => void saveEnvKeyEdit()}>
                            {envBusy === 'save' ? t('mon.saving') : t('mon.save')}
                          </button>
                          <button type="button" disabled={envBusy !== ''} onClick={() => setEditingKey(null)}>{t('mon.cancel')}</button>
                        </>
                      ) : (
                        <>
                          <button type="button" disabled={envBusy !== ''} onClick={() => setEditingKey({ name: key.name, value: '' })}>
                            {t('mon.edit')}
                          </button>
                          <button type="button" disabled={envBusy !== ''} onClick={() => void removeEnvKey(key.name)}>
                            {envBusy === 'delete' ? t('mon.deleting') : t('mon.delete')}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="ops-env-add">
              <div className="ops-env-add-title">{t("mon.envAddTitle")}</div>
              <div className="ops-env-add-row">
                <select
                  className="ops-env-input"
                  value={newKeyName}
                  onChange={(event) => setNewKeyName(event.target.value)}
                >
                  <option value="">{t('mon.envPickKey')}</option>
                  {KNOWN_ENV_KEYS
                    .filter((known) => !envKeys.some((key) => key.name === known.name))
                    .map((known) => (
                      <option key={known.name} value={known.name} title={t(known.hint)}>
                        {known.name} — {t(known.hint)}
                      </option>
                    ))}
                </select>
                <input
                  className="ops-env-input"
                  value={newKeyName}
                  placeholder={t('mon.envCustomName')}
                  onChange={(event) => setNewKeyName(event.target.value.toUpperCase())}
                />
                <input
                  type="password"
                  className="ops-env-input"
                  value={newKeyValue}
                  placeholder={t('mon.envValue')}
                  onChange={(event) => setNewKeyValue(event.target.value)}
                />
                <button type="button" className="ops-refresh-button" disabled={envBusy !== ''} onClick={() => void addEnvKey()}>
                  <IconPlus size={14} /> {envBusy === 'add' ? t('mon.adding') : t('mon.addKey')}
                </button>
              </div>
            </div>

            {((update?.kind === 'env' || update?.kind === 'smtp') && update.active === true) && (
              <div className="ops-env-applying">
                <div className="ops-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent || 0)}>
                  <div className="ops-progress-fill" style={{ width: `${Math.max(2, Math.min(100, Math.round(update.percent || 0)))}%` }} />
                </div>
                <div className="ops-inline-note">
                  {update.stageLabel || t('mon.applyingKeys')} — {Math.round(update.percent || 0)}%
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
                {envBusy === 'apply' || ((update?.kind === 'env' || update?.kind === 'smtp') && update.active === true)
                  ? t('mon.applying')
                  : t('mon.applyRecreateWeb')}
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
        <h3>{t('mon.techTitle')}</h3>
        <dl className="ops-facts ops-technical-facts">
          <div><dt>{t('mon.appStarted')}</dt><dd>{formatDate(snapshot.application.startedAt, locale)}</dd></div>
          <div><dt>{t('mon.processMemory')}</dt><dd>{formatBytes(snapshot.application.memory.rssBytes, t)} RSS · {formatBytes(snapshot.application.memory.heapUsedBytes, t)} heap</dd></div>
          <div><dt>{t('mon.dbCheck')}</dt><dd>{snapshot.database.latencyMs == null ? t('mon.noAnswer') : t('mon.msValue', { value: snapshot.database.latencyMs })}</dd></div>
          <div><dt>{t('mon.dbSize')}</dt><dd>{snapshot.database.size.available ? `${formatBytes(snapshot.database.size.databaseBytes, t)} · ${t('mon.measuredShort', { when: formatDate(snapshot.database.size.measuredAt, locale) })}` : t('mon.noDirectConn')}</dd></div>
          <div><dt>{t('mon.disk')}</dt><dd>{snapshot.disk.available ? t('mon.diskLine', { used: formatBytes(snapshot.disk.usedBytes, t), total: formatBytes(snapshot.disk.totalBytes, t), free: formatBytes(snapshot.disk.availableBytes, t) }) : t('mon.noStatfs')}</dd></div>
          <div><dt>{t('mon.updatedLabel')}</dt><dd>{formatDate(snapshot.checkedAt, locale)}</dd></div>
        </dl>
      </section>
    </>
  );

  return (
    <div className="ops-monitor">
      <div className="ops-monitor-header">
        <div>
          <div className="ops-kicker">Operations center</div>
          <h2>{t('mon.title')}</h2>
          <p>{t('mon.subtitle')}</p>
        </div>
        <div className="ops-header-actions">
          {snapshot && <StatusPill level={snapshot.overall} label={t(LEVEL_META[snapshot.overall].label)} />}
          <label className="ops-auto-refresh">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            {t('mon.autoRefresh')}
          </label>
          <button type="button" className="ops-refresh-button" disabled={loading} onClick={() => void load()}>
            <IconRefresh size={14} /> {loading ? t('mon.refreshing') : t('mon.refresh')}
          </button>
        </div>
      </div>
      {error && <div className="ops-notice ops-notice-critical"><IconXCircle size={16} /> {error}</div>}
      {!snapshot && !error && <div className="ops-loading">{t("mon.collecting")}</div>}
      {dashboard}
    </div>
  );
}
