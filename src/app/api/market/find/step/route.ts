import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { constructionCommodities } from '@/lib/constructionBlueprints';
import { commodityKey, resolveCommodity } from '@/lib/commodities';
import { marketUpstream, marketError } from '@/lib/marketUpstream';
import { edsmInventoryItems, edsmStationReport, saveStationReport, validTime, INVENTORY_TTL_MS, COMMERCE_SOURCE_RANK } from '@/lib/stationCommerce';
import { discoverMarketSystems } from '@/lib/marketDiscovery';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const STEP_SIZE = 5;

export async function POST(request: Request) {
  try {
    const { job_id, known_systems_count } = await request.json();
    const knownCount = Number.isInteger(known_systems_count) && known_systems_count >= 0 ? Math.min(known_systems_count, 10000) : 0;
    if (!job_id)
      return NextResponse.json(
        { error: 'job_id is required' },
        { status: 400 }
      );
    const svc = createServiceClient();
    const { data: job, error: jobError } = await svc
      .from('market_search_jobs')
      .select('*')
      .eq('id', job_id)
      .single();
    if (jobError)
      return NextResponse.json(
        { error: marketError(new Error(jobError.message)) },
        { status: 503 }
      );
    if (!job)
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    if (job.status === 'done' || job.status === 'error') {
      return NextResponse.json({
        job_id,
        status: job.status,
        systems_added: (job.systems_list || []).slice(knownCount),
        progress: {
          total: job.total_systems,
          scanned: job.scanned_systems,
          found: job.found_stations,
          current: job.current_system,
        },
        scan_log: (job.scan_log || []).slice(-20),
        result: job.result || [],
        is_done: job.status === 'done',
        warnings: (job.scan_log || [])
          .filter((entry: any) => entry.warning)
          .map((entry: any) => `${entry.system}: ${entry.warning}`),
        ...(job.status === 'error' ? { error: 'Search job failed' } : {}),
      });
    }
    const commoditiesList =
      job.mode === 'build'
        ? constructionCommodities(job.build_type || 'all')
        : [resolveCommodity(job.commodity || '')].filter(Boolean);
    if (!commoditiesList.length)
      return NextResponse.json(
        { error: 'Неизвестный тип стройплощадки или пустой товар' },
        { status: 400 }
      );
    const needed = new Set(commoditiesList.map(commodityKey));
    const systemsList = job.systems_list || [];
    const startIdx = job.scanned_systems || 0;
    const endIdx = Math.min(startIdx + STEP_SIZE, systemsList.length);
    const batch = systemsList.slice(startIdx, endIdx);
    const results: any[] = [...(job.result || [])];
    const scanLog: any[] = [...(job.scan_log || [])];
    let foundStations = job.found_stations || 0;
    let currentSystem = '';
    const deadline = Date.now() + 35_000;

    for (const sys of batch) {
      currentSystem = sys.name;
      // Actual per-station reports, not just a cache of station names. EDDN
      // uses journal symbols whereas EDSM uses spaced display names.
      const [cache, eddn, canonical] = await Promise.all([
        svc
          .from('market_search_cache')
          .select('*')
          .eq('system_name', sys.name)
          .limit(1000),
        svc
          .from('market_prices')
          .select('*')
          .eq('system_name', sys.name)
          .limit(1000),
        svc.from('station_commerce')
          .select('*,station_inventory_snapshots(*)')
          .eq('system_lc', sys.name.trim().toLowerCase())
          .limit(1000),
      ]);
      const markets = new Map<
        string,
        { name: string; type: string; marketId?: number | string; metadata?: any; commodities: any[] }
      >();
      const rows = [
        ...(cache.data || []).map((row: any) => ({
          ...row,
          time: row.updated_at,
          price: row.buy_price ?? 0,
        })),
        ...(eddn.data || []).map((row: any) => ({
          ...row,
          time: row.reported_at,
          price: row.buy_price,
        })),
      ].sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0));
      for (const row of rows) {
        if (!row.station_name || !row.commodity_name) continue;
        let market = markets.get(row.station_name);
        if (!market) {
          market = {
            name: row.station_name,
            type: 'По отчёту рынка',
            marketId: row.market_id,
            commodities: [],
          };
          markets.set(row.station_name, market);
        }
        const item = {
          name: resolveCommodity(row.commodity_name),
          stock: Number(row.stock) || 0,
          buyPrice: Number(row.price) || 0,
          demand: Number(row.demand) || 0,
          reported_at: row.time,
          source: row.source || 'legacy-cache',
        };
        const index = market.commodities.findIndex(
          (c) => commodityKey(c.name) === commodityKey(item.name)
        );
        if (index < 0) market.commodities.push(item);
        else market.commodities[index] = item;
      }
      // A complete canonical snapshot overrides legacy per-item rows. Otherwise
      // removed commodities could be resurrected by the old market cache.
      const canonicalTimes = new Map<string, number>();
      const canonicalSources = new Map<string, string>();
      const snapshotAges: number[] = [];
      for (const station of canonical.data || []) {
        const snapshot = station.station_inventory_snapshots?.find((item: any) => item.kind === 'market');
        if (!snapshot) continue;
        const observed = Date.parse(snapshot.observed_at) || 0;
        canonicalTimes.set(station.station_name, observed);
        canonicalSources.set(station.station_name, snapshot.source);
        snapshotAges.push(observed);
        markets.set(station.station_name, {
          name: station.station_name, type: station.station_type || 'По отчёту рынка',
          marketId: station.market_id, metadata: station.metadata,
          commodities: snapshot.items.map((item: any) => ({ ...item, reported_at: snapshot.observed_at, source: snapshot.source })),
        });
      }
      const recent = snapshotAges.length > 0
        ? snapshotAges.every((at) => Date.now() - at < INVENTORY_TTL_MS)
          && (canonical.data || []).every((station: any) => station.station_inventory_snapshots?.some((s: any) => s.kind === 'market'))
        : commoditiesList.every((name) => rows.some((row) =>
          commodityKey(name) === commodityKey(row.commodity_name) && Date.now() - (Date.parse(row.time) || 0) < INVENTORY_TTL_MS));
      let warning: string | undefined;
      if (!recent) {
        try {
          const stationData = await marketUpstream(
            `/api-system-v1/stations?systemName=${encodeURIComponent(sys.name)}`,
            deadline
          );
          if (!Array.isArray(stationData?.stations))
            throw new Error(
              'EDSM не передал список станций; сохранённые отчёты могут быть неполными.'
            );
          // Keep metadata for all stations, not only commodity markets.
          for (const station of stationData.stations) {
            await saveStationReport(svc, edsmStationReport(sys, station), 'edsm');
          }
          const stations = stationData.stations.filter(
            (station: any) => station.haveMarket && station.marketId
          );
          for (const station of stations) {
            try {
              const data = await marketUpstream(
                `/api-system-v1/stations/market?systemName=${encodeURIComponent(sys.name)}&marketId=${station.marketId}`,
                deadline
              );
              if (!Array.isArray(data?.commodities))
                throw new Error('EDSM не передал данные рынка станции.');
              const report = edsmStationReport(sys, station);
              const observed_at = validTime(data.updateTime || data.timestamp || station.updateTime?.market) || '1970-01-01T00:00:00.000Z';
              report.inventories.market = { observed_at, items: data.commodities };
              await saveStationReport(svc, report, 'edsm');
              const storedTime = canonicalTimes.get(station.name) ?? -1;
              const incomingTime = Date.parse(observed_at);
              if (storedTime < incomingTime || (storedTime === incomingTime &&
                  COMMERCE_SOURCE_RANK.edsm >= (COMMERCE_SOURCE_RANK[canonicalSources.get(station.name) || ''] || 0))) {
                markets.set(station.name, {
                  ...station, metadata: report.metadata,
                  commodities: data.commodities.map((item: any) => ({ ...item, reported_at: observed_at, source: 'edsm' })),
                });
              }
              const wanted = commoditiesList.map(
                (name) =>
                  data.commodities.find(
                    (c: any) => commodityKey(c.name) === commodityKey(name)
                  ) || { name, stock: 0, buyPrice: 0 }
              );
              if (wanted.length)
                await svc.from('market_search_cache').upsert(
                  wanted.map((c: any) => ({
                    system_name: sys.name,
                    station_name: station.name,
                    market_id: station.marketId,
                    commodity_name: resolveCommodity(c.name),
                    stock: c.stock,
                    buy_price: c.buyPrice,
                    sell_price: c.buyPrice,
                    distance: sys.distance,
                    updated_at: observed_at,
                  })),
                  { onConflict: 'system_name,station_name,commodity_name' }
                );
            } catch (error) {
              warning = marketError(error);
            }
          }
          for (const station of stationData.stations) {
            if (deadline - Date.now() < 2000) break;
            // Modules and ships are independent snapshots and must not be
            // cleared by a commodity-only response or a failed endpoint.
            for (const kind of ['outfitting', 'shipyard'] as const) {
              if (!station.marketId || !station[kind === 'outfitting' ? 'haveOutfitting' : 'haveShipyard']) continue;
              const saved = (canonical.data || []).find((s: any) => s.station_name === station.name)
                ?.station_inventory_snapshots?.find((s: any) => s.kind === kind);
              if (saved && Date.now() - Date.parse(saved.observed_at) < INVENTORY_TTL_MS) continue;
              try {
                const inventory = await marketUpstream(`/api-system-v1/stations/${kind}?systemName=${encodeURIComponent(sys.name)}&marketId=${station.marketId}`, deadline);
                // EDSM отдаёт модули в `outfitting`, корабли — в `ships` (см. edsmInventoryItems).
                const items = edsmInventoryItems(kind, inventory);
                if (!items) continue;
                const inventoryReport = edsmStationReport(sys, station);
                inventoryReport.inventories[kind] = {
                  observed_at: validTime(inventory.updateTime || station.updateTime?.[kind]) || '1970-01-01T00:00:00.000Z',
                  items,
                };
                await saveStationReport(svc, inventoryReport, 'edsm');
              } catch (error) {
                console.warn('[Market Step] optional station inventory:', marketError(error));
              }
            }
          }
          // Do not poison the availability cache after a network failure.
          if (!warning)
            await svc.from('colonisation_market_systems').upsert(
              {
                system_name: sys.name,
                x: sys.x,
                y: sys.y,
                z: sys.z,
                has_market: stations.length > 0,
                station_count: stations.length,
                station_names: stations.map((st: any) => st.name),
                commodities_available: Array.from(
                  new Set(
                    Array.from(markets.values()).flatMap((st) =>
                      st.commodities.map((c) => c.name)
                    )
                  )
                ),
                last_checked_at: new Date().toISOString(),
              },
              { onConflict: 'system_name' }
            );
        } catch (error) {
          warning = marketError(error);
        }
      }
      if (cache.error && eddn.error && markets.size === 0)
        warning = 'Недоступны отчёты рынков в базе данных. ' + (warning || '');
      if (
        !warning &&
        rows.some(
          (row) =>
            needed.has(commodityKey(row.commodity_name)) &&
            !Number.isFinite(Date.parse(row.time))
        )
      )
        warning = 'В части сохранённых отчётов неизвестно время обновления.';
      scanLog.push({
        system: sys.name,
        status: warning
          ? 'unavailable'
          : markets.size
            ? 'has_market'
            : 'no_market',
        stations: markets.size,
        warning: warning
          ? `${warning} Использованы сохранённые отчёты, если они есть; данные могут быть неполными или устаревшими.`
          : undefined,
        timestamp: new Date().toISOString(),
      });
      for (const market of markets.values()) {
        const found = commoditiesList.flatMap((name) => {
          const match = market.commodities.find(
            (c) => commodityKey(c.name) === commodityKey(name)
          );
          return match && match.stock > 0
            ? [
                {
                  name,
                  stock: match.stock,
                  sell_price: match.buyPrice > 0 ? match.buyPrice : null,
                  reported_at: match.reported_at,
                  source: match.source,
                  stale: !match.reported_at || Date.now() - (Date.parse(match.reported_at) || 0) >= INVENTORY_TTL_MS,
                },
              ]
            : [];
        });
        if (!found.length) continue;
        foundStations++;
        const common = {
          station_name: market.name,
          system_name: sys.name,
          distance: sys.distance,
          x: sys.x, y: sys.y, z: sys.z,
          market_id: market.marketId, station_location: market.metadata,
          landing_pad: market.type === 'Fleet Carrier' ? 'L' : '—',
          station_type: market.type,
        };
        results.push(
          job.mode === 'build'
            ? {
                ...common,
                commodities: found,
                commodities_found: found.length,
                commodities_total: commoditiesList.length,
              }
            : {
                ...common,
                commodity: found[0].name,
                sell_price: found[0].sell_price,
                stock: found[0].stock,
                reported_at: found[0].reported_at,
                source: found[0].source,
                stale: found[0].stale,
                demand:
                  market.commodities.find(
                    (c) => commodityKey(c.name) === commodityKey(found[0].name)
                  )?.demand || 0,
              }
        );
      }
    }

    const newScanned = endIdx;
    let isDone = newScanned >= systemsList.length;
    let nextSystems = systemsList;
    let discoveryComplete = job.discovery_complete !== false;
    const foundKeys = new Set(results.flatMap((result: any) =>
      result.commodities ? result.commodities.map((c: any) => commodityKey(c.name)) : [commodityKey(result.commodity)]));
    // Only expand the volume after stage one cannot supply the requested goods.
    if (isDone && !discoveryComplete && commoditiesList.some((name) => !foundKeys.has(commodityKey(name)))) {
      if (deadline - Date.now() < 10_000) {
        // Persist stage-one progress now; perform discovery on the next step
        // with a fresh budget rather than exceeding the route's 60s deadline.
        isDone = false;
      } else {
        try {
          const discovery = await discoverMarketSystems(job.ref_system, job.radius, job.reference_coords, deadline);
          const visited = new Set(systemsList.map((s: any) => s.name.trim().toLowerCase()));
          const additional = discovery.systems.filter((s) => s.coords && !visited.has(s.name.trim().toLowerCase()))
            .map((s) => ({ name: s.name, ...s.coords!, distance: s.distance || 0 }))
            .sort((a, b) => a.distance - b.distance);
          nextSystems = [...systemsList, ...additional];
          discoveryComplete = true;
          isDone = newScanned >= nextSystems.length;
        } catch (error) {
          isDone = false;
          scanLog.push({ system: job.ref_system, status: 'unavailable', timestamp: new Date().toISOString(),
            warning: `Расширенный поиск временно недоступен: ${marketError(error)}. Результаты первого этапа сохранены.` });
        }
      }
    }

    // A slow EDSM request can outlive the browser polling interval. Claim the
    // snapshot optimistically so two overlapping /step calls cannot append the
    // same five systems and create duplicate market/map results.
    const { data: savedJob, error: saveError } = await svc
      .from('market_search_jobs')
      .update({
        status: isDone ? 'done' : 'scanning',
        systems_list: nextSystems,
        total_systems: nextSystems.length,
        discovery_complete: discoveryComplete,
        scanned_systems: newScanned,
        found_stations: foundStations,
        current_system: currentSystem,
        result: results,
        scan_log: scanLog,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job_id)
      .eq('scanned_systems', startIdx)
      .select()
      .maybeSingle();

    if (saveError) {
      return NextResponse.json(
        { error: marketError(new Error(saveError.message)) },
        { status: 503 }
      );
    }

    if (!savedJob) {
      // Another request won the optimistic update. Return its current state;
      // importantly, do not return this request's uncommitted duplicate list.
      const { data: currentJob, error: currentError } = await svc
        .from('market_search_jobs')
        .select('*')
        .eq('id', job_id)
        .maybeSingle();
      if (currentError || !currentJob) {
        return NextResponse.json(
          { error: currentError?.message || 'Search job disappeared' },
          { status: 409 }
        );
      }
      return NextResponse.json({
        job_id,
        status: currentJob.status,
        systems_added: (currentJob.systems_list || []).slice(knownCount),
        progress: {
          total: currentJob.total_systems,
          scanned: currentJob.scanned_systems,
          found: currentJob.found_stations,
          current: currentJob.current_system,
        },
        scan_log: (currentJob.scan_log || []).slice(-20),
        result: currentJob.result || [],
        is_done: currentJob.status === 'done',
        warnings: (currentJob.scan_log || [])
          .filter((entry: any) => entry.warning)
          .map((entry: any) => `${entry.system}: ${entry.warning}`),
      });
    }

    return NextResponse.json({
      job_id,
      status: savedJob.status,
      systems_added: (savedJob.systems_list || []).slice(knownCount),
      progress: {
        total: savedJob.total_systems,
        scanned: savedJob.scanned_systems,
        found: savedJob.found_stations,
        current: savedJob.current_system,
      },
      scan_log: (savedJob.scan_log || []).slice(-20),
      result: savedJob.result || [],
      is_done: savedJob.status === 'done',
      warnings: (savedJob.scan_log || [])
        .filter((entry: any) => entry.warning)
        .map((entry: any) => `${entry.system}: ${entry.warning}`),
    });
  } catch (e: any) {
    console.error('[Market Step] Error:', e);
    return NextResponse.json(
      { error: marketError(e) || 'Ошибка шага поиска' },
      { status: 500 }
    );
  }
}
