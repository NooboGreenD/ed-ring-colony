import type { EDDNMessage } from '@/types/atlas';

export interface EDDNListenerConfig {
  onMessage: (msg: EDDNMessage) => void;
  onError?: (err: Error) => void;
  filterSchema?: string[];
  filterSystem?: string[];
}

export async function parseEDDNMessage(buffer: Buffer): Promise<EDDNMessage | null> {
  try {
    const zlib = await import('zlib');
    const decompressed = zlib.inflateSync(buffer);
    return JSON.parse(decompressed.toString('utf-8'));
  } catch { return null; }
}

export function matchesFilter(msg: EDDNMessage, filters?: { schema?: string[]; system?: string[] }): boolean {
  if (!filters) return true;
  if (filters.schema?.length) {
    const schemaName = msg.$schemaRef.split('/').slice(-2).join('/');
    if (!filters.schema.some(s => schemaName.includes(s))) return false;
  }
  if (filters.system?.length) {
    const sys = (msg.message as any).StarSystem || (msg.message as any).systemName;
    if (!sys || !filters.system.includes(sys)) return false;
  }
  return true;
}

export function formatEDDNForDB(msg: EDDNMessage) {
  const m = msg.message as any;
  return {
    schema_ref: msg.$schemaRef,
    uploader_id: msg.header?.uploaderID,
    software_name: msg.header?.softwareName,
    system_name: m.StarSystem || m.systemName || null,
    system_address: m.SystemAddress || null,
    star_pos: m.StarPos ? JSON.stringify(m.StarPos) : null,
    station_name: m.StationName || null,
    event_type: m.event || 'unknown',
    message: msg.message,
  };
}
