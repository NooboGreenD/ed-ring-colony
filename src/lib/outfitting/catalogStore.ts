/** Server-only persistence for catalogue overlays. Production never falls back to disk on DB errors. */
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabaseAdmin';
import type { OutfittingData } from './types';
import { CatalogError, EMPTY_CATALOG_STATE, isRecord, type CatalogState } from './catalog';

const TABLE = 'outfitting_catalog';
let source: Promise<OutfittingData> | null = null;

export function loadCatalogSource(): Promise<OutfittingData> {
  if (!source) {
    source = readFile(path.join(process.cwd(), 'public', 'data', 'outfitting.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as OutfittingData)
      .catch((error) => { source = null; throw error; });
  }
  return source;
}

function configured(): boolean {
  return !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function catalogStorage(): 'supabase' | 'local' | 'source' {
  if (configured()) return 'supabase';
  return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test' ? 'local' : 'source';
}

function filePath(): string {
  return process.env.OUTFITTING_DATA_FILE || path.join(process.cwd(), 'data', 'outfitting', 'catalog.json');
}

function stateFrom(input: unknown): CatalogState {
  if (!isRecord(input) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0
    || !isRecord(input.changes) || !Array.isArray(input.history)) {
    throw new CatalogError('Хранилище верфи повреждено. Проверьте резервную копию', 503);
  }
  return input as unknown as CatalogState;
}

async function readLocal(): Promise<CatalogState> {
  try {
    return stateFrom(JSON.parse(await readFile(/* turbopackIgnore: true */ filePath(), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY_CATALOG_STATE);
    throw error;
  }
}

function dbError(error: { code?: string; message: string }): never {
  console.error('[outfitting/catalog]', error.code, error.message);
  if (['42P01', 'PGRST205', 'PGRST204'].includes(error.code || '')) {
    throw new CatalogError('Примените миграцию 20261010010000_outfitting_catalog.sql: хранилище верфи не создано', 503);
  }
  throw new CatalogError('База данных верфи недоступна. Изменения не сохранены, повторите позже', 503);
}

export async function readCatalogState(): Promise<CatalogState> {
  const storage = catalogStorage();
  if (storage === 'local') return readLocal();
  if (storage === 'source') return structuredClone(EMPTY_CATALOG_STATE);
  const { data, error } = await createAdminClient().from(TABLE).select('revision,changes,history,updated_at').eq('id', 1).maybeSingle();
  if (error) dbError(error);
  if (!data) throw new CatalogError('Каталог не инициализирован. Примените миграцию верфи', 503);
  return stateFrom({ revision: Number(data.revision), changes: data.changes, history: data.history, updatedAt: data.updated_at });
}

const CONFLICT = 'Каталог изменён другим администратором. Обновите список и повторите действие';

/** Compare-and-swap protects BOTH new IDs and edits against concurrent admins. */
export async function saveCatalogState(expectedRevision: number, next: CatalogState): Promise<void> {
  const storage = catalogStorage();
  if (storage === 'source') throw new CatalogError('Для сохранения настройте подключение к Supabase и примените миграцию верфи', 503);
  if (storage === 'supabase') {
    const { data, error } = await createAdminClient().from(TABLE).update({
      revision: next.revision, changes: next.changes, history: next.history, updated_at: next.updatedAt,
    }).eq('id', 1).eq('revision', expectedRevision).select('revision').maybeSingle();
    if (error) dbError(error);
    if (!data) throw new CatalogError(CONFLICT, 409);
    return;
  }
  // Dev only: an exclusive filesystem lock works across Next route bundles;
  // rename makes the JSON replacement atomic and errors are never swallowed.
  const file = filePath();
  await mkdir(path.dirname(file), { recursive: true });
  let lock;
  try {
    lock = await open(/* turbopackIgnore: true */ `${file}.lock`, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CatalogError('Каталог сейчас сохраняется. Повторите действие через несколько секунд', 409);
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const current = await readLocal();
    if (current.revision !== expectedRevision) throw new CatalogError(CONFLICT, 409);
    const output = await open(/* turbopackIgnore: true */ temporary, 'wx', 0o600);
    try { await output.writeFile(JSON.stringify(next, null, 2), 'utf8'); }
    finally { await output.close(); }
    await rename(/* turbopackIgnore: true */ temporary, /* turbopackIgnore: true */ file);
  } finally {
    await unlink(/* turbopackIgnore: true */ temporary).catch(() => {});
    await lock.close();
    await unlink(/* turbopackIgnore: true */ `${file}.lock`);
  }
}
