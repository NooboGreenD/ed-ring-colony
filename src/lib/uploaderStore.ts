/**
 * Хранилище пакетов Colonial Helper: манифесты, файлы, архивы, каналы.
 *
 * Пилотам больше не нужно качать 22-мегабайтный `ColonialHelper.exe` на каждую
 * правку кода: программа обновляет только свои модули по подписанному
 * манифесту (`uploader/bundle.py`). Здесь — серверная половина этого канала.
 *
 * Раскладка на диске (том `UPLOADER_STORE_DIR`, по умолчанию `/data/uploader`):
 *
 *   blobs/<aa>/<sha256>     файлы пакетов, адресуемые содержимым
 *   manifests/<version>.json подписанный манифест версии
 *   bundles/<version>.zip    полный пакет (первая установка и «ремонт»)
 *   channels/<channel>.json  указатель канала: какая версия сейчас текущая
 *   launcher/<platform>.json метаданные базовой сборки (exe)
 *
 * Файлы адресуются хешем, поэтому один и тот же модуль между версиями лежит
 * на диске ровно один раз, а его URL можно кэшировать вечно.
 *
 * Подпись здесь не «на всякий случай»: клиент исполняет то, что мы отдадим.
 * Сервер проверяет её повторно (ключи в `UPLOADER_SIGN_PUBLIC_KEYS`), чтобы
 * сломанный или чужой пакет не доехал до канала вообще.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

/** Ниже этого размера сжатие только увеличивает ответ. */
const GZIP_MIN_BYTES = 1024;

export const MANIFEST_SCHEMA = 1;
export const MAX_FILES = 400;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** Каналы, которые вообще существуют. `all` — синоним «самое свежее». */
export const CHANNELS = ['stable', 'beta'] as const;
export type Channel = (typeof CHANNELS)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]{1,40})?$/;
const MEMBER = /^[0-9A-Za-z._-]+(?:\/[0-9A-Za-z._-]+)*$/;
const ALLOWED_SUFFIX = ['.py', '.json', '.txt', '.md', '.ico', '.png', '.csv'];
const PLATFORM = /^[a-z0-9_-]{2,20}$/;
/** Идентификатор ключа подписи: короткий, без запятых и двоеточий (формат `id:base64`). */
const KEY_ID = /^[0-9A-Za-z._-]{1,40}$/;

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BundleManifest {
  schema: number;
  channel: string;
  version: string;
  entry: string;
  min_launcher?: string;
  released_at?: string;
  notes?: string;
  files: ManifestFile[];
  signature?: { alg?: string; key_id?: string; value?: string };
  [key: string]: unknown;
}

export interface LauncherInfo {
  platform: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
  updated_at?: string;
}

/** Корень хранилища. В деве — внутри проекта, чтобы ничего не требовать от машины. */
export function storeRoot(): string {
  const configured = process.env.UPLOADER_STORE_DIR?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return '/data/uploader';
  return join(process.cwd(), 'data', 'uploader');
}

function blobPath(hash: string): string {
  return join(storeRoot(), 'blobs', hash.slice(0, 2), hash);
}

function manifestPath(version: string): string {
  return join(storeRoot(), 'manifests', `${version}.json`);
}

function bundlePath(version: string): string {
  return join(storeRoot(), 'bundles', `${version}.zip`);
}

function channelPath(channel: string): string {
  return join(storeRoot(), 'channels', `${channel}.json`);
}

function launcherPath(platform: string): string {
  return join(storeRoot(), 'launcher', `${platform}.json`);
}

