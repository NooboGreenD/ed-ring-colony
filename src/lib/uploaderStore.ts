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
  sign as cryptoSign,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw, gzip } from 'node:zlib';

import { MAX_LAUNCHER_UPLOAD_BYTES } from './launcherUploadProtocol';

const gzipAsync = promisify(gzip);
const deflateRawAsync = promisify(deflateRaw);

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

export function isValidLauncherPlatform(value: string): boolean {
  return PLATFORM.test(value);
}

export function isValidLauncherVersion(value: string): boolean {
  return VERSION.test(value);
}

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

function launcherBinaryPath(platform: string): string {
  return join(storeRoot(), 'launcher', `${platform}.exe`);
}

function configPath(): string {
  return join(storeRoot(), 'config.json');
}

async function writeAtomic(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, data, { mode: 0o600 });
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
  /**
   * Приватный seed нужен автономному серверному издателю. Он никогда не
   * попадает в API статуса и хранится только в config.json тома (mode 0600).
   */
  privateKey?: string;
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
    const privateKey = String((item as Record<string, unknown>).privateKey ?? '').trim();
    // Не доверяем записанной паре на слово: неверный seed сделал бы релизы,
    // которые не принимает ни сервер, ни Helper.
    const validPrivate = Buffer.from(privateKey, 'base64').length === 32
      && deriveEd25519Public(Buffer.from(privateKey, 'base64')) === Buffer.from(publicKey, 'base64').toString('base64');
    signKeys.push({
      id,
      publicKey: Buffer.from(publicKey, 'base64').toString('base64'),
      ...(validPrivate ? { privateKey: Buffer.from(privateKey, 'base64').toString('base64') } : {}),
    });
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
  await mkdir(storeRoot(), { recursive: true, mode: 0o700 });
  // На dev/systemd каталог мог существовать с обычным umask; приватный seed
  // не должен быть доступен другим пользователям хоста.
  await chmod(storeRoot(), 0o700);
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

// ---------------------------------------------------------------------------
//  Ключи, зашитые в установленные программы (uploader/bundle.py)
// ---------------------------------------------------------------------------
/**
 * Клиент исполняет скачанный код, поэтому ставит только пакеты, подписанные
 * ключом из `TRUSTED_KEYS` его сборки (`uploader/bundle.py`). Сервер обязан
 * подписывать релизы таким ключом — иначе пилоты видят «канал недоступен:
 * подпись сделана неизвестным ключом» и навсегда остаются на старой версии.
 *
 * Источник истины — сам `uploader/bundle.py` из этого же репозитория: именно
 * он попадает в лаунчер (exe) и в каждый пакет кода. Файл едет в web-образе
 * (`/app/uploader`), поэтому читаем его в рантайме и кэшируем по mtime.
 * Пока файл прочитать не удалось, список пуст: публикация не блокируется
 * (проверку подписи клиент всё равно делает сам), но панель честно покажет,
 * что доверие клиентов «неизвестно».
 */
const CLIENT_TRUSTED_CACHE: { path: string; mtimeMs: number; keys: Map<string, string> } = {
  path: '', mtimeMs: -1, keys: new Map(),
};

export function uploaderSourceDir(): string {
  const configured = process.env.UPLOADER_SOURCE_DIR?.trim();
  return configured || join(process.cwd(), 'uploader');
}

