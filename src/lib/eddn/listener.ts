/**
 * Живые данные EDDN → слои PowerPlay и фракций (web 2.23.0, по желанию).
 *
 * Зачем. Ночной дамп EDSM не знает владельца системы PowerPlay
 * (`ControllingPower`): у спорных систем он перечисляет все державы, чьи зоны
 * их накрывают. Владельца знает журнал игры — его шлют в EDDN тысячи пилотов
 * (EDMC, EDDiscovery и т. д.); оттуда же данные у EDSM, Spansh и Inara.
 * Слушатель берёт из потока EDDN прыжки и входы в игру (FSDJump, Location,
 * CarrierJump) и отдаёт их тому же разбору, что журналы Colonial Helper и
 * сайта (`systemObservations.applySystemObservations`, источник `eddn`):
 * владелец PowerPlay, состояние и фракции системы — одним наблюдением.
 *
 * Как устроено:
 *   * подписка ZeroMQ без нативных модулей (`zmtp.ts`) на всё реле: EDDN не
 *     фильтрует по схеме на своей стороне (≈2–5 ГБ трафика в сутки);
 *   * берутся только журналы живой игры (gameversion 4.x и CAPI-Live):
 *     у Legacy (3.8) PowerPlay 1.0 с теми же названиями полей;
 *   * наблюдения копятся по системе (последнее) и записываются пачкой раз в
 *     минуту — не тысячами отдельных запросов;
 *   * сторож тишины: реле шлёт непрерывно, и если байтов нет `stallMs`, сессия
 *     закрывается и открывается новая. Это и защита от «заморозки» ТСПУ —
 *     провайдер молча перестаёт пропускать трафик долгого соединения к
 *     зарубежному хостингу, — и её диагностика: в журнале видно, сколько
 *     данных успевает прийти до замирания;
 *   * переподключение: после тишины — через 3 с, после ошибки — с нарастающей
 *     паузой до 5 минут.
 *
 * Включает и выключает администратор (Админка → Игровые данные → PowerPlay);
 * флаг — в `eddn_listener_state.enabled`, поэтому слушатель поднимается снова
 * после перезапуска сайта: задачей `eddn-listener` (раз в 5 минут) и при
 * открытии слоя PowerPlay. `EDDN_LISTENER=off` запрещает запуск совсем.
 *
 * Состояние — в globalThis: маршруты Next собраны отдельными бандлами, у
 * каждого своя копия модуля (как у импорта PowerPlay).
 */

import { inflateSync } from 'node:zlib';
import { applySystemObservations, type SystemObservationsResult } from '../systemObservations.ts';
import { pushPowerplayLog, sanitizePowerplayLog, type PowerplayLogLevel, type PowerplayLogLine } from '../powerplayProgress.ts';
import { zmtpSubscribe, type ZmtpCloseInfo, type ZmtpSession, type ZmtpSubscribeOptions } from './zmtp.ts';

type Svc = any;

export const EDDN_DEFAULT_RELAY = 'tcp://eddn.edcd.io:9500';
export const EDDN_JOURNAL_SCHEMA = 'https://eddn.edcd.io/schemas/journal/1';
const OBSERVATION_EVENTS = new Set(['FSDJump', 'Location', 'CarrierJump']);

const DEFAULT_STALL_MS = 30_000;
const DEFAULT_FLUSH_MS = 60_000;
const FLUSH_MAX_SYSTEMS = 1500;
/** Запись зависла (база не отвечает) — дальше этого очередь не растёт, лишнее отбрасывается. */
const PENDING_HARD_LIMIT = FLUSH_MAX_SYSTEMS * 5;
const PERSIST_EVERY_MS = 30_000;
const WATCHDOG_MS = 5_000;
const RECONNECT_AFTER_STALL_MS = 3_000;
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const LOG_LIMIT = 120;
/** Как часто слой PowerPlay может проверить флаг «включено» (после перезапуска сайта). */
const ENSURE_EVERY_MS = 5 * 60_000;

export type EddnListenerStatus = 'off' | 'connecting' | 'connected' | 'waiting';

