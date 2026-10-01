/**
 * Which Spansh dump to download — the cheapest file that still brings the
 * catalog up to date.
 *
 * Why this module exists: the full `systems.json.gz` is 5.9 GiB. On a thin
 * line that is days of transfer (the production server measured ~a week), and
 * by the time it lands the source has been regenerated seven times — the
 * catalog can never catch up by re-downloading the full dump. Spansh publishes
 * the same table as rolling deltas (see https://spansh.co.uk/dumps):
 *
 * | file                     | size    | content                               |
 * | ------------------------ | ------- | ------------------------------------- |
 * | systems.json.gz          | 5.9 GiB | every known system                    |
 * | systems_1day.json.gz     | 3.6 MiB | systems updated in the last 24 h      |
 * | systems_1week.json.gz    | 20 MiB  | …last 7 days                          |
 * | systems_2weeks.json.gz   | 39 MiB  | …last 14 days                         |
 * | systems_1month.json.gz   | 88 MiB  | …last ~32 days                        |
 * | systems_6months.json.gz  | 617 MiB | …last ~6 months                       |
 *
 * All of them share one schema, and the import upserts by `name_lc`, so a
 * delta is byte-for-byte the same pipeline — only ~1700× smaller. The full
 * dump is therefore needed exactly once (cold start), and every later refresh
 * picks the smallest window that covers the gap since the data we already hold.
 *
 * Everything here is a pure function of (env, timestamps) so
 * `scripts/tests/galaxy-dump-variants.test.mjs` can pin the whole decision
 * table without network access.
 */

export type GalaxyDumpVariant = 'full' | '1day' | '1week' | '2weeks' | '1month' | '6months';

export interface DumpVariantInfo {
  variant: GalaxyDumpVariant;
  /** File name on downloads.spansh.co.uk (and on any mirror of it). */
  file: string;
  /**
   * How far back the dump reaches from the moment it was generated.
   * `null` for the full dump: it covers the whole catalog.
   */
  coversMs: number | null;
  /** Published size (spansh.co.uk/dumps, October 2026) — used for estimates only. */
  approxBytes: number;
  /** Short Russian label for the admin panel and the logs. */
  label: string;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const DUMP_VARIANTS: Record<GalaxyDumpVariant, DumpVariantInfo> = {
  '1day': { variant: '1day', file: 'systems_1day.json.gz', coversMs: 1 * DAY, approxBytes: 4 * 1024 * 1024, label: 'за сутки' },
  '1week': { variant: '1week', file: 'systems_1week.json.gz', coversMs: 7 * DAY, approxBytes: 21 * 1024 * 1024, label: 'за неделю' },
  '2weeks': { variant: '2weeks', file: 'systems_2weeks.json.gz', coversMs: 14 * DAY, approxBytes: 40 * 1024 * 1024, label: 'за две недели' },
  '1month': { variant: '1month', file: 'systems_1month.json.gz', coversMs: 32 * DAY, approxBytes: 92 * 1024 * 1024, label: 'за месяц' },
  '6months': { variant: '6months', file: 'systems_6months.json.gz', coversMs: 183 * DAY, approxBytes: 647 * 1024 * 1024, label: 'за полгода' },
  full: { variant: 'full', file: 'systems.json.gz', coversMs: null, approxBytes: 6_335_076_761, label: 'полный дамп' },
};

/** Deltas from cheapest to most expensive; `full` is the last resort. */
export const DUMP_LADDER: GalaxyDumpVariant[] = ['1day', '1week', '2weeks', '1month', '6months', 'full'];

export const DEFAULT_DUMP_BASE_URL = 'https://downloads.spansh.co.uk/';

/**
 * A dump generated at T covers [T − window, T]. We usually do not know T, so
 * the picker assumes the file we are about to fetch was generated up to a day
 * ago, and adds a safety margin on top. Overshooting costs a few MiB; falling
 * short silently loses systems.
 */
export const DUMP_GENERATION_LAG_MS = 1 * DAY;
export const DUMP_SAFETY_MS = 12 * HOUR;

export function isDumpVariant(value: unknown): value is GalaxyDumpVariant {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DUMP_VARIANTS, value);
}

