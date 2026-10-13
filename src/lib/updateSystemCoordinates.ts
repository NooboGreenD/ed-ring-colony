import {
  readSystemCoordinates,
  type SystemCoordinates,
  type CoordinateSource,
} from './systemCoordinateTypes';
/** Browser-side bounded lookups/writes shared by hubs, route and projects. */
export async function updateSystemCoordinates<
  T extends { system_name: string; x?: unknown; y?: unknown; z?: unknown },
>(
  rows: T[],
  save: (row: T, coords: SystemCoordinates) => Promise<void>,
  options: {
    endpoint?: string;
    onProgress?: (processed: number, total: number, name: string) => void;
  } = {}
) {
  const missing = rows.filter((row) => !readSystemCoordinates(row));
  const result = {
    updated: 0,
    unresolved: 0,
    failed: 0,
    total: missing.length,
    warnings: [] as string[],
    errors: [] as string[],
    sources: { edsm: 0, spansh_catalog: 0, spansh: 0 },
  };
  const warnings = new Set<string>();
  let processed = 0;
  for (let offset = 0; offset < missing.length; offset += 10) {
    const batch = missing.slice(offset, offset + 10);
    const response = await fetch(options.endpoint || '/api/route/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: batch.map((row) => row.system_name) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        data.error || `Ошибка получения координат (HTTP ${response.status})`
      );
    for (const warning of data.warnings || [])
      if (typeof warning === 'string') warnings.add(warning);
    for (let i = 0; i < batch.length; i += 5)
      await Promise.all(
        batch.slice(i, i + 5).map(async (row) => {
          const coords = readSystemCoordinates(data.results?.[row.system_name]);
          if (!coords) result.unresolved++;
          else {
            try {
              await save(row, coords);
              result.updated++;
              const source = data.sources?.[
                row.system_name
              ] as CoordinateSource;
              if (Object.hasOwn(result.sources, source))
                result.sources[source]++;
            } catch (error) {
              result.failed++;
              result.errors.push(
                `${row.system_name}: ${error instanceof Error ? error.message : 'Ошибка записи'}`
              );
            }
          }
          options.onProgress?.(++processed, missing.length, row.system_name);
        })
      );
  }
  result.warnings = Array.from(warnings);
  return result;
}
