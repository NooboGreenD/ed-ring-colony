import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isValidLauncherPlatform,
  isValidLauncherVersion,
  storeRoot,
} from '@/lib/uploaderStore';
import {
  LAUNCHER_UPLOAD_CHUNK_BYTES,
  MAX_LAUNCHER_UPLOAD_BYTES,
  MIN_LAUNCHER_UPLOAD_CHUNK_BYTES,
} from '@/lib/launcherUploadProtocol';

const SESSION_DIR_NAME = '.launcher-upload-staging';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 4;

export interface LauncherUploadSession {
  id: string;
  platform: string;
  version: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  createdAt: number;
  jobId?: string;
}

export class LauncherUploadError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'LauncherUploadError';
  }
}

function stagingRoot(): string {
  return join(storeRoot(), SESSION_DIR_NAME);
}

function sessionDir(id: string): string {
  return join(stagingRoot(), id);
}

function metadataPath(id: string): string {
  return join(sessionDir(id), 'session.json');
}

function chunksDir(id: string): string {
  return join(sessionDir(id), 'chunks');
}

function chunkPath(id: string, index: number): string {
  return join(chunksDir(id), `${String(index).padStart(6, '0')}.part`);
}

function finalizeLockPath(id: string): string {
  return join(sessionDir(id), '.finalizing');
}