/**
 * Directory the dumps are served from. `GALAXY_DUMP_BASE_URL` points the whole
 * ladder at a mirror; a `GALAXY_IMPORT_URL` that ends with a known dump file
 * name implies the same directory, so a server with its own mirror gets the
 * deltas for free.
 */
export function dumpBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GALAXY_DUMP_BASE_URL?.trim();
  if (explicit) return explicit.endsWith('/') ? explicit : `${explicit}/`;
  const importUrl = env.GALAXY_IMPORT_URL?.trim();
  if (importUrl) {
    const known = Object.values(DUMP_VARIANTS).some((info) => importUrl.endsWith(`/${info.file}`));
    if (known) return importUrl.slice(0, importUrl.lastIndexOf('/') + 1);
  }
  return DEFAULT_DUMP_BASE_URL;
}

/**
 * URL of one dump variant. `GALAXY_IMPORT_URL` keeps overriding the full dump
 * (a mirror may publish only that file under a custom name).
 */
export function dumpVariantUrl(variant: GalaxyDumpVariant, env: NodeJS.ProcessEnv = process.env): string {
  const info = DUMP_VARIANTS[variant] ?? DUMP_VARIANTS.full;
  if (variant === 'full') {
    const override = env.GALAXY_IMPORT_URL?.trim();
    if (override) return override;
  }
  return `${dumpBaseUrl(env)}${info.file}`;
}

/** Reverse lookup: which variant a URL (or a path) refers to, if any. */
export function variantFromUrl(url: string | null | undefined): GalaxyDumpVariant | null {
  if (!url) return null;
  const clean = url.split('?')[0];
  // Longest file name first: `systems.json.gz` is a suffix of nothing, but the
  // guard keeps the lookup stable if a future name nests inside another.
  const entries = Object.values(DUMP_VARIANTS).sort((a, b) => b.file.length - a.file.length);
  for (const info of entries) {
    if (clean.endsWith(info.file)) return info.variant;
  }
  return null;
}

/**
 * Archive file name per variant. Deltas never overwrite the 6 GiB full dump on
 * disk: a nightly 4 MiB file must not cost the expensive one.
 */
export function archiveFileNameForVariant(variant: GalaxyDumpVariant): string {
  return (DUMP_VARIANTS[variant] ?? DUMP_VARIANTS.full).file;
}

export interface DumpPlanInput {
  /** `galaxy_systems` already holds a full catalog (not a `--limit` sample). */
  catalogComplete: boolean;
  /**
   * Generation time of the dump the catalog was last built from
   * (`stats.dump_generated_at`, taken from the file's `Last-Modified`).
   */
  dataAsOf?: string | number | null;
  /** Fallback when the generation time is unknown: when the import finished. */
  importedAt?: string | number | null;
  now?: number;
  /** Never pick anything cheaper than this (operator override). */
  minVariant?: GalaxyDumpVariant | null;
}

export interface DumpPlan {
  variant: GalaxyDumpVariant;
  info: DumpVariantInfo;
  /** How stale the catalog is, in ms (null when unknown). */
  gapMs: number | null;
  /** Window the chosen file has to cover (gap + safety), in ms. */
  needMs: number | null;
  /** Russian explanation for the log and the admin panel. */
  reason: string;
}