export interface EddnListenerStats {
  startedAt: string | null;
  connectedAt: string | null;
  lastMessageAt: string | null;
  lastFlushAt: string | null;
  /** Попыток соединения и удачных рукопожатий. */
  attempts: number;
  sessions: number;
  /** Сессий, закрытых сторожем тишины. */
  stalls: number;
  /** Сколько байт пришло в последней закрытой сессии (диагностика «заморозки»). */
  lastSessionBytes: number;
  bytes: number;
  messages: number;
  /** Сообщения схемы journal/1 живой игры. */
  journal: number;
  /** Прыжки и входы в игру, ушедшие в слои. */
  observations: number;
  /** overflow — очередь переполнена, пока запись в базу висит. */
  skipped: { legacy: number; test: number; broken: number; other: number; overflow: number };
  powerplay: { applied: number; created: number; resolved: number; vacated: number; stale: number };
  factions: { applied: number; created: number; stale: number };
  flushes: number;
  flushErrors: number;
}

export interface EddnListenerSnapshot {
  running: boolean;
  status: EddnListenerStatus;
  relay: string;
  stats: EddnListenerStats;
  log: PowerplayLogLine[];
  error: string | null;
  nextAttemptAt: string | null;
  /** Систем в очереди на запись. */
  pending: number;
}

export interface EddnListenerOptions {
  relay?: string;
  stallMs?: number;
  flushMs?: number;
  /** Пауза перед новой сессией после «тишины» (по умолчанию 3 с). */
  reconnectMs?: number;
  /** Для тестов: соединение вместо `net.connect` и запись наблюдений. */
  connect?: ZmtpSubscribeOptions['connect'];
  apply?: (svc: Svc, events: Record<string, unknown>[]) => Promise<SystemObservationsResult>;
  /** Для тестов: не писать состояние в базу. */
  persist?: boolean;
}

function emptyStats(): EddnListenerStats {
  return {
    startedAt: null,
    connectedAt: null,
    lastMessageAt: null,
    lastFlushAt: null,
    attempts: 0,
    sessions: 0,
    stalls: 0,
    lastSessionBytes: 0,
    bytes: 0,
    messages: 0,
    journal: 0,
    observations: 0,
    skipped: { legacy: 0, test: 0, broken: 0, other: 0, overflow: 0 },
    powerplay: { applied: 0, created: 0, resolved: 0, vacated: 0, stale: 0 },
    factions: { applied: 0, created: 0, stale: 0 },
    flushes: 0,
    flushErrors: 0,
  };
}

/** `tcp://host:port` → адрес; неверное значение — реле EDDN по умолчанию. */
export function parseRelay(value: string | null | undefined): { host: string; port: number; url: string } {
  const match = /^tcp:\/\/([^:/\s]+):(\d{1,5})\/?$/.exec(String(value ?? '').trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || !(port > 0 && port < 65536)) return parseRelay(EDDN_DEFAULT_RELAY);
  return { host: match[1], port, url: `tcp://${match[1]}:${port}` };
}

export function eddnRelay(env: Record<string, string | undefined> = process.env): string {
  return parseRelay(env.EDDN_RELAY).url;
}

/** `EDDN_LISTENER=off` (или 0/false/no) — слушателя на этом сервере не будет. */
export function eddnListenerForbidden(env: Record<string, string | undefined> = process.env): boolean {
  return /^(off|0|false|no|disabled?)$/i.test(String(env.EDDN_LISTENER ?? '').trim());
}

function envMs(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export type EddnSkip = 'legacy' | 'test' | 'broken' | 'other';

/**
 * Конверт EDDN → событие журнала для слоёв или причина пропуска. Берутся
 * только FSDJump / Location / CarrierJump схемы journal/1 из живой игры.
 */
export function eddnObservation(payload: unknown): { event: Record<string, unknown> } | { skip: EddnSkip } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { skip: 'broken' };
  const envelope = payload as Record<string, unknown>;
  const schema = typeof envelope.$schemaRef === 'string' ? envelope.$schemaRef : '';
  if (/\/test$/i.test(schema)) return { skip: 'test' };
  if (schema !== EDDN_JOURNAL_SCHEMA) return { skip: 'other' };
  const header = (envelope.header && typeof envelope.header === 'object' ? envelope.header : {}) as Record<string, unknown>;
  const version = typeof header.gameversion === 'string' ? header.gameversion.trim() : '';
  // Legacy (3.8) пишет PowerPlay 1.0 теми же полями; без версии — неизвестно что.
  const major = /^(\d+)\./.exec(version);
  const live = /^CAPI-Live/i.test(version) || (major != null && Number(major[1]) >= 4 && !/legacy/i.test(version));
  if (!live) return { skip: 'legacy' };
  const message = envelope.message;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { skip: 'broken' };
  const event = message as Record<string, unknown>;
  if (!OBSERVATION_EVENTS.has(String(event.event))) return { skip: 'other' };
  return { event };
}

