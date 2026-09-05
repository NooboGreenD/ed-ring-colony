import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

const EDSM_UA = 'ED-Ring-Colony/1.0 (https://ed-ring-colony.vercel.app)';

const BUILD_COMMODITIES = [
  'Aluminium','Ceramic Composites','CMM Composite','Computer Components',
  'Copper','Food Cartridges','Fruit and Vegetables','Insulating Membrane',
  'Liquid oxygen','Medical Diagnostic Equipment','Non-Lethal Weapons',
  'Polymers','Power Generators','Semiconductors','Steel','Superconductors',
  'Titanium','Water','Water Purifiers','Structural Regulators',
  'Building Fabricators','Thermal Cooling Units',
];

const STEP_SIZE = 5;

interface EDSMStation {
  name: string;
  type: string;
  marketId?: number;
  haveMarket?: boolean;
}

interface EDSMCommodity {
  name: string;
  buyPrice: number;
  sellPrice: number;
  stock: number;
  demand: number;
  stockBracket: number;
}

async function getStations(systemName: string): Promise<EDSMStation[]> {
  const res = await fetch(
    `https://www.edsm.net/api-system-v1/stations?systemName=${encodeURIComponent(systemName)}`,
    { headers: { 'User-Agent': EDSM_UA } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.stations || [];
}

async function getMarket(systemName: string, marketId: number): Promise<EDSMCommodity[]> {
  const res = await fetch(
    `https://www.edsm.net/api-system-v1/stations/market?systemName=${encodeURIComponent(systemName)}&marketId=${marketId}`,
    { headers: { 'User-Agent': EDSM_UA } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.commodities || [];
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { job_id } = body;
    if (!job_id) {
      return NextResponse.json({ error: 'job_id is required' }, { status: 400 });
    }

    const svc = createServiceClient();
    const { data: job, error: jobError } = await svc
      .from('market_search_jobs')
      .select('*')
      .eq('id', job_id)
      .single();

    if (jobError || !job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status === 'done' || job.status === 'error') {
      return NextResponse.json({
        job_id,
        status: job.status,
        progress: {
          total: job.total_systems,
          scanned: job.scanned_systems,
          found: job.found_stations,
          current: job.current_system,
        },
        result: job.result || [],
      });
    }

    const systemsList: { name: string; distance: number; x?: number; y?: number; z?: number }[] =
      job.systems_list || [];
    const startIdx = job.scanned_systems || 0;
    const endIdx = Math.min(startIdx + STEP_SIZE, systemsList.length);
    const batch = systemsList.slice(startIdx, endIdx);

    const results: any[] = job.result || [];
    let foundStations = job.found_stations || 0;
    let currentSystem = '';
    const scanLog: any[] = job.scan_log || [];

    for (const sys of batch) {
      currentSystem = sys.name;

      const { data: cachedSystem } = await svc
        .from('colonisation_market_systems')
        .select('*')
        .eq('system_name', sys.name)
        .single();

      let stations: EDSMStation[] = [];
      let marketStations: EDSMStation[] = [];
      let allCommodities: string[] = [];
      let stationNames: string[] = [];

      if (cachedSystem && cachedSystem.has_market) {
        stations = (cachedSystem.station_names || []).map((name: string) => ({
          name,
          type: 'Unknown',
          haveMarket: true,
        }));
        marketStations = stations;
        allCommodities = cachedSystem.commodities_available || [];
        stationNames = cachedSystem.station_names || [];
      } else {
        stations = await getStations(sys.name);
        marketStations = stations.filter((st: EDSMStation) => st.haveMarket && st.marketId);
        stationNames = marketStations.map((st) => st.name);

        if (marketStations.length > 0) {
          for (const st of marketStations) {
            const commodities = await getMarket(sys.name, st.marketId!);
            for (const comm of commodities) {
              if (!allCommodities.includes(comm.name)) {
                allCommodities.push(comm.name);
              }
            }
          }
          await svc.from('colonisation_market_systems').upsert(
            {
              system_name: sys.name,
              x: sys.x,
              y: sys.y,
              z: sys.z,
              has_market: true,
              station_count: marketStations.length,
              station_names: stationNames,
              commodities_available: allCommodities,
              last_checked_at: new Date().toISOString(),
            },
            { onConflict: 'system_name' }
          );
        } else {
          await svc.from('colonisation_market_systems').upsert(
            {
              system_name: sys.name,
              x: sys.x,
              y: sys.y,
              z: sys.z,
              has_market: false,
              station_count: 0,
              station_names: [],
              commodities_available: [],
              last_checked_at: new Date().toISOString(),
            },
            { onConflict: 'system_name' }
          );
        }
      }

      if (marketStations.length === 0) {
        scanLog.push({
          system: sys.name,
          status: 'no_market',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      scanLog.push({
        system: sys.name,
        status: 'has_market',
        stations: marketStations.length,
        timestamp: new Date().toISOString(),
      });

      const commoditiesList =
        job.mode === 'build' ? BUILD_COMMODITIES : job.commodity ? [job.commodity] : [];

      for (const st of marketStations) {
        const { data: cached } = await svc
          .from('market_search_cache')
          .select('*')
          .eq('system_name', sys.name)
          .eq('station_name', st.name)
          .in('commodity_name', commoditiesList);

        const cachedCommodities = new Map((cached || []).map((c: any) => [c.commodity_name, c]));
        const missingCommodities = commoditiesList.filter((c: string) => !cachedCommodities.has(c));

        let commodities: EDSMCommodity[] = [];
        if (missingCommodities.length > 0 && st.marketId) {
          commodities = await getMarket(sys.name, st.marketId);
          for (const comm of commodities) {
            if (commoditiesList.includes(comm.name)) {
              await svc.from('market_search_cache').upsert(
                {
                  system_name: sys.name,
                  station_name: st.name,
                  market_id: st.marketId,
                  commodity_name: comm.name,
                  stock: comm.stock,
                  sell_price: comm.sellPrice,
                  distance: sys.distance,
                },
                { onConflict: 'system_name,station_name,commodity_name' }
              );
            }
          }
        } else {
          commodities = (cached || []).map((c: any) => ({
            name: c.commodity_name,
            buyPrice: 0,
            sellPrice: c.sell_price,
            stock: c.stock,
            demand: 0,
            stockBracket: 0,
          }));
        }

        if (job.mode === 'build') {
          const found: { name: string; stock: number; sell_price: number }[] = [];
          for (const need of commoditiesList) {
            const match = commodities.find(
              (c: EDSMCommodity) => c.name.toLowerCase() === need.toLowerCase()
            );
            if (match && match.stock > 0) {
              found.push({ name: match.name, stock: match.stock, sell_price: match.sellPrice });
            }
          }
          if (found.length > 0) {
            foundStations++;
            results.push({
              station_name: st.name,
              system_name: sys.name,
              distance: sys.distance,
              landing_pad: st.type === 'Fleet Carrier' ? 'L' : 'L/M/S',
              station_type: st.type,
              commodities: found,
              commodities_found: found.length,
              commodities_total: commoditiesList.length,
            });
          }
        } else {
          const match = commodities.find(
            (c: EDSMCommodity) => c.name.toLowerCase() === job.commodity!.toLowerCase()
          );
          if (match && match.stock > 0) {
            foundStations++;
            results.push({
              station_name: st.name,
              system_name: sys.name,
              distance: sys.distance,
              commodity: match.name,
              sell_price: match.sellPrice,
              stock: match.stock,
              demand: match.demand,
              landing_pad: st.type === 'Fleet Carrier' ? 'L' : 'L/M/S',
              station_type: st.type,
            });
          }
        }
      }
    }

    const newScanned = endIdx;
    const isDone = newScanned >= systemsList.length;

    await svc
      .from('market_search_jobs')
      .update({
        status: isDone ? 'done' : 'scanning',
        scanned_systems: newScanned,
        found_stations: foundStations,
        current_system: currentSystem,
        result: results,
        scan_log: scanLog,
        updated_at: new Date().toISOString(),
      })
      .eq('id', job_id);

    return NextResponse.json({
      job_id,
      status: isDone ? 'done' : 'scanning',
      progress: {
        total: job.total_systems,
        scanned: newScanned,
        found: foundStations,
        current: currentSystem,
      },
      scan_log: scanLog.slice(-20),
      result: results,
      is_done: isDone,
    });
  } catch (e: any) {
    console.error('[Market Step] Error:', e);
    return NextResponse.json({ error: e.message || 'Step failed' }, { status: 500 });
  }
}