function toMs(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function atLeast(variant: GalaxyDumpVariant, floor: GalaxyDumpVariant | null | undefined): GalaxyDumpVariant {
  if (!floor) return variant;
  const a = DUMP_LADDER.indexOf(variant);
  const b = DUMP_LADDER.indexOf(floor);
  return b > a ? floor : variant;
}

/**
 * Pick the cheapest dump that still covers everything the catalog missed.
 *
 * Rules, in order:
 *  1. an empty/partial catalog needs the full dump — there is nothing to patch;
 *  2. otherwise the gap is `now − dataAsOf`; the file must cover
 *     `gap + DUMP_SAFETY_MS`, and an unknown generation time is treated as
 *     "the dump we imported was up to a day old" (`DUMP_GENERATION_LAG_MS`);
 *  3. a gap wider than the widest delta (6 months) falls back to the full dump.
 */
export function planDumpDownload(input: DumpPlanInput): DumpPlan {
  const now = input.now ?? Date.now();

  if (!input.catalogComplete) {
    return {
      variant: 'full',
      info: DUMP_VARIANTS.full,
      gapMs: null,
      needMs: null,
      reason: 'каталог пуст или неполный — нужен полный дамп (дельта не на что накладывать)',
    };
  }

  const generated = toMs(input.dataAsOf);
  const imported = toMs(input.importedAt);
  // Without a generation time the imported dump could already have been a day
  // old when we fetched it.
  const asOf = generated ?? (imported != null ? imported - DUMP_GENERATION_LAG_MS : null);

  if (asOf == null) {
    return {
      variant: 'full',
      info: DUMP_VARIANTS.full,
      gapMs: null,
      needMs: null,
      reason: 'неизвестно, на какой момент актуален каталог — берём полный дамп один раз, дальше пойдут дельты',
    };
  }

  const gapMs = Math.max(0, now - asOf);
  const needMs = gapMs + DUMP_SAFETY_MS;

  for (const variant of DUMP_LADDER) {
    const info = DUMP_VARIANTS[variant];
    if (info.coversMs == null) break; // `full` — handled below
    if (info.coversMs >= needMs) {
      const chosen = atLeast(variant, input.minVariant);
      return {
        variant: chosen,
        info: DUMP_VARIANTS[chosen],
        gapMs,
        needMs,
        reason:
          `каталог отстал на ${formatGap(gapMs)} — хватает дампа «${DUMP_VARIANTS[chosen].label}» ` +
          `(${DUMP_VARIANTS[chosen].file}, ~${Math.round(DUMP_VARIANTS[chosen].approxBytes / (1024 * 1024))} МиБ ` +
          `вместо 5.9 ГиБ полного)`,
      };
    }
  }

  return {
    variant: 'full',
    info: DUMP_VARIANTS.full,
    gapMs,
    needMs,
    reason: `каталог отстал на ${formatGap(gapMs)} — это шире самой широкой дельты (полгода), нужен полный дамп`,
  };
}

/** The next wider file, for escalating when a delta turns out to be too narrow. */
export function widerVariant(variant: GalaxyDumpVariant): GalaxyDumpVariant {
  const index = DUMP_LADDER.indexOf(variant);
  if (index < 0 || index >= DUMP_LADDER.length - 1) return 'full';
  return DUMP_LADDER[index + 1];
}

/**
 * Does a dump generated at `generatedAt` really cover a catalog current as of
 * `dataAsOf`? Checked after the download, when `Last-Modified` is known: a
 * stale mirror (or a file that was regenerated later than we assumed) would
 * otherwise leave a silent hole in the catalog.
 */
export function variantCoversGap(
  variant: GalaxyDumpVariant,
  generatedAt: string | number | null | undefined,
  dataAsOf: string | number | null | undefined,
): { ok: boolean; reason: string } {
  const info = DUMP_VARIANTS[variant] ?? DUMP_VARIANTS.full;
  if (info.coversMs == null) return { ok: true, reason: 'полный дамп покрывает каталог целиком' };
  const generated = toMs(generatedAt);
  const asOf = toMs(dataAsOf);
  if (generated == null || asOf == null) {
    return { ok: true, reason: 'время генерации дампа неизвестно — проверка пропущена' };
  }
  const windowStart = generated - info.coversMs;
  if (windowStart <= asOf) {
    return { ok: true, reason: `дамп покрывает период с ${new Date(windowStart).toISOString()}` };
  }
  return {
    ok: false,
    reason:
      `дамп «${info.label}» начинается с ${new Date(windowStart).toISOString()}, ` +
      `а каталог актуален на ${new Date(asOf).toISOString()} — между ними дыра в ${formatGap(windowStart - asOf)}`,
  };
}

export function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ч';
  const hours = ms / HOUR;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)} ч`;
  const days = ms / DAY;
  if (days < 60) return `${days.toFixed(days < 10 ? 1 : 0)} дн`;
  return `${(days / 30.44).toFixed(1)} мес`;
}