function configPath(): string {
  return join(storeRoot(), 'config.json');
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data);
  await rename(temp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Настройки, редактируемые из админки (config.json в хранилище)
// ---------------------------------------------------------------------------
/**
 * Часть настроек канала обновлений раньше жила только в переменных окружения
 * (`UPLOADER_SIGN_PUBLIC_KEYS`, `UPLOADER_PUBLISH_TOKEN`). Их неудобно менять:
 * нужен доступ к серверу и рестарт. Поэтому те же значения можно хранить в
 * `config.json` внутри тома хранилища и править прямо из админки.
 *
 * Переменные окружения при этом никуда не деваются — это по-прежнему
 * «жёсткая» конфигурация деплоя. Значения из файла добавляются к ним:
 * доверенным считается ключ из окружения ИЛИ из файла, публиковать можно
 * токеном из окружения ИЛИ из файла. Так деплой нельзя случайно ослабить из
 * UI, но можно дополнить и ротировать без доступа к серверу.
 */
export interface SignKeyConfig {
  id: string;
  /** Публичный ключ ed25519, base64 (ровно 32 байта после декодирования). */
  publicKey: string;
}

export interface UploaderConfig {
  signKeys: SignKeyConfig[];
  /** Токен публикации; наружу (в статус/UI) никогда не отдаётся, только факт наличия. */
  publishToken?: string;
}

function normalizeConfig(parsed: unknown): UploaderConfig {
  const source = (parsed ?? {}) as Record<string, unknown>;
  const rawKeys = Array.isArray(source.signKeys) ? source.signKeys : [];
  const signKeys: SignKeyConfig[] = [];
  for (const item of rawKeys) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as Record<string, unknown>).id ?? '').trim();
    const publicKey = String((item as Record<string, unknown>).publicKey ?? '').trim();
    if (!KEY_ID.test(id) || Buffer.from(publicKey, 'base64').length !== 32) continue;
    if (signKeys.some((k) => k.id === id)) continue;
    signKeys.push({ id, publicKey });
  }
  const token = typeof source.publishToken === 'string' ? source.publishToken.trim() : '';
  return { signKeys, publishToken: token || undefined };
}

/** Синхронное чтение — нужно проверке подписи и токена, которые сами синхронны. */
function readConfigSync(): UploaderConfig {
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    return { signKeys: [] };
  }
}

export async function readConfig(): Promise<UploaderConfig> {
  try {
    return normalizeConfig(JSON.parse(await readFile(configPath(), 'utf8')));
  } catch {
    return { signKeys: [] };
  }
}

async function writeConfig(config: UploaderConfig): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(config, null, 2));
}

/** Проверить и нормализовать публичный ключ: строго 32 байта base64. */
export function normalizePublicKey(value: string): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 32) return null;
  // Возвращаем канонический base64, чтобы `id:base64` в статусе выглядел ровно.
  return raw.toString('base64');
}

/** Публичный ключ ed25519 (base64) из 32-байтового seed'а — как в bundle.py. */
export function deriveEd25519Public(seed: Buffer): string {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x?: string };
  return Buffer.from(String(jwk.x ?? ''), 'base64url').toString('base64');
}

export interface GeneratedSignKey {
  id: string;
  publicKey: string;
  /** Приватный ключ (seed, base64). Показывается один раз — на сервере не хранится. */
  privateKey: string;
}

/** Сгенерировать пару ключей подписи (эквивалент `build_bundle.py --keygen`). */
export function generateSignKey(id?: string): GeneratedSignKey {
  const seed = randomBytes(32);
  const keyId = id?.trim() || `k${new Date().toISOString().slice(0, 7).replace('-', '')}`;
  return { id: keyId, publicKey: deriveEd25519Public(seed), privateKey: seed.toString('base64') };
}

/** Добавить/заменить доверенный публичный ключ в config.json. */
export async function upsertSignKey(id: string, publicKey: string): Promise<PublishResult> {
  const trimmedId = String(id ?? '').trim();
  if (!KEY_ID.test(trimmedId)) return { ok: false, error: 'id ключа: только буквы, цифры и . _ - (до 40 символов)' };
  const normalized = normalizePublicKey(publicKey);
  if (!normalized) return { ok: false, error: 'публичный ключ должен быть 32 байта в base64' };
  const config = await readConfig();
  const signKeys = config.signKeys.filter((k) => k.id !== trimmedId);
  signKeys.push({ id: trimmedId, publicKey: normalized });
  await writeConfig({ ...config, signKeys });
  return { ok: true };
}

/** Убрать публичный ключ из config.json (ключи из окружения так не убрать). */
export async function removeSignKey(id: string): Promise<PublishResult> {
  const trimmedId = String(id ?? '').trim();
  const config = await readConfig();
  if (!config.signKeys.some((k) => k.id === trimmedId)) {
    return { ok: false, error: `ключа ${trimmedId} нет в настройках (возможно, он задан в окружении)` };
  }
  await writeConfig({ ...config, signKeys: config.signKeys.filter((k) => k.id !== trimmedId) });
  return { ok: true };
}

/** Задать (или очистить пустой строкой) токен публикации в config.json. */
export async function setPublishToken(token: string | null): Promise<PublishResult> {
  const value = String(token ?? '').trim();
  if (value && value.length < 16) return { ok: false, error: 'токен слишком короткий: минимум 16 символов' };
  const config = await readConfig();
  await writeConfig({ ...config, publishToken: value || undefined });
  return { ok: true };
}

