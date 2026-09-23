/**
 * Streaming reader for the nightly Spansh dump (`systems.json.gz`).
 *
 * The dump is a single JSON array of `BriefDumpSystem` objects
 * ({ id64, name, mainStar, coords{x,y,z}, needsPermit, updateTime }), one
 * record per line, ~6 GiB compressed / ~2×10⁸ records. It is never buffered
 * whole: a byte-level state machine emits one object at a time.
 *
 * Shared by:
 *  - `scripts/import-spansh-systems.mjs` (CLI import on any machine);
 *  - `src/lib/galaxyImport.ts` (in-app import that runs inside the web
 *    container, where `scripts/` is not present).
 *
 * `id64` is an unsigned 64-bit integer: the raw decimal digits are captured
 * from the source text because `JSON.parse` loses precision above 2^53.
 */

import { Transform, type Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import {
  classifyStar,
  distanceFromSgra,
  distanceFromSols,
  normalizeSystemName,
  type GiantClass,
  type StarClass,
} from './galaxySystems.ts';

/** One record of the dump, plus the fields the streaming parser adds. */
export interface SpanshSystemObject {
  id64?: number | string | null;
  name?: unknown;
  mainStar?: unknown;
  coords?: { x?: unknown; y?: unknown; z?: unknown } | null;
  needsPermit?: unknown;
  updateTime?: unknown;
  /** Exact decimal digits of `id64` as written in the dump (u64-safe). */
  __id64Exact?: string;
  /**
   * Uncompressed byte offset of the chunk this record completed in. A resumed
   * import uses it to skip records that are already in the table: every record
   * of an earlier chunk was written before the stored restart point.
   */
  __streamOffset?: number;
}

/** A `galaxy_systems` row derived from one dump record. */
export interface GalaxySystemRecord {
  id64: string;
  name: string;
  name_lc: string;
  x: number;
  y: number;
  z: number;
  main_star: string | null;
  star_type: StarClass;
  star_giant_class: GiantClass;
  needs_permit: boolean | null;
  distance_from_sols: number;
  distance_from_sgra: number;
  updated_at: string | null;
}

export interface JsonArrayObjectsOptions {
  highWaterMark?: number;
}

/**
 * JSON array → objects, without ever holding the array. String/escape/brace
 * aware, so it also copes with minified or re-wrapped dumps.
 */
export class JsonArrayObjects extends Transform {
  /** Uncompressed bytes fed to the parser so far. */
  streamOffset = 0;
  /** Offset of the chunk currently being parsed; each record carries it. */
  private chunkStart = 0;
  private readonly decoder = new StringDecoder('utf8');
  private state: 'skip' | 'between' | 'object' = 'skip';
  private depth = 0;
  private inString = false;
  private escaped = false;
  private raw = '';
  private finished = false;

  constructor(options: JsonArrayObjectsOptions = {}) {
    super({ objectMode: true, highWaterMark: options.highWaterMark ?? 64 });
  }

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.finished) return done();
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.chunkStart = this.streamOffset;
      this.streamOffset += bytes.length;
      this.consume(this.decoder.write(bytes));
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  }

  _flush(done: (error?: Error | null) => void): void {
    if (this.finished) return done();
    try {
      const tail = this.decoder.end();
      if (tail) this.consume(tail);
      if (this.state === 'object' && this.raw) {
        // A truncated tail is a broken dump, not a record: fail loudly instead
        // of silently dropping the last system.
        throw new Error('Dump ended inside a JSON object (truncated file?)');
      }
      done();
    } catch (error) {
      done(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private consume(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      switch (this.state) {
        case 'skip':
          if (ch === '[') this.state = 'between';
          break;
        case 'between':
          if (ch === ']') {
            this.finished = true;
            return;
          }
          if (ch === '{') {
            this.state = 'object';
            this.depth = 1;
            this.inString = false;
            this.raw = '{';
          }
          break;
        case 'object':
          if (this.inString) {
            this.raw += ch;
            if (this.escaped) this.escaped = false;
            else if (ch === '\\') this.escaped = true;
            else if (ch === '"') this.inString = false;
            break;
          }
          if (ch === '"') {
            this.inString = true;
            this.raw += ch;
            break;
          }
          if (ch === '{') {
            this.depth++;
            this.raw += ch;
            break;
          }
          if (ch === '}') {
            this.depth--;
            this.raw += ch;
            if (this.depth === 0) {
              const idMatch = /"id64"\s*:\s*(\d+)/.exec(this.raw);
              const obj = JSON.parse(this.raw) as SpanshSystemObject;
              if (idMatch) obj.__id64Exact = idMatch[1];
              obj.__streamOffset = this.chunkStart;
              this.raw = '';
              this.state = 'between';
              this.push(obj);
            }
            break;
          }
          this.raw += ch;
          break;
        default:
          break;
      }
      if (this.finished) return;
    }
  }
}

/** Pipe a (decompressed) dump stream through the object parser. */
export function streamObjects(source: Readable, options?: JsonArrayObjectsOptions): Readable {
  return source.pipe(new JsonArrayObjects(options));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Dump record → `galaxy_systems` row. Returns null for records that cannot be
 * stored (no name, no coordinates, no id64) so the caller can count them.
 */
export function toGalaxySystemRow(obj: SpanshSystemObject | null | undefined): GalaxySystemRecord | null {
  if (!obj) return null;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) return null;
  const coords = obj.coords;
  const x = finiteNumber(coords?.x);
  const y = finiteNumber(coords?.y);
  const z = finiteNumber(coords?.z);
  if (x == null || y == null || z == null) return null;
  // Prefer the exact decimal digits captured by the streaming parser.
  const id64 = obj?.__id64Exact ?? (obj?.id64 == null ? null : String(obj.id64));
  if (!id64) return null; // id64 is required by the dump schema
  const mainStar = typeof obj.mainStar === 'string' && obj.mainStar ? obj.mainStar : null;
  const cls = classifyStar(mainStar);
  return {
    id64,
    name,
    name_lc: normalizeSystemName(name),
    x,
    y,
    z,
    main_star: mainStar,
    star_type: cls.starType,
    star_giant_class: cls.giantClass,
    needs_permit: typeof obj.needsPermit === 'boolean' ? obj.needsPermit : null,
    distance_from_sols: distanceFromSols(x, y, z),
    distance_from_sgra: distanceFromSgra(x, y, z),
    updated_at: typeof obj.updateTime === 'string' ? obj.updateTime : null,
  };
}