/** Сжатое сообщение реле → объект (null — не zlib или не JSON). */
export function decodeEddnFrame(frame: Buffer): unknown {
  try {
    return JSON.parse(inflateSync(frame).toString('utf8'));
  } catch {
    return null;
  }
}

function systemKey(event: Record<string, unknown>): string {
  const address = event.SystemAddress;
  if (typeof address === 'number' || typeof address === 'string') return String(address);
  return String(event.StarSystem ?? '').toLowerCase();
}

interface ListenerRuntime {
  svc: Svc;
  options: EddnListenerOptions;
  relay: { host: string; port: number; url: string };
  stallMs: number;
  flushMs: number;
  stopped: boolean;
  status: EddnListenerStatus;
  session: ZmtpSession | null;
  sessionStartedAt: number;
  lastDataAt: number;
  failures: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  watchdog: ReturnType<typeof setInterval> | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  flushing: Promise<void> | null;
  pending: Map<string, Record<string, unknown>>;
  stats: EddnListenerStats;
  log: PowerplayLogLine[];
  error: string | null;
  nextAttemptAt: number | null;
  persistedAt: number;
  noTable: boolean;
}

type ListenerGlobal = typeof globalThis & {
  edrcEddnListener?: ListenerRuntime | null;
  edrcEddnEnsureAt?: number;
};
const shared = globalThis as ListenerGlobal;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1).replace('.', ',')} КБ`;
  return `${(value / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function log(run: ListenerRuntime, level: PowerplayLogLevel, text: string): void {
  pushPowerplayLog(run.log, level, text, { limit: LOG_LIMIT });
  if (level !== 'info') console.warn(`[eddn] ${text}`);
}

function snapshotOf(run: ListenerRuntime | null | undefined): EddnListenerSnapshot {
  if (!run) {
    return { running: false, status: 'off', relay: eddnRelay(), stats: emptyStats(), log: [], error: null, nextAttemptAt: null, pending: 0 };
  }
  return {
    running: !run.stopped,
    status: run.stopped ? 'off' : run.status,
    relay: run.relay.url,
    stats: JSON.parse(JSON.stringify(run.stats)) as EddnListenerStats,
    log: [...run.log],
    error: run.error,
    nextAttemptAt: run.nextAttemptAt ? new Date(run.nextAttemptAt).toISOString() : null,
    pending: run.pending.size,
  };
}

export function getEddnListener(): EddnListenerSnapshot {
  return snapshotOf(shared.edrcEddnListener);
}

export function isEddnListenerRunning(): boolean {
  return Boolean(shared.edrcEddnListener && !shared.edrcEddnListener.stopped);
}

async function persist(run: ListenerRuntime, force = false): Promise<void> {
  if (run.options.persist === false || run.noTable) return;
  const now = Date.now();
  if (!force && now - run.persistedAt < PERSIST_EVERY_MS) return;
  run.persistedAt = now;
  try {
    const { error } = await run.svc
      .from('eddn_listener_state')
      .update({
        status: run.stopped ? 'off' : run.status,
        relay: run.relay.url,
        stats: run.stats,
        log: run.log.slice(-LOG_LIMIT),
        error: run.error,
        heartbeat_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      })
      .eq('id', 1);
    if (error) throw new Error(error.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/eddn_listener_state|schema cache|does not exist/i.test(message)) {
      run.noTable = true;
      log(run, 'warn', 'Таблицы eddn_listener_state нет (миграция 20261021130000_eddn_listener.sql) — состояние только в памяти процесса');
    }
  }
}

async function flush(run: ListenerRuntime): Promise<void> {
  if (run.flushing) return run.flushing;
  if (run.pending.size === 0) return;
  const events = Array.from(run.pending.values());
  run.pending.clear();
  run.flushing = (async () => {
    try {
      const apply = run.options.apply ?? ((svc: Svc, list: Record<string, unknown>[]) => applySystemObservations(svc, list, { source: 'eddn', userId: null }));
      const result = await apply(run.svc, events);
      run.stats.flushes += 1;
      run.stats.lastFlushAt = new Date().toISOString();
      run.stats.observations += events.length;
      const pp = result.powerplay;
      run.stats.powerplay.applied += pp.applied;
      run.stats.powerplay.created += pp.created;
      run.stats.powerplay.resolved += pp.resolved ?? 0;
      run.stats.powerplay.vacated += pp.vacated;
      run.stats.powerplay.stale += pp.stale;
      run.stats.factions.applied += result.factions.applied;
      run.stats.factions.created += result.factions.created;
      run.stats.factions.stale += result.factions.stale;
      if (pp.error) log(run, 'warn', `PowerPlay не обновлён: ${pp.error}`);
      // Первая пачка и дальше раз в ~10 минут — чтобы журнал не тонул в рутине.
      if (run.stats.flushes === 1 || run.stats.flushes % 10 === 0) {
        log(run, 'info', `Записано систем: ${events.length} · PowerPlay: применено ${pp.applied}, владельцев названо ${pp.resolved ?? 0}, новых ${pp.created}`
          + ` · фракции: применено ${result.factions.applied}`);
      }
    } catch (error) {
      run.stats.flushErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      run.error = `Запись наблюдений: ${message.slice(0, 200)}`;
      log(run, 'error', run.error);
    } finally {
      run.flushing = null;
      void persist(run);
    }
  })();
  return run.flushing;
}

function scheduleReconnect(run: ListenerRuntime, delayMs: number): void {
  if (run.stopped) return;
  run.status = 'waiting';
  run.nextAttemptAt = Date.now() + delayMs;
  if (run.reconnectTimer) clearTimeout(run.reconnectTimer);
  run.reconnectTimer = setTimeout(() => {
    run.reconnectTimer = null;
    connect(run);
  }, delayMs);
  run.reconnectTimer.unref?.();
}

function onClose(run: ListenerRuntime, info: ZmtpCloseInfo): void {
  run.session = null;
  const seconds = Math.max(0, Math.round((Date.now() - run.sessionStartedAt) / 1000));
  run.stats.lastSessionBytes = info.bytes;
  if (run.stopped) return;
  if (info.reason === 'stall') {
    run.stats.stalls += 1;
    run.failures = 0;
    // Мало данных перед тишиной — почерк «заморозки» соединения провайдером.
    const freeze = info.bytes < 64 * 1024 ? ' — так выглядит «заморозка» соединения провайдером (ТСПУ); новое соединение получает новый лимит' : '';
    const quiet = run.stats.stalls <= 3 || run.stats.stalls % 20 === 0;
    if (quiet) {
      log(run, 'warn', `Реле замолчало: ${formatBytes(info.bytes)} и ${info.messages} сообщ. за ${seconds} с, затем тишина ${Math.round(run.stallMs / 1000)} с${freeze}. Переподключаюсь`);
    }
    scheduleReconnect(run, run.options.reconnectMs ?? RECONNECT_AFTER_STALL_MS);
    return;
  }
  if (info.ready && info.messages > 0) {
    run.failures = 0;
    log(run, 'warn', `Соединение закрыто (${info.reason}${info.error ? `: ${info.error}` : ''}) после ${info.messages} сообщ. за ${seconds} с — переподключаюсь`);
    scheduleReconnect(run, run.options.reconnectMs ?? RECONNECT_AFTER_STALL_MS);
    return;
  }
  run.failures += 1;
  const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.min(10, run.failures - 1));
  run.error = `Нет связи с реле ${run.relay.url}: ${info.error ?? info.reason}`;
  log(run, run.failures >= 3 ? 'error' : 'warn', `${run.error}. Следующая попытка через ${Math.round(delay / 1000)} с`);
  scheduleReconnect(run, delay);
  void persist(run, true);
}

function connect(run: ListenerRuntime): void {
  if (run.stopped || run.session) return;
  run.status = 'connecting';
  run.nextAttemptAt = null;
  run.stats.attempts += 1;
  run.sessionStartedAt = Date.now();
  run.lastDataAt = Date.now();
  run.session = zmtpSubscribe({
    host: run.relay.host,
    port: run.relay.port,
    connect: run.options.connect,
    onData: (bytes) => {
      run.lastDataAt = Date.now();
      run.stats.bytes += bytes;
    },
    onReady: () => {
      run.status = 'connected';
      run.error = null;
      run.stats.sessions += 1;
      run.stats.connectedAt = new Date().toISOString();
      if (run.stats.sessions === 1 || run.stats.sessions % 50 === 0) log(run, 'info', `Подписка на ${run.relay.url} оформлена (сессия ${run.stats.sessions})`);
      void persist(run, run.stats.sessions === 1);
    },
    onMessage: (frames) => {
      run.stats.messages += 1;
      run.stats.lastMessageAt = new Date().toISOString();
      const decoded = decodeEddnFrame(frames[frames.length - 1]);
      const result = eddnObservation(decoded);
      if ('skip' in result) {
        run.stats.skipped[result.skip] += 1;
        return;
      }
      run.stats.journal += 1;
      const key = systemKey(result.event);
      const current = run.pending.get(key);
      if (!current && run.pending.size >= PENDING_HARD_LIMIT) {
        run.stats.skipped.overflow += 1;
        if (run.stats.skipped.overflow === 1 || run.stats.skipped.overflow % 1000 === 0) {
          log(run, 'warn', `Запись в базу не успевает: в очереди ${run.pending.size} систем, новые наблюдения отбрасываются (${run.stats.skipped.overflow})`);
        }
        return;
      }
      if (!current || String(result.event.timestamp ?? '') >= String(current.timestamp ?? '')) run.pending.set(key, result.event);
      if (run.pending.size >= FLUSH_MAX_SYSTEMS) void flush(run);
    },
    onClose: (info) => onClose(run, info),
  });
}

/** Запустить в этом процессе (если ещё не запущен). */
export function startEddnListener(svc: Svc, options: EddnListenerOptions = {}): EddnListenerSnapshot {
  const existing = shared.edrcEddnListener;
  if (existing && !existing.stopped) return snapshotOf(existing);
  const run: ListenerRuntime = {
    svc,
    options,
    relay: parseRelay(options.relay ?? eddnRelay()),
    stallMs: options.stallMs ?? envMs(process.env.EDDN_STALL_MS, DEFAULT_STALL_MS, 5_000, 600_000),
    flushMs: options.flushMs ?? envMs(process.env.EDDN_FLUSH_MS, DEFAULT_FLUSH_MS, 1_000, 600_000),
    stopped: false,
    status: 'connecting',
    session: null,
    sessionStartedAt: Date.now(),
    lastDataAt: Date.now(),
    failures: 0,
    reconnectTimer: null,
    watchdog: null,
    flushTimer: null,
    flushing: null,
    pending: new Map(),
    stats: emptyStats(),
    log: existing ? [...existing.log] : [],
    error: null,
    nextAttemptAt: null,
    persistedAt: 0,
    noTable: false,
  };
  run.stats.startedAt = new Date().toISOString();
  shared.edrcEddnListener = run;
  log(run, 'info', `Слушатель EDDN запущен: ${run.relay.url}, запись пачкой раз в ${Math.round(run.flushMs / 1000)} с, тишина ${Math.round(run.stallMs / 1000)} с — переподключение`);
  run.watchdog = setInterval(() => {
    if (run.session?.ready && Date.now() - run.lastDataAt > run.stallMs) run.session.close('stall');
  }, Math.min(WATCHDOG_MS, Math.max(250, Math.floor(run.stallMs / 3))));
  run.watchdog.unref?.();
  run.flushTimer = setInterval(() => {
    void flush(run);
  }, run.flushMs);
  run.flushTimer.unref?.();
  connect(run);
  void persist(run, true);
  return snapshotOf(run);
}

/** Остановить: закрыть подписку и дописать накопленное. */
export async function stopEddnListener(reason = 'остановлен'): Promise<EddnListenerSnapshot> {
  const run = shared.edrcEddnListener;
  if (!run || run.stopped) return snapshotOf(run);
  run.stopped = true;
  run.status = 'off';
  run.nextAttemptAt = null;
  if (run.reconnectTimer) clearTimeout(run.reconnectTimer);
  if (run.watchdog) clearInterval(run.watchdog);
  if (run.flushTimer) clearInterval(run.flushTimer);
  run.session?.close('manual');
  run.session = null;
  await flush(run);
  if (run.flushing) await run.flushing;
  log(run, 'info', `Слушатель EDDN ${reason}: сообщений ${run.stats.messages}, наблюдений ${run.stats.observations}, PowerPlay применено ${run.stats.powerplay.applied}`);
  await persist(run, true);
  return snapshotOf(run);
}

/** Для тестов: забыть слушателя этого процесса (не останавливая таймеры — их снимает stop). */
export function resetEddnListenerRuntime(): void {
  shared.edrcEddnListener = null;
  shared.edrcEddnEnsureAt = 0;
}

/* ── Включено ли: флаг в базе ──────────────────────────────────────────── */

export interface EddnListenerSettings {
  enabled: boolean;
  enabledAt: string | null;
  status: string | null;
  heartbeatAt: string | null;
  stats: Partial<EddnListenerStats> | null;
  log: PowerplayLogLine[];
  error: string | null;
  /** Таблица есть (миграция 20261021130000 применена). */
  supported: boolean;
}

export async function readEddnSettings(svc: Svc): Promise<EddnListenerSettings> {
  const { data, error } = await svc.from('eddn_listener_state').select('*').eq('id', 1).maybeSingle();
  if (error) {
    if (/eddn_listener_state|schema cache|does not exist/i.test(String(error.message))) {
      return { enabled: false, enabledAt: null, status: null, heartbeatAt: null, stats: null, log: [], error: null, supported: false };
    }
    throw new Error(error.message);
  }
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    enabled: row.enabled === true,
    enabledAt: typeof row.enabled_at === 'string' ? row.enabled_at : null,
    status: typeof row.status === 'string' ? row.status : null,
    heartbeatAt: typeof row.heartbeat_at === 'string' ? row.heartbeat_at : null,
    stats: row.stats && typeof row.stats === 'object' ? (row.stats as Partial<EddnListenerStats>) : null,
    log: sanitizePowerplayLog(row.log, LOG_LIMIT),
    error: typeof row.error === 'string' ? row.error : null,
    supported: true,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function setEddnEnabled(svc: Svc, enabled: boolean, userId: string | null): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await svc
    .from('eddn_listener_state')
    .upsert({
      id: 1,
      enabled,
      enabled_at: enabled ? now : null,
      // Предпросмотр админки ходит без настоящего пользователя — тогда без автора.
      enabled_by: enabled && userId && UUID.test(userId) ? userId : null,
      updated_at: now,
    }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

/**
 * Привести процесс к флагу из базы: включено — запустить, выключено —
 * остановить. Задача `eddn-listener`, админка и слой PowerPlay.
 */
export interface EddnEnsureResult {
  enabled: boolean;
  forbidden: boolean;
  supported: boolean;
  settings: EddnListenerSettings;
  snapshot: EddnListenerSnapshot;
}

export async function ensureEddnListener(svc: Svc, options: EddnListenerOptions = {}): Promise<EddnEnsureResult> {
  shared.edrcEddnEnsureAt = Date.now();
  const forbidden = eddnListenerForbidden();
  const settings = await readEddnSettings(svc);
  if (settings.enabled && !forbidden && !isEddnListenerRunning()) startEddnListener(svc, options);
  else if ((!settings.enabled || forbidden) && isEddnListenerRunning()) {
    await stopEddnListener(forbidden ? 'остановлен: EDDN_LISTENER=off' : 'остановлен: выключен в админке');
  }
  return { enabled: settings.enabled, forbidden, supported: settings.supported, settings, snapshot: getEddnListener() };
}

/** Не чаще раза в 5 минут на процесс — для частых запросов (слой PowerPlay). */
export function ensureEddnListenerSoon(svc: Svc): void {
  const last = shared.edrcEddnEnsureAt ?? 0;
  if (Date.now() - last < ENSURE_EVERY_MS) return;
  shared.edrcEddnEnsureAt = Date.now();
  void ensureEddnListener(svc).catch(() => undefined);
}
