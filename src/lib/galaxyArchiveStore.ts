/**
 * Disk housekeeping for the Spansh dumps.
 *
 * The catalog data does not fit next to the application: the full archive is
 * 5.9 GiB, its unpacked shards another ~5–6 GiB (the raw `systems.json` would
 * be 32+ GiB — that is exactly why the shards are gzipped TSV and the raw JSON
 * is never written to disk). On the production host all of it lives on a
 * separate disk mounted for the purpose (`/mnt/sdb/...` → `/app/data/spansh`
 * in the container), and this module keeps that disk from filling up:
 *
 *  - before a new dump is downloaded, the archives of other variants and the
 *    shards that belong to a different archive are deleted;
 *  - after a successful import the archive it was read from is deleted too
 *    (`GALAXY_ARCHIVE_KEEP=1` opts out), because the next refresh is a small
 *    delta, not this file again;
 *  - a download that obviously does not fit is refused up front with the
 *    numbers, instead of dying with ENOSPC after hours of transfer.
 *
 * Everything here is deliberately defensive: a missing directory, a disk that
 * does not answer `statfs`, a file that vanished between `readdir` and `stat`
 * must never abort an import.
 */

import { existsSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  DUMP_LADDER,
  DUMP_VARIANTS,
  archiveFileNameForVariant,
  type GalaxyDumpVariant,
} from './galaxyDumpVariants.ts';
import { formatBytes, galaxyArchiveDir, galaxyImportFile } from './galaxyImport.ts';
import { SHARD_MANIFEST, getShardStatus, manifestMatchesArchive, readShardManifest, shardsDir } from './galaxyShards.ts';

/** Sidecar with the per-segment progress of a parallel download. */
export const PARTS_SUFFIX = '.parts.json';

/** Headroom on top of the published size: HTTP sizes drift, filesystems round. */
const SPACE_MARGIN = 1.05;

export interface RemovedFile {
  path: string;
  bytes: number;
}

export interface CleanupResult {
  removed: RemovedFile[];
  freed: number;
}

const EMPTY_CLEANUP: CleanupResult = { removed: [], freed: 0 };

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * `GALAXY_ARCHIVE_KEEP=1` keeps the archive after a successful import. Default
 * is to delete it: it is a download cache, not data — the catalog itself lives
 * in Postgres, and re-importing the same file is never the next step.
 */