function validId(id: string): boolean {
  return SESSION_ID.test(id);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function persistSession(session: LauncherUploadSession): Promise<void> {
  const target = metadataPath(session.id);
  const temporary = join(sessionDir(session.id), `.session-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(session), { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseSession(id: string, value: unknown): LauncherUploadSession {
  if (!value || typeof value !== 'object') {
    throw new LauncherUploadError('Повреждена сессия загрузки', 500);
  }
  const session = value as Partial<LauncherUploadSession>;
  if (
    session.id !== id
    || !isValidLauncherPlatform(String(session.platform ?? ''))
    || !isValidLauncherVersion(String(session.version ?? ''))
    || !Number.isSafeInteger(session.size)
    || Number(session.size) < 1024
    || Number(session.size) > MAX_LAUNCHER_UPLOAD_BYTES
    || !Number.isSafeInteger(session.chunkSize)
    || Number(session.chunkSize) < MIN_LAUNCHER_UPLOAD_CHUNK_BYTES
    || Number(session.chunkSize) > LAUNCHER_UPLOAD_CHUNK_BYTES
    || session.totalChunks !== Math.ceil(Number(session.size) / Number(session.chunkSize))
    || !Number.isFinite(session.createdAt)
    || (session.jobId !== undefined && !validId(String(session.jobId)))
  ) {
    throw new LauncherUploadError('Повреждена сессия загрузки', 500);
  }
  return session as LauncherUploadSession;
}

async function readSession(id: string): Promise<LauncherUploadSession> {
  if (!validId(id)) throw new LauncherUploadError('Неверный идентификатор загрузки', 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metadataPath(id), 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) throw new LauncherUploadError('Сессия загрузки не найдена', 404);
    if (error instanceof SyntaxError) throw new LauncherUploadError('Повреждена сессия загрузки', 500);
    throw error;
  }
  const session = parseSession(id, parsed);
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    await rm(sessionDir(id), { recursive: true, force: true });
    throw new LauncherUploadError('Срок сессии загрузки истёк; начните загрузку заново', 410);
  }
  return session;
}

async function pruneExpiredSessions(): Promise<number> {
  const root = stagingRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }

  let active = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const dir = sessionDir(entry.name);
    let session: LauncherUploadSession | null = null;
    try {
      session = parseSession(entry.name, JSON.parse(await readFile(metadataPath(entry.name), 'utf8')) as unknown);
    } catch {
      try {
        const info = await stat(dir);
        if (Date.now() - info.mtimeMs > SESSION_TTL_MS) {
          await rm(dir, { recursive: true, force: true });
        } else {
          active += 1;
        }
      } catch {
        // A concurrently completed/cancelled upload is already gone.
      }
      continue;
    }

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      await rm(dir, { recursive: true, force: true });
    } else if (!session.jobId) {
      active += 1;
    }
  }
  return active;
}

export async function createLauncherUpload(input: {
  platform: string;
  version: string;
  size: number;
  chunkSize?: number;
}): Promise<LauncherUploadSession> {
  const platform = input.platform.trim().toLowerCase();
  const version = input.version.trim();
  const chunkSize = input.chunkSize ?? LAUNCHER_UPLOAD_CHUNK_BYTES;
  if (!isValidLauncherPlatform(platform)) throw new LauncherUploadError('Плохая платформа', 400);
  if (!isValidLauncherVersion(version)) throw new LauncherUploadError('Плохая версия лаунчера', 400);
  if (!Number.isSafeInteger(input.size) || input.size < 1024) {
    throw new LauncherUploadError('Некорректный размер exe', 400);
  }
  if (input.size > MAX_LAUNCHER_UPLOAD_BYTES) {
    throw new LauncherUploadError('Размер exe превышает 128 МиБ', 413);
  }
  if (
    !Number.isSafeInteger(chunkSize)
    || chunkSize < MIN_LAUNCHER_UPLOAD_CHUNK_BYTES
    || chunkSize > LAUNCHER_UPLOAD_CHUNK_BYTES
  ) {
    throw new LauncherUploadError('Недопустимый размер части загрузки', 400);
  }

  await mkdir(stagingRoot(), { recursive: true, mode: 0o700 });
  const active = await pruneExpiredSessions();
  if (active >= MAX_ACTIVE_SESSIONS) {
    throw new LauncherUploadError('Уже выполняются другие загрузки базовой сборки', 429);
  }

  const id = randomUUID();
  const session: LauncherUploadSession = {
    id,
    platform,
    version,
    size: input.size,
    chunkSize,
    totalChunks: Math.ceil(input.size / chunkSize),
    createdAt: Date.now(),
  };
  await mkdir(sessionDir(id), { recursive: false, mode: 0o700 });
  try {
    await mkdir(chunksDir(id), { recursive: false, mode: 0o700 });
    await persistSession(session);
  } catch (error) {
    await rm(sessionDir(id), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return session;
}

export async function getLauncherUploadSession(id: string): Promise<LauncherUploadSession> {
  return readSession(id);
}

export async function writeLauncherUploadChunk(id: string, index: number, data: Buffer): Promise<void> {
  const session = await readSession(id);
  if (session.jobId) throw new LauncherUploadError('Загрузка уже передана в обработку', 409);
  if (!Number.isSafeInteger(index) || index < 0 || index >= session.totalChunks) {
    throw new LauncherUploadError('Неверный номер части загрузки', 400);
  }

  try {
    await stat(finalizeLockPath(id));
    throw new LauncherUploadError('Файл уже собирается на сервере', 409);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const expectedSize = Math.min(session.chunkSize, session.size - index * session.chunkSize);
  if (data.length !== expectedSize) {
    throw new LauncherUploadError(`Неверный размер части ${index + 1}: ожидалось ${expectedSize} байт`, 400);
  }

  const target = chunkPath(id, index);
  const temporary = join(chunksDir(id), `.${index}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function acquireLauncherUploadFinalizeLock(id: string): Promise<boolean> {
  const session = await readSession(id);
  if (session.jobId) return false;
  try {
    await mkdir(finalizeLockPath(id), { recursive: false, mode: 0o700 });
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
}

export async function releaseLauncherUploadFinalizeLock(id: string): Promise<void> {
  if (!validId(id)) return;
  await rm(finalizeLockPath(id), { recursive: true, force: true });
}

export async function assembleLauncherUpload(id: string): Promise<{
  session: LauncherUploadSession;
  data: Buffer;
}> {
  const session = await readSession(id);
  if (session.jobId) throw new LauncherUploadError('Загрузка уже передана в обработку', 409);

  const parts: Buffer[] = [];
  for (let index = 0; index < session.totalChunks; index += 1) {
    let part: Buffer;
    try {
      part = await readFile(chunkPath(id, index));
    } catch (error) {
      if (isMissing(error)) {
        throw new LauncherUploadError(`Не загружена часть ${index + 1} из ${session.totalChunks}`, 409);
      }
      throw error;
    }
    const expectedSize = Math.min(session.chunkSize, session.size - index * session.chunkSize);
    if (part.length !== expectedSize) {
      throw new LauncherUploadError(`Повреждена часть ${index + 1}; повторите загрузку`, 409);
    }
    parts.push(part);
  }

  return { session, data: Buffer.concat(parts, session.size) };
}

export async function markLauncherUploadCompleted(id: string, jobId: string): Promise<void> {
  if (!validId(jobId)) throw new LauncherUploadError('Неверный идентификатор задачи', 500);
  const session = await readSession(id);
  if (session.jobId && session.jobId !== jobId) {
    throw new LauncherUploadError('Эта загрузка уже привязана к другой задаче', 409);
  }
  session.jobId = jobId;
  await persistSession(session);
  await rm(chunksDir(id), { recursive: true, force: true });
}

export async function cancelLauncherUpload(id: string): Promise<boolean> {
  let session: LauncherUploadSession;
  try {
    session = await readSession(id);
  } catch (error) {
    if (error instanceof LauncherUploadError && error.status === 404) return false;
    throw error;
  }
  if (session.jobId) return false;
  if (!(await acquireLauncherUploadFinalizeLock(id))) return false;
  try {
    session = await readSession(id);
    if (session.jobId) return false;
    await rm(sessionDir(id), { recursive: true, force: true });
    return true;
  } finally {
    await releaseLauncherUploadFinalizeLock(id);
  }
}