export function clientTrustedKeys(): Map<string, string> {
  const path = join(uploaderSourceDir(), 'bundle.py');
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (CLIENT_TRUSTED_CACHE.path === path && CLIENT_TRUSTED_CACHE.mtimeMs === mtimeMs) {
      return CLIENT_TRUSTED_CACHE.keys;
    }
    const source = readFileSync(path, 'utf8');
    const keys = new Map<string, string>();
    // Словарь может быть и однострочным, и перенесённым по строкам: [\s\S].
    const block = /TRUSTED_KEYS[^=]*=\s*(\{[\s\S]*?\})/.exec(source)?.[1] ?? '';
    for (const match of block.matchAll(/["']([0-9A-Za-z._-]+)["']\s*:\s*["']([A-Za-z0-9+/=]+)["']/g)) {
      const raw = Buffer.from(match[2], 'base64');
      if (raw.length === 32) keys.set(match[1], Buffer.from(match[2], 'base64').toString('base64'));
    }
    CLIENT_TRUSTED_CACHE.path = path;
    CLIENT_TRUSTED_CACHE.mtimeMs = mtimeMs;
    CLIENT_TRUSTED_CACHE.keys = keys;
    return keys;
  } catch {
    // Файла нет (нестандартная установка) — отдаём последнюю удачную версию
    // кэша, а при первом неудачном чтении — пустую карту.
    return CLIENT_TRUSTED_CACHE.path === path ? CLIENT_TRUSTED_CACHE.keys : new Map();
  }
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
  // Суффикс не даёт случайно заменить одноимённый уже вшитый в клиенты ключ
  // другой парой (особенно при двух нажатиях в одном месяце).
  const keyId = id?.trim()
    || `k${new Date().toISOString().slice(0, 7).replace('-', '')}-${randomBytes(3).toString('hex')}`;
  return { id: keyId, publicKey: deriveEd25519Public(seed), privateKey: seed.toString('base64') };
}

/** Добавить/заменить доверенный публичный ключ в config.json. */
export async function upsertSignKey(id: string, publicKey: string): Promise<PublishResult> {
  const trimmedId = String(id ?? '').trim();
  if (!KEY_ID.test(trimmedId)) return { ok: false, error: 'id ключа: только буквы, цифры и . _ - (до 40 символов)' };
  const normalized = normalizePublicKey(publicKey);
  if (!normalized) return { ok: false, error: 'публичный ключ должен быть 32 байта в base64' };
  const config = await readConfig();
  const previous = config.signKeys.find((k) => k.id === trimmedId && k.publicKey === normalized);
  const signKeys = config.signKeys.filter((k) => k.id !== trimmedId);
  signKeys.push({ id: trimmedId, publicKey: normalized, ...(previous?.privateKey ? { privateKey: previous.privateKey } : {}) });
  await writeConfig({ ...config, signKeys });
  return { ok: true };
}

/** Сохранить серверную пару: она позволяет выпускать версии без CI/GitHub. */
export async function storeSignKey(key: GeneratedSignKey): Promise<PublishResult> {
  const normalized = normalizePublicKey(key.publicKey);
  const seed = Buffer.from(String(key.privateKey ?? ''), 'base64');
  if (!KEY_ID.test(key.id) || !normalized || seed.length !== 32) {
    return { ok: false, error: 'некорректная пара ключей' };
  }
  if (deriveEd25519Public(seed) !== normalized) return { ok: false, error: 'приватный и публичный ключ не образуют пару' };
  const config = await readConfig();
  const signKeys = config.signKeys.filter((item) => item.id !== key.id);
  signKeys.push({ id: key.id, publicKey: normalized, privateKey: seed.toString('base64') });
  await writeConfig({ ...config, signKeys });
  return { ok: true };
}

/** Импортировать seed существующего клиентского ключа и проверить его пару. */
export async function importSignKey(id: string, privateKey: string): Promise<PublishResult> {
  const trimmedId = String(id ?? '').trim();
  const seed = Buffer.from(String(privateKey ?? '').trim(), 'base64');
  if (!KEY_ID.test(trimmedId)) return { ok: false, error: 'некорректный id ключа' };
  if (seed.length !== 32) return { ok: false, error: 'приватный ключ должен быть seed из 32 байт в base64' };
  return storeSignKey({ id: trimmedId, privateKey: seed.toString('base64'), publicKey: deriveEd25519Public(seed) });
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

export async function readLauncherBinary(platform: string): Promise<Buffer | null> {
  if (!PLATFORM.test(platform)) return null;
  try {
    return await readFile(launcherBinaryPath(platform));
  } catch {
    return null;
  }
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
  /** Internal hook used by the admin release job; never comes from JSON. */
  onProgress?: HelperReleaseProgressHandler;
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

/** Серверный ключ, которым администратор выпускает релиз без внешнего CI. */
function serverSigningKey(): { id: string; seed: Buffer; clientTrusted: boolean } | null {
  const config = readConfigSync();
  // Ключи, зашитые в установленные программы (uploader/bundle.py из этого же
  // репозитория). Пакет, подписанный любым другим ключом, клиенты отвергнут
  // с «подпись сделана неизвестным ключом» — это и ломало обновление.
  const clientKeys = clientTrustedKeys();
  const isClientTrusted = (id: string, publicKey: string): boolean =>
    clientKeys.size > 0 && clientKeys.get(id) === publicKey;
  for (const key of [...config.signKeys].reverse()) {
    if (!key.privateKey) continue;
    const seed = Buffer.from(key.privateKey, 'base64');
    if (seed.length === 32 && deriveEd25519Public(seed) === key.publicKey) {
      return { id: key.id, seed, clientTrusted: isClientTrusted(key.id, key.publicKey) };
    }
  }
  // Переходный вариант: существующий секрет можно перенести с CI на сервер
  // через env, не открывая его в браузере.
  const envSeed = Buffer.from((process.env.UPLOADER_SIGN_KEY ?? '').trim(), 'base64');
  if (envSeed.length === 32) {
    const id = (process.env.UPLOADER_SIGN_KEY_ID ?? 'server').trim() || 'server';
    return { id, seed: envSeed, clientTrusted: isClientTrusted(id, deriveEd25519Public(envSeed)) };
  }
  return null;
}

function privateKeyFromSeed(seed: Buffer) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/** Публичная часть всех доверенных ключей для подготовки базовой сборки. */
export function trustedPublicKeys(): Record<string, string> {
  return Object.fromEntries(
    [...trustedKeys().entries()].map(([id, key]) => [id, key.toString('base64')]),
  );
}

/** CRC32 нужен только контейнеру ZIP; целостность кода защищает SHA-256 манифеста. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Минимальный стандартный ZIP без сторонней зависимости (deflate + UTF-8). */
export async function createZip(
  files: Map<string, Buffer>,
  onFile?: (completed: number, total: number) => void | Promise<void>,
): Promise<Buffer> {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let completed = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(path, 'utf8');
    const packed = await deflateRawAsync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);

    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50, 0);
    item.writeUInt16LE(20, 4);
    item.writeUInt16LE(20, 6);
    item.writeUInt16LE(0x0800, 8);
    item.writeUInt16LE(8, 10);
    item.writeUInt32LE(crc, 16);
    item.writeUInt32LE(packed.length, 20);
    item.writeUInt32LE(data.length, 24);
    item.writeUInt16LE(name.length, 28);
    item.writeUInt32LE(offset, 42);
    central.push(item, name);
    offset += header.length + name.length + packed.length;
    completed += 1;
    await onFile?.(completed, files.size);
  }
  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export interface HelperReleaseProgress {
  stage: 'validate' | 'hash' | 'sign' | 'archive' | 'publish' | 'complete';
  percent: number;
  message: string;
  stats?: Partial<{
    files: number;
    totalBytes: number;
    hashedFiles: number;
    storedBlobs: number;
    archiveBytes: number;
  }>;
}

export type HelperReleaseProgressHandler = (progress: HelperReleaseProgress) => void | Promise<void>;

export interface ServerReleaseInput {
  version: string;
  channel: Channel;
  notes?: string;
  minLauncher?: string;
  files: Map<string, Buffer>;
  promote?: boolean;
  /**
   * Осознанный выпуск ключом, которого НЕТ в TRUSTED_KEYS установленных
   * программ. По умолчанию такая публикация отвергается: пилоты не смогут
   * обновиться, пока не получат базовую сборку с зашитым публичным ключом.
   */
  allowUntrustedKey?: boolean;
  onProgress?: HelperReleaseProgressHandler;
}

/** Собрать, подписать и опубликовать версию целиком на этом сервере. */
export async function createServerRelease(input: ServerReleaseInput): Promise<PublishResult> {
  const report = input.onProgress;
  const totalInputBytes = [...input.files.values()].reduce((sum, data) => sum + data.length, 0);
  const progress = async (
    stage: HelperReleaseProgress['stage'],
    percent: number,
    message: string,
    stats?: HelperReleaseProgress['stats'],
  ) => report?.({ stage, percent, message, stats });

  await progress('validate', 4, 'Проверяю версию, ключ подписи и состав пакета', {
    files: input.files.size,
    totalBytes: totalInputBytes,
  });
  const version = String(input.version ?? '').trim().replace(/^v/i, '');
  if (!VERSION.test(version)) return { ok: false, error: 'версия должна иметь вид 2.13.1' };
  if ((await readManifest(version)) !== null) return { ok: false, error: `версия ${version} уже существует и неизменяема` };
  const signing = serverSigningKey();
  if (!signing) return { ok: false, error: 'на сервере нет приватного ключа подписи — создайте или импортируйте пару в настройках' };
  if (!signing.clientTrusted && !input.allowUntrustedKey) {
    const trusted = [...clientTrustedKeys().keys()];
    const known = trusted.length ? trusted.join(', ') : 'неизвестны — не найден uploader/bundle.py';
    return {
      ok: false,
      error: 'установленные программы не примут эту подпись: ключ ' + signing.id
        + ' не входит в TRUSTED_KEYS их сборок (доверенные ID: ' + known
        + '). Импортируйте приватный seed доверенного ключа в настройках '
        + 'канала либо выпустите базовую сборку с новым публичным ключом; '
        + 'выпустить всё равно можно осознанной отметкой в форме публикации.',
    };
  }

  const clean = new Map<string, Buffer>();
  let total = 0;
  for (const [rawPath, data] of input.files) {
    // При выборе каталога браузер присылает uploader/foo.py. В пакете нужен foo.py.
    const path = rawPath.replace(/\\/g, '/').replace(/^(?:.*\/)?uploader\//, '').replace(/^\/+/, '');
    if (!MEMBER.test(path) || path.includes('..')) {
      return { ok: false, error: `небезопасный путь ${rawPath}` };
    }
    // Текущий bundle-контракт — только корневые Python-модули, как у
    // build_bundle.py. Выбор каталога также приносит tests/, __pycache__,
    // README и requirements; они пилоту не нужны и не должны раздувать пакет.
    if (path.includes('/') || !path.endsWith('.py')) continue;
    if (['build_exe.py', 'build_bundle.py', 'launcher.py', 'updater.py'].includes(path)) continue;
    if (data.length > MAX_FILE_BYTES) return { ok: false, error: `файл ${path} слишком велик` };
    total += data.length;
    clean.set(path, data);
  }
  if (!clean.has('colonial_helper.py')) return { ok: false, error: 'в выбранном каталоге нет colonial_helper.py' };
  const sourceVersion = /^VERSION\s*=\s*["']([^"']+)["']/m.exec(clean.get('colonial_helper.py')!.toString('utf8'))?.[1] ?? '';
  if (sourceVersion !== version) {
    return { ok: false, error: `номер формы ${version} не совпадает с VERSION = ${sourceVersion || 'не найден'} в colonial_helper.py` };
  }
  if (clean.size > MAX_FILES || total > MAX_BUNDLE_BYTES) return { ok: false, error: 'пакет превышает допустимый размер' };

  await progress('validate', 16, `В пакет войдёт ${clean.size} модулей`, {
    files: clean.size,
    totalBytes: total,
  });
  const sortedFiles = [...clean.entries()].sort(([a], [b]) => a.localeCompare(b));
  const manifestFiles: ManifestFile[] = [];
  for (let index = 0; index < sortedFiles.length; index += 1) {
    const [path, data] = sortedFiles[index];
    manifestFiles.push({ path, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    await progress('hash', 20 + ((index + 1) / sortedFiles.length) * 22, `Хеширую модуль ${index + 1} из ${sortedFiles.length}: ${path}`, {
      files: clean.size,
      totalBytes: total,
      hashedFiles: index + 1,
    });
  }

  const manifest: BundleManifest = {
    schema: MANIFEST_SCHEMA,
    channel: input.channel,
    version,
    entry: 'colonial_helper.py',
    min_launcher: String(input.minLauncher || '1.0.0'),
    released_at: new Date().toISOString(),
    notes: String(input.notes ?? '').slice(0, 20_000),
    files: manifestFiles,
  };
  if (signing.clientTrusted) {
    await progress('sign', 48, `Подписываю манифест серверным ключом ${signing.id} (доверен установленным программам)`, {
      files: clean.size,
      totalBytes: total,
      hashedFiles: clean.size,
    });
  } else {
    // Сюда попадаем только при явном allowUntrustedKey: предупреждение должно
    // остаться в журнале задачи, чтобы выпуск новым ключом не был случайным.
    await progress('sign', 48, `ВНИМАНИЕ: подписываю ключом ${signing.id}, которого нет в TRUSTED_KEYS установленных программ, — они смогут обновиться только после новой базовой сборки`, {
      files: clean.size,
      totalBytes: total,
      hashedFiles: clean.size,
    });
  }
  const signature = cryptoSign(null, canonicalManifestBytes(manifest), privateKeyFromSeed(signing.seed));
  manifest.signature = { alg: 'ed25519', key_id: signing.id, value: signature.toString('base64') };

  const archiveFiles = new Map(clean);
  archiveFiles.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  await progress('archive', 55, 'Сжимаю ZIP-архив релиза');
  const archive = await createZip(archiveFiles, async (completed, count) => {
    await progress('archive', 55 + (completed / count) * 20, `Архивирую файл ${completed} из ${count}`, {
      files: clean.size,
      totalBytes: total,
      hashedFiles: clean.size,
    });
  });
  const files = Object.fromEntries([...clean].map(([path, data]) => [path, data.toString('base64')]));
  return publishBundle({
    manifest,
    files,
    bundleBase64: archive.toString('base64'),
    promote: input.promote,
    onProgress: async (event) => progress(event.stage, Math.max(76, event.percent), event.message, {
      files: clean.size,
      totalBytes: total,
      hashedFiles: clean.size,
      ...event.stats,
    }),
  });
}
/** Опубликовать пакет: разложить файлы по хешам и (по умолчанию) поднять канал. */
export async function publishBundle(input: PublishInput): Promise<PublishResult> {
  const checked = checkManifest(input.manifest);
  if (!checked.ok) return { ok: false, error: checked.error };
  const manifest = checked.manifest;

  const signature = verifyManifestSignature(manifest);
  if (!signature.ok) return { ok: false, error: `подпись: ${signature.error}` };
  await input.onProgress?.({
    stage: 'publish',
    percent: 78,
    message: 'Проверяю подпись и готовлю файлы хранилища',
    stats: { files: manifest.files.length, totalBytes: manifest.files.reduce((sum, item) => sum + item.size, 0) },
  });

  const files = input.files ?? {};
  const missing: string[] = [];
  let stored = 0;

  for (let index = 0; index < manifest.files.length; index += 1) {
    const item = manifest.files[index];
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
    } else {
      // Файла нет в запросе — он должен уже лежать в хранилище. Пустой ответ
      // здесь означает, что пакет собран из файлов, которых сервер не видел.
      if (!(await hasBlob(item.sha256))) missing.push(item.path);
    }
    await input.onProgress?.({
      stage: 'publish',
      percent: 78 + ((index + 1) / manifest.files.length) * 14,
      message: `Проверен файл ${index + 1} из ${manifest.files.length}: ${item.path}`,
      stats: { files: manifest.files.length, totalBytes: manifest.files.reduce((sum, row) => sum + row.size, 0), hashedFiles: index + 1, storedBlobs: stored },
    });
  }

  if (missing.length > 0) {
    // Отдаём список: CI может дослать только недостающее, не гоняя пакет целиком.
    return { ok: false, error: 'не хватает файлов', missing, version: manifest.version };
  }

  if (input.bundleBase64) {
    const archive = Buffer.from(input.bundleBase64, 'base64');
    if (archive.length > MAX_BUNDLE_BYTES) return { ok: false, error: 'архив слишком велик' };
    await writeAtomic(bundlePath(manifest.version), archive);
    await input.onProgress?.({ stage: 'publish', percent: 94, message: `ZIP сохранён (${archive.length} байт)`, stats: { archiveBytes: archive.length, storedBlobs: stored } });
  }

  await writeAtomic(manifestPath(manifest.version), JSON.stringify(manifest, null, 2));

  if (input.promote !== false) {
    await writeAtomic(
      channelPath(manifest.channel),
      JSON.stringify({ version: manifest.version, updated_at: new Date().toISOString() }, null, 2),
    );
    await input.onProgress?.({ stage: 'publish', percent: 98, message: `Канал «${manifest.channel}» переключён на ${manifest.version}` });
  }
  await input.onProgress?.({ stage: 'complete', percent: 100, message: 'Релиз опубликован и проверен', stats: { storedBlobs: stored } });

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

// ---------------------------------------------------------------------------
//  Ремонт канала: переподпись текущих версий ключом клиентов
// ---------------------------------------------------------------------------
export interface ResignChannelOutcome {
  channel: string;
  version: string;
  /** signed — переподписано; kept — подпись уже верна; missing — версии нет. */
  action: 'signed' | 'kept' | 'missing';
  keyId: string;
}

export interface ResignChannelsResult {
  ok: boolean;
  error?: string;
  outcomes: ResignChannelOutcome[];
}

/**
 * Переподписать манифесты, на которые указывают каналы, ключом, который
 * установленным программам знаком по TRUSTED_KEYS.
 *
 * Лечит канал, опубликованный чужим ключом: именно тогда пилоты видят
 * «канал недоступен: подпись сделана неизвестным ключом» и не могут
 * обновиться. Состав файлов версии не меняется — заменяется только блок
 * signature, поэтому это безопасно при неизменяемости версий.
 */
export async function resignChannelManifests(
  channels: readonly Channel[] = CHANNELS,
): Promise<ResignChannelsResult> {
  const outcomes: ResignChannelOutcome[] = [];
  const signing = serverSigningKey();
  const clientKeys = clientTrustedKeys();
  if (!signing || !signing.clientTrusted) {
    const trusted = [...clientKeys.keys()];
    return {
      ok: false,
      error: 'на сервере нет приватного ключа, доверенного установленным программам'
        + (trusted.length ? ` (доверенные ID: ${trusted.join(', ')}). Импортируйте его приватный seed в настройках канала`
          : ' — не найден uploader/bundle.py с TRUSTED_KEYS'),
      outcomes,
    };
  }

  for (const channel of channels) {
    const version = await readChannelVersion(channel);
    if (!version) {
      outcomes.push({ channel, version: '', action: 'missing', keyId: signing.id });
      continue;
    }
    const manifest = await readManifest(version);
    if (!manifest) {
      outcomes.push({ channel, version, action: 'missing', keyId: signing.id });
      continue;
    }
    const keyId = String(manifest.signature?.key_id ?? '');
    const integrity = verifyManifestSignature(manifest);
    // Подпись трогаем только если она не от доверенного клиентами ключа
    // либо не сходится вовсе: переподписывать исправное не нужно.
    if (integrity.ok && keyId && clientKeys.has(keyId)) {
      outcomes.push({ channel, version, action: 'kept', keyId });
      continue;
    }
    const { signature: _dropped, ...payload } = manifest;
    const value = cryptoSign(null, canonicalManifestBytes(payload as Record<string, unknown>), privateKeyFromSeed(signing.seed));
    const resigned = { ...payload, signature: { alg: 'ed25519', key_id: signing.id, value: value.toString('base64') } };
    const verification = verifyManifestSignature(resigned);
    if (!verification.ok) {
      return { ok: false, error: `переподписанная версия ${version} не прошла проверку: ${verification.error ?? '?'}`, outcomes };
    }
    await writeAtomic(manifestPath(version), JSON.stringify(resigned, null, 2));
    outcomes.push({ channel, version, action: 'signed', keyId: signing.id });
  }
  return { ok: true, outcomes };
}

/** Сохранить exe непосредственно на сервере и его проверяемые метаданные. */
export async function saveLauncherBinary(
  platform: string,
  version: string,
  data: Buffer,
  publicUrl: string,
  onProgress?: HelperReleaseProgressHandler,
): Promise<PublishResult> {
  await onProgress?.({ stage: 'validate', percent: 8, message: 'Проверяю версию и заголовок Windows PE', stats: { files: 1, totalBytes: data.length } });
  if (!isValidLauncherPlatform(platform)) return { ok: false, error: 'плохая платформа' };
  if (!isValidLauncherVersion(version)) return { ok: false, error: 'плохая версия лаунчера' };
  if (data.length < 1024 || data.length > MAX_LAUNCHER_UPLOAD_BYTES) return { ok: false, error: 'некорректный размер exe' };
  if (data[0] !== 0x4d || data[1] !== 0x5a) return { ok: false, error: 'файл не похож на Windows PE (нет заголовка MZ)' };
  await onProgress?.({ stage: 'hash', percent: 36, message: 'Считаю SHA-256 базовой сборки', stats: { files: 1, totalBytes: data.length } });
  const sha256 = createHash('sha256').update(data).digest('hex');
  await onProgress?.({ stage: 'publish', percent: 70, message: 'Сохраняю ColonialHelper.exe в хранилище', stats: { files: 1, totalBytes: data.length } });
  await writeAtomic(launcherBinaryPath(platform), data);
  const result = await saveLauncher({
    platform,
    version,
    url: publicUrl,
    sha256,
    size: data.length,
  });
  await onProgress?.({ stage: result.ok ? 'complete' : 'publish', percent: result.ok ? 100 : 90, message: result.ok ? 'Базовая сборка опубликована' : (result.error || 'Не удалось сохранить метаданные'), stats: { files: 1, totalBytes: data.length } });
  return result;
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
  /** Ключи из config.json — приватная часть никогда не возвращается. */
  configKeys: Array<SignKeyConfig & { hasPrivate: boolean }>;
  /** Сервер способен сам подписывать релизы, без GitHub Actions/CI. */
  serverSigningConfigured: boolean;
  /** Каким ключом сервер подпишет следующий релиз ('' — подписи нет). */
  serverSigningKeyId: string;
  /** Входит ли этот ключ в TRUSTED_KEYS установленных программ. */
  serverSigningClientTrusted: boolean;
  /** Ключи, зашитые в установленные программы (публичная информация). */
  clientTrustedKeys: Record<string, string>;
}

export async function storeStatus(): Promise<StoreStatus> {
  const root = storeRoot();
  let ready = false;
  try {
    ready = (await stat(/*turbopackIgnore: true*/ root)).isDirectory();
  } catch {
    ready = false;
  }
  const config = await readConfig();
  const envToken = (process.env.UPLOADER_PUBLISH_TOKEN ?? '').trim().length > 0;
  const publishTokenSource = envToken ? 'env' : config.publishToken ? 'config' : 'none';
  const signing = serverSigningKey();
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
    configKeys: config.signKeys.map(({ id, publicKey, privateKey }) => ({
      id,
      publicKey,
      hasPrivate: Boolean(privateKey),
    })),
    serverSigningConfigured: signing !== null,
    serverSigningKeyId: signing?.id ?? '',
    serverSigningClientTrusted: signing?.clientTrusted ?? false,
    clientTrustedKeys: Object.fromEntries(clientTrustedKeys()),
  };
}