export function archiveKeepAfterImport(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GALAXY_ARCHIVE_KEEP?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * `GALAXY_SHARDS_KEEP=1` keeps unpacked shards even when the archive they came
 * from is gone. Off by default: once a newer dump is being downloaded the old
 * shards describe a catalog that no longer exists, and they cost as much as
 * the archive itself.
 */
export function shardsKeepAlways(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GALAXY_SHARDS_KEEP?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** `GALAXY_DISK_CHECK=0` disables the "does it fit?" guard. */
export function diskCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.GALAXY_DISK_CHECK?.trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

export interface DiskUsage {
  /** Directory the numbers describe (the nearest existing parent). */
  path: string;
  total: number;
  free: number;
  used: number;
}

/**
 * Free space of the filesystem holding `dir`. Walks up to the nearest existing
 * parent so it also answers before the directory has been created.
 */
export function diskUsage(dir: string = galaxyArchiveDir()): DiskUsage | null {
  let current = resolve(dir);
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(current)) {
      try {
        const stat = statfsSync(current);
        const total = Number(stat.blocks) * Number(stat.bsize);
        // `bavail` (not `bfree`) is what a non-root process may actually use.
        const free = Number(stat.bavail) * Number(stat.bsize);
        if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
        return { path: current, total, free, used: Math.max(0, total - free) };
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export interface ArchiveOnDisk {
  variant: GalaxyDumpVariant;
  file: string;
  path: string;
  bytes: number;
  mtime: string | null;
  /** A `.parts.json` sidecar means the download is still unfinished. */
  partial: boolean;
}

/** Dump archives currently on disk, newest variant order first. */
export function listArchives(dir: string = galaxyArchiveDir()): ArchiveOnDisk[] {
  const out: ArchiveOnDisk[] = [];
  for (const variant of DUMP_LADDER) {
    const file = archiveFileNameForVariant(variant);
    const path = join(dir, file);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    out.push({
      variant,
      file,
      path,
      bytes: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
      partial: existsSync(`${path}${PARTS_SUFFIX}`),
    });
  }
  return out;
}

function removeFile(path: string, log?: (line: string) => void): RemovedFile | null {
  if (!existsSync(path)) return null;
  const bytes = sizeOf(path);
  try {
    rmSync(path, { force: true });
  } catch (error) {
    log?.(`Не удалось удалить ${path}: ${(error as Error).message}`);
    return null;
  }
  if (existsSync(path)) return null;
  return { path, bytes };
}

/**
 * Delete every dump archive except the ones in `keep` (plus the pinned
 * `GALAXY_IMPORT_FILE`, which belongs to the operator and is never touched).
 * Called right before a new download: the previous dump is dead weight the
 * moment a newer one starts arriving.
 */
export function pruneArchives(args: {
  dir?: string;
  keep?: Array<GalaxyDumpVariant | string | null | undefined>;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): CleanupResult {
  const env = args.env ?? process.env;
  const dir = args.dir ?? galaxyArchiveDir(env);
  if (!existsSync(dir)) return EMPTY_CLEANUP;

  const pinned = galaxyImportFile(env);
  const keepPaths = new Set<string>();
  if (pinned) keepPaths.add(resolve(pinned));
  for (const entry of args.keep ?? []) {
    if (!entry) continue;
    const file = entry in DUMP_VARIANTS ? archiveFileNameForVariant(entry as GalaxyDumpVariant) : entry;
    keepPaths.add(resolve(file.includes('/') ? file : join(dir, file)));
  }

  const removed: RemovedFile[] = [];
  for (const archive of listArchives(dir)) {
    if (keepPaths.has(resolve(archive.path))) continue;
    const gone = removeFile(archive.path, args.log);
    if (!gone) continue;
    removed.push(gone);
    // The segment plan of a half-finished download goes with its file.
    const parts = removeFile(`${archive.path}${PARTS_SUFFIX}`, args.log);
    if (parts) removed.push(parts);
    args.log?.(`Удалён предыдущий дамп ${archive.file} — освобождено ${formatBytes(gone.bytes)}`);
  }
  return { removed, freed: removed.reduce((sum, item) => sum + item.bytes, 0) };
}

/**
 * Drop shards that were unpacked from a different archive. Keeping them would
 * mean importing yesterday's rows from a file nobody can verify, and on this
 * disk they cost as much as the archive itself.
 */
export function pruneShards(args: {
  dir?: string;
  /**
   * Archive(s) the shards may belong to: if the manifest matches any of them
   * the shards are kept. Omit (or pass null) to delete them unconditionally.
   */
  archive?: string | string[] | null;
  /**
   * Strict mode: shards survive only while the archive they were unpacked from
   * is still on disk. `manifestMatchesArchive` alone also accepts shards whose
   * archive is gone (they may have been copied over by hand) — correct when
   * deciding what to import, wrong when deciding what to delete before the
   * next dump arrives.
   */
  strict?: boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): CleanupResult {
  const env = args.env ?? process.env;
  const dir = args.dir ?? shardsDir(env);
  if (!existsSync(dir)) return EMPTY_CLEANUP;
  if (shardsKeepAlways(env)) return EMPTY_CLEANUP;

  const candidates = (Array.isArray(args.archive) ? args.archive : [args.archive]).filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  if (candidates.length > 0) {
    const manifest = readShardManifest(dir);
    const matches = candidates.some(
      (archive) => (!args.strict || existsSync(archive)) && manifestMatchesArchive(manifest, archive),
    );
    if (manifest && matches) return EMPTY_CLEANUP;
  }

  const status = getShardStatus(dir);
  if (status.files === 0 && !existsSync(join(dir, SHARD_MANIFEST))) return EMPTY_CLEANUP;

  const removed: RemovedFile[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return EMPTY_CLEANUP;
  }
  for (const name of names) {
    if (!name.endsWith('.tsv.gz') && name !== SHARD_MANIFEST) continue;
    const gone = removeFile(join(dir, name), args.log);
    if (gone) removed.push(gone);
  }
  const freed = removed.reduce((sum, item) => sum + item.bytes, 0);
  if (removed.length > 0) {
    args.log?.(`Удалены шарды предыдущего дампа (${removed.length} файл(ов), ${formatBytes(freed)})`);
  }
  return { removed, freed };
}

/**
 * Housekeeping before a download: keep only the file we are about to fetch and
 * the shards that match it. Returns what was freed and how much room is left,
 * so the caller can tell the operator both numbers in one log line.
 */
export function cleanupBeforeDownload(args: {
  variant: GalaxyDumpVariant;
  dir?: string;
  /** Shard directory, when it is not the one `GALAXY_SHARDS_DIR` names (CLI `--shards-dir`). */
  shards?: string;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): CleanupResult & { free: number | null } {
  const env = args.env ?? process.env;
  const dir = args.dir ?? galaxyArchiveDir(env);
  const target = join(dir, archiveFileNameForVariant(args.variant));

  // The shard decision is made against the file we are about to download: the
  // shards of any other dump are obsolete the moment a newer one starts.
  const shards = pruneShards({ dir: args.shards ?? shardsDir(env), archive: target, strict: true, log: args.log, env });
  const archives = pruneArchives({ dir, keep: [args.variant], log: args.log, env });
  const removed = [...archives.removed, ...shards.removed];
  const freed = archives.freed + shards.freed;
  const free = diskUsage(dir)?.free ?? null;
  if (freed > 0) {
    args.log?.(
      `Освобождено ${formatBytes(freed)}${free === null ? '' : `, свободно на диске: ${formatBytes(free)}`}`,
    );
  }
  return { removed, freed, free };
}

export interface SpaceCheck {
  ok: boolean;
  /** Bytes still to be transferred (published size minus what is on disk). */
  need: number;
  free: number | null;
  message: string | null;
}

/**
 * Refuse a download that cannot fit. Six gibibytes take days on a thin line —
 * finding out about ENOSPC at the end of that is the worst possible outcome.
 */
export function checkDiskSpace(args: {
  variant: GalaxyDumpVariant;
  dir?: string;
  /** Bytes of the target file already on disk (a resumed download needs less). */
  have?: number;
  /** Also budget for the unpacked shards (≈ the archive again). */
  withShards?: boolean;
  env?: NodeJS.ProcessEnv;
}): SpaceCheck {
  const env = args.env ?? process.env;
  const dir = args.dir ?? galaxyArchiveDir(env);
  const approx = DUMP_VARIANTS[args.variant].approxBytes;
  const have = Math.max(0, args.have ?? 0);
  const need = Math.max(0, Math.round((approx * (args.withShards ? 2 : 1) - have) * SPACE_MARGIN));
  const usage = diskUsage(dir);
  const free = usage?.free ?? null;

  if (!diskCheckEnabled(env) || free === null || need === 0) {
    return { ok: true, need, free, message: null };
  }
  if (free >= need) {
    return { ok: true, need, free, message: null };
  }
  return {
    ok: false,
    need,
    free,
    message:
      `Недостаточно места: на диске ${usage?.path ?? dir} свободно ${formatBytes(free)}, ` +
      `для «${DUMP_VARIANTS[args.variant].label}» нужно ~${formatBytes(need)}. ` +
      'Освободите место, смонтируйте том побольше в GALAXY_ARCHIVE_DIR ' +
      'или отключите проверку через GALAXY_DISK_CHECK=0.',
  };
}

/**
 * Delete the archive an import has just finished reading. The rows are in
 * Postgres now and the next refresh is a delta, so this file would only sit on
 * the disk until the next cold start. `GALAXY_ARCHIVE_KEEP=1` and a pinned
 * `GALAXY_IMPORT_FILE` both veto the deletion.
 */
export function releaseArchiveAfterImport(args: {
  path: string | null | undefined;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}): CleanupResult & { kept: boolean; reason: string | null } {
  const env = args.env ?? process.env;
  const path = args.path?.trim();
  if (!path || !existsSync(path)) return { ...EMPTY_CLEANUP, kept: false, reason: null };

  const pinned = galaxyImportFile(env);
  if (pinned && resolve(pinned) === resolve(path)) {
    return { ...EMPTY_CLEANUP, kept: true, reason: 'файл закреплён через GALAXY_IMPORT_FILE' };
  }
  if (archiveKeepAfterImport(env)) {
    return { ...EMPTY_CLEANUP, kept: true, reason: 'GALAXY_ARCHIVE_KEEP=1' };
  }

  const removed: RemovedFile[] = [];
  const gone = removeFile(path, args.log);
  if (!gone) return { ...EMPTY_CLEANUP, kept: true, reason: 'файл не удалось удалить' };
  removed.push(gone);
  const parts = removeFile(`${path}${PARTS_SUFFIX}`, args.log);
  if (parts) removed.push(parts);

  const freed = removed.reduce((sum, item) => sum + item.bytes, 0);
  const free = diskUsage(dirname(path))?.free ?? null;
  args.log?.(
    `Архив ${path} удалён после успешного импорта — освобождено ${formatBytes(freed)}` +
      `${free === null ? '' : `, свободно ${formatBytes(free)}`}`,
  );
  return { removed, freed, kept: false, reason: null };
}

export interface GalaxyStorageStatus {
  dir: string;
  shards_dir: string;
  disk: DiskUsage | null;
  archives: ArchiveOnDisk[];
  archives_bytes: number;
  shards_files: number;
  shards_bytes: number;
  /** Total the catalog import occupies on this disk right now. */
  total_bytes: number;
  keep_archive: boolean;
}

/** What the admin panel shows under «Диск». */
export function getGalaxyStorageStatus(env: NodeJS.ProcessEnv = process.env): GalaxyStorageStatus {
  const dir = galaxyArchiveDir(env);
  const archives = listArchives(dir);
  const shards = getShardStatus(shardsDir(env));
  const archivesBytes = archives.reduce((sum, item) => sum + item.bytes, 0);
  return {
    dir,
    shards_dir: shards.dir,
    disk: diskUsage(dir),
    archives,
    archives_bytes: archivesBytes,
    shards_files: shards.files,
    shards_bytes: shards.bytes,
    total_bytes: archivesBytes + shards.bytes,
    keep_archive: archiveKeepAfterImport(env),
  };
}

/**
 * Manual «Освободить место»: drop everything that is not needed to continue —
 * every archive except `keep`, and shards that belong to no archive on disk.
 */
export function cleanupGalaxyStorage(args: {
  keep?: Array<GalaxyDumpVariant | string | null | undefined>;
  /** Also delete shards even when they match an archive on disk. */
  dropShards?: boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
} = {}): CleanupResult & { storage: GalaxyStorageStatus } {
  const env = args.env ?? process.env;
  const archives = pruneArchives({ keep: args.keep, log: args.log, env });
  // Shards survive only while the archive they came from is still here.
  const remaining = listArchives(galaxyArchiveDir(env)).map((item) => item.path);
  const shards = pruneShards({
    archive: args.dropShards ? null : remaining,
    log: args.log,
    env,
  });
  const removed = [...archives.removed, ...shards.removed];
  return {
    removed,
    freed: archives.freed + shards.freed,
    storage: getGalaxyStorageStatus(env),
  };
}