/** Сгенерировать длинный случайный токен публикации и сохранить его. */
export async function generatePublishToken(): Promise<{ ok: boolean; token?: string; error?: string }> {
  const token = randomBytes(36).toString('base64url');
  const result = await setPublishToken(token);
  return result.ok ? { ok: true, token } : { ok: false, error: result.error };
}

// ---------------------------------------------------------------------------
//  Валидация манифеста (зеркало uploader/bundle.py: check_manifest)
// ---------------------------------------------------------------------------
export function checkManifest(input: unknown): { ok: true; manifest: BundleManifest } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'манифест не объект' };
  const manifest = input as BundleManifest;
  if (manifest.schema !== MANIFEST_SCHEMA) return { ok: false, error: `схема ${String(manifest.schema)} не поддерживается` };
  if (typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) {
    return { ok: false, error: 'некорректная версия' };
  }
  if (typeof manifest.channel !== 'string' || !(CHANNELS as readonly string[]).includes(manifest.channel)) {
    return { ok: false, error: `неизвестный канал ${String(manifest.channel)}` };
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) return { ok: false, error: 'пустой список файлов' };
  if (manifest.files.length > MAX_FILES) return { ok: false, error: 'слишком много файлов' };

  const seen = new Set<string>();
  let total = 0;
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'элемент files не объект' };
    const { path, sha256, size } = item as ManifestFile;
    if (typeof path !== 'string' || !MEMBER.test(path) || path.includes('..')) {
      return { ok: false, error: `небезопасный путь ${String(path)}` };
    }
    if (!ALLOWED_SUFFIX.some((suffix) => path.toLowerCase().endsWith(suffix))) {
      return { ok: false, error: `недопустимый тип файла ${path}` };
    }
    if (seen.has(path)) return { ok: false, error: `файл ${path} указан дважды` };
    seen.add(path);
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return { ok: false, error: `плохой sha256 у ${path}` };
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) return { ok: false, error: `плохой размер у ${path}` };
    total += size;
  }
  if (total > MAX_BUNDLE_BYTES) return { ok: false, error: 'пакет слишком велик' };
  const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
  if (!entry.endsWith('.py') || !seen.has(entry)) return { ok: false, error: 'точки входа нет в списке файлов' };
  return { ok: true, manifest };
}

/**
 * Канонический вид манифеста для подписи.
 *
 * Обязан совпадать байт в байт с `bundle.canonical_bytes` на Python:
 * ключи отсортированы, разделители без пробелов, UTF-8 как есть, поле
 * `signature` исключено.
 */
export function canonicalManifestBytes(manifest: Record<string, unknown>): Buffer {
  const stringify = (value: unknown): string => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `[${value.map(stringify).join(',')}]`;
    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stringify(item)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key !== 'signature') payload[key] = value;
  }
  return Buffer.from(stringify(payload), 'utf8');
}

/**
 * Доверенные публичные ключи. Источники складываются:
 *   * окружение `UPLOADER_SIGN_PUBLIC_KEYS="id:base64,id2:base64"` (деплой);
 *   * `config.json`, редактируемый из админки.
 * Ключ из файла может дополнить или заменить одноимённый ключ окружения —
 * это и есть ротация через UI.
 */
export function trustedKeys(): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const chunk of (process.env.UPLOADER_SIGN_PUBLIC_KEYS ?? '').split(',')) {
    const [id, encoded] = chunk.split(':');
    if (!id?.trim() || !encoded?.trim()) continue;
    const raw = Buffer.from(encoded.trim(), 'base64');
    if (raw.length === 32) keys.set(id.trim(), raw);
  }
  for (const key of readConfigSync().signKeys) {
    const raw = Buffer.from(key.publicKey, 'base64');
    if (raw.length === 32) keys.set(key.id, raw);
  }
  return keys;
}

/** Идентификаторы ключей, заданных именно в окружении (их нельзя убрать из UI). */
export function envKeyIds(): string[] {
  const ids: string[] = [];
  for (const chunk of (process.env.UPLOADER_SIGN_PUBLIC_KEYS ?? '').split(',')) {
    const [id, encoded] = chunk.split(':');
    if (!id?.trim() || !encoded?.trim()) continue;
    if (Buffer.from(encoded.trim(), 'base64').length === 32) ids.push(id.trim());
  }
  return ids;
}

/**
 * Проверить подпись манифеста. Если ключи на сервере не настроены, пакет
 * принимается с подписью «как есть» — проверять её всё равно будет клиент,
 * у которого ключ зашит в лаунчере.
 */
export function verifyManifestSignature(manifest: BundleManifest): { ok: boolean; error?: string; checked: boolean } {
  const signature = manifest.signature;
  if (!signature || typeof signature !== 'object') return { ok: false, error: 'манифест не подписан', checked: false };
  if (signature.alg !== 'ed25519') return { ok: false, error: `алгоритм ${String(signature.alg)} не поддерживается`, checked: false };
  const keyId = String(signature.key_id ?? '');
  const value = String(signature.value ?? '');
  const raw = Buffer.from(value, 'base64');
  if (raw.length !== 64) return { ok: false, error: 'подпись не 64 байта', checked: false };

  const keys = trustedKeys();
  if (keys.size === 0) return { ok: true, checked: false };
  const publicKey = keys.get(keyId);
  if (!publicKey) return { ok: false, error: `неизвестный ключ ${keyId}`, checked: true };
  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey.toString('base64url') },
      format: 'jwk',
    });
    const ok = cryptoVerify(null, canonicalManifestBytes(manifest), key, raw);
    return ok ? { ok: true, checked: true } : { ok: false, error: 'подпись не сходится', checked: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'ошибка проверки подписи', checked: true };
  }
}

/**
 * Токен публикации из CI. Принимается токен из окружения
 * (`UPLOADER_PUBLISH_TOKEN`) ИЛИ из `config.json` (заданный в админке).
 * Сравнение — без утечки времени, по каждому кандидату.
 */
export function isPublishAuthorized(request: Request): boolean {
  const secrets = [process.env.UPLOADER_PUBLISH_TOKEN?.trim(), readConfigSync().publishToken?.trim()]
    .filter((value): value is string => Boolean(value));
  if (secrets.length === 0) return false;
  const header = request.headers.get('authorization') ?? '';
  const supplied = /^Bearer (.+)$/i.exec(header)?.[1] ?? '';
  const actual = Buffer.from(supplied);
  // Проверяем все кандидаты, а не только первый совпавший по длине, чтобы
  // токен из файла работал даже когда в окружении задан другой.
  return secrets.some((secret) => {
    const expected = Buffer.from(secret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

// ---------------------------------------------------------------------------
//  Чтение
// ---------------------------------------------------------------------------
export function normalizeChannel(value: unknown): Channel | 'all' {
  const raw = String(value ?? 'stable').trim().toLowerCase();
  if (raw === 'all' || raw === 'any') return 'all';
  return (CHANNELS as readonly string[]).includes(raw) ? (raw as Channel) : 'stable';
}

export function versionTuple(value: string): number[] {
  const match = /^(\d+(?:\.\d+)*)/.exec(String(value ?? '').replace(/^v/i, ''));
  if (!match) return [];
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left: string, right: string): number {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export async function readChannelVersion(channel: Channel): Promise<string> {
  const pointer = await readJson<{ version?: string }>(channelPath(channel));
  const version = String(pointer?.version ?? '');
  return VERSION.test(version) ? version : '';
}

export async function readManifest(version: string): Promise<BundleManifest | null> {
  if (!VERSION.test(version)) return null;
  return readJson<BundleManifest>(manifestPath(version));
}

/**
 * Манифест канала. `all` отдаёт самое свежее из каналов: так пилот-тестер
 * получает beta, а когда stable его обгоняет — снова stable.
 */
export async function manifestForChannel(channel: Channel | 'all'): Promise<BundleManifest | null> {
  const wanted: Channel[] = channel === 'all' ? [...CHANNELS] : [channel];
  let best: BundleManifest | null = null;
  for (const name of wanted) {
    const version = await readChannelVersion(name);
    if (!version) continue;
    const manifest = await readManifest(version);
    if (!manifest) continue;
    if (!best || compareVersions(manifest.version, best.version) > 0) best = manifest;
  }
  return best;
}

export async function readBlob(hash: string): Promise<Buffer | null> {
  if (!SHA256.test(hash)) return null;
  try {
    return await readFile(blobPath(hash));
  } catch {
    return null;
  }
}

/**
 * Тот же файл, но сжатый — для клиентов, которые прислали `Accept-Encoding: gzip`.
 *
 * Модули программы — это текст на Python: `colonial_helper.py` весит 542 КиБ,
 * а в gzip — около сотни. Сжимаем один раз и кладём рядом с файлом: имя файла
 * это его sha256, содержимое неизменяемо, значит и сжатая форма устаревать не
 * может. Дальше её раздаёт и кэширует nginx, как обычный статический файл.
 */
export async function readBlobGzip(hash: string): Promise<Buffer | null> {
  if (!SHA256.test(hash)) return null;
  const cached = `${blobPath(hash)}.gz`;
  try {
    return await readFile(cached);
  } catch {
    // Сжатой копии ещё нет — сделаем её сейчас.
  }
  const raw = await readBlob(hash);
  if (!raw) return null;
  // Мелочь сжимать бессмысленно: заголовок gzip сделает ответ больше исходного.
  if (raw.length < GZIP_MIN_BYTES) return null;
  const packed = await gzipAsync(raw, { level: 9 });
  if (packed.length >= raw.length) return null;
  try {
    await writeAtomic(cached, packed);
  } catch {
    // Кэш — не обязательное условие: не вышло записать, просто отдадим как есть.
  }
  return packed;
}

/**
 * Лежит ли файл в хранилище и цел ли он.
 *
 * Имя файла — его же sha256, поэтому проверка сводится к пересчёту хеша.
 * Сравнивать только размер нельзя: битый файл того же размера (обрезанная
 * запись, сбой диска) молча уехал бы пилотам и сломал им установку.
 */
async function hasBlob(hash: string): Promise<boolean> {
  const data = await readBlob(hash);
  if (!data) return false;
  return createHash('sha256').update(data).digest('hex') === hash;
}

export async function readBundleArchive(version: string): Promise<Buffer | null> {
  if (!VERSION.test(version)) return null;
  try {
    return await readFile(bundlePath(version));
  } catch {
    return null;
  }
}

export async function readLauncher(platform: string): Promise<LauncherInfo | null> {
  if (!PLATFORM.test(platform)) return null;
  return readJson<LauncherInfo>(launcherPath(platform));
}

export async function listVersions(): Promise<string[]> {
  try {
    const names = await readdir(join(storeRoot(), 'manifests'));
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((version) => VERSION.test(version))
      .sort((a, b) => compareVersions(b, a));
  } catch {
    return [];
  }
}

export async function channelState(): Promise<Record<string, { version: string; released_at: string }>> {
  const out: Record<string, { version: string; released_at: string }> = {};
  for (const channel of CHANNELS) {
    const version = await readChannelVersion(channel);
    const manifest = version ? await readManifest(version) : null;
    out[channel] = { version, released_at: String(manifest?.released_at ?? '') };
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Запись
// ---------------------------------------------------------------------------
export interface PublishInput {
  manifest: unknown;
  /** `путь -> base64` содержимого. Уже лежащие на диске файлы можно не слать. */
  files?: Record<string, string>;
  /** Полный zip пакета в base64 — для первой установки и «ремонта». */
  bundleBase64?: string;
  /** Обновлять ли указатель канала (по умолчанию да). */
  promote?: boolean;
}

export interface PublishResult {
  ok: boolean;
  error?: string;
  version?: string;
  channel?: string;
  storedBlobs?: number;
  missing?: string[];
  signatureChecked?: boolean;
}

/** Опубликовать пакет: разложить файлы по хешам и (по умолчанию) поднять канал. */
export async function publishBundle(input: PublishInput): Promise<PublishResult> {
  const checked = checkManifest(input.manifest);
  if (!checked.ok) return { ok: false, error: checked.error };
  const manifest = checked.manifest;

  const signature = verifyManifestSignature(manifest);
  if (!signature.ok) return { ok: false, error: `подпись: ${signature.error}` };

  const files = input.files ?? {};
  const missing: string[] = [];
  let stored = 0;

  for (const item of manifest.files) {
    const encoded = files[item.path];
    if (encoded) {
      const data = Buffer.from(encoded, 'base64');
      // Присланный файл проверяем всегда, даже если такой blob уже лежит на
      // диске: расхождение здесь — сломанная сборка, и «починить» её, молча
      // взяв старое содержимое, значит опубликовать не то, что подписано.
      if (data.length !== item.size) return { ok: false, error: `размер ${item.path} не совпал` };
      const digest = createHash('sha256').update(data).digest('hex');
      if (digest !== item.sha256) return { ok: false, error: `sha256 ${item.path} не совпал` };
      if (!(await hasBlob(item.sha256))) {
        await writeAtomic(blobPath(item.sha256), data);
        stored += 1;
      }
      continue;
    }
    // Файла нет в запросе — он должен уже лежать в хранилище. Пустой ответ
    // здесь означает, что пакет собран из файлов, которых сервер не видел.
    if (!(await hasBlob(item.sha256))) missing.push(item.path);
  }

  if (missing.length > 0) {
    // Отдаём список: CI может дослать только недостающее, не гоняя пакет целиком.
    return { ok: false, error: 'не хватает файлов', missing, version: manifest.version };
  }

  if (input.bundleBase64) {
    const archive = Buffer.from(input.bundleBase64, 'base64');
    if (archive.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'архив слишком велик' };
    await writeAtomic(bundlePath(manifest.version), archive);
  }

  await writeAtomic(manifestPath(manifest.version), JSON.stringify(manifest, null, 2));

  if (input.promote !== false) {
    await writeAtomic(
      channelPath(manifest.channel),
      JSON.stringify({ version: manifest.version, updated_at: new Date().toISOString() }, null, 2),
    );
  }

  return {
    ok: true,
    version: manifest.version,
    channel: manifest.channel,
    storedBlobs: stored,
    signatureChecked: signature.checked,
  };
}

/** Перевести канал на уже опубликованную версию (в том числе назад — откат). */
export async function promoteVersion(channel: Channel, version: string): Promise<PublishResult> {
  const manifest = await readManifest(version);
  if (!manifest) return { ok: false, error: `версия ${version} не опубликована` };
  const checked = checkManifest(manifest);
  if (!checked.ok) return { ok: false, error: checked.error };
  await writeAtomic(
    channelPath(channel),
    JSON.stringify({ version, updated_at: new Date().toISOString() }, null, 2),
  );
  return { ok: true, version, channel };
}

/** Сохранить метаданные базовой сборки (exe) для канала обновлений лаунчера. */
export async function saveLauncher(info: LauncherInfo): Promise<PublishResult> {
  if (!PLATFORM.test(info.platform)) return { ok: false, error: 'плохая платформа' };
  if (!VERSION.test(info.version)) return { ok: false, error: 'плохая версия' };
  if (!/^https:\/\/[^\s]+$/.test(info.url)) return { ok: false, error: 'ссылка должна быть https' };
  if (info.sha256 && !SHA256.test(info.sha256)) return { ok: false, error: 'плохой sha256' };
  await writeAtomic(
    launcherPath(info.platform),
    JSON.stringify({ ...info, updated_at: new Date().toISOString() }, null, 2),
  );
  return { ok: true, version: info.version };
}

/** Есть ли вообще хранилище (для диагностики в админке). */
export interface StoreStatus {
  root: string;
  ready: boolean;
  versions: number;
  /** Задан ли токен, которым публикует CI (сам токен наружу не отдаётся). */
  publishConfigured: boolean;
  /** Откуда взят токен публикации: окружение, файл настроек или нигде. */
  publishTokenSource: 'env' | 'config' | 'none';
  /** Идентификаторы доверенных ключей подписи — без самих ключей. */
  keyIds: string[];
  /** Ключи, заданные в окружении: их видно, но из UI не отредактировать. */
  envKeyIds: string[];
  /** Ключи из config.json — их можно менять и удалять из админки. */
  configKeys: SignKeyConfig[];
}

export async function storeStatus(): Promise<StoreStatus> {
  const root = storeRoot();
  let ready = false;
  try {
    ready = (await stat(root)).isDirectory();
  } catch {
    ready = false;
  }
  const config = await readConfig();
  const envToken = (process.env.UPLOADER_PUBLISH_TOKEN ?? '').trim().length > 0;
  const publishTokenSource = envToken ? 'env' : config.publishToken ? 'config' : 'none';
  return {
    root,
    ready,
    versions: (await listVersions()).length,
    publishConfigured: publishTokenSource !== 'none',
    publishTokenSource,
    // trustedKeys() — это Map; Object.keys() по нему всегда пуст (старая ошибка,
    // из-за которой панель показывала «ключи не настроены» даже когда они были).
    keyIds: [...trustedKeys().keys()],
    envKeyIds: envKeyIds(),
    configKeys: config.signKeys,
  };
}
