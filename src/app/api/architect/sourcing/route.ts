import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { findSystemByName, findSystemsByNames } from '@/lib/galaxySystemsDb';
import {
  buildOffers,
  commodityNameVariants,
  normalizeCommodityKey,
  planSourcing,
  type MarketPriceRow,
  type ResolvedSourcingOptions,
  type SystemCoords,
} from '@/lib/architect/sourcing';

export const dynamic = 'force-dynamic';

/** Пределы запроса: план из 80 товаров — это уже очень большая стройка. */
const MAX_COMMODITIES = 80;
const MAX_ROWS = 3000;
const MAX_VARIANTS = 240;

function readCargo(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cargo: Record<string, number> = {};
  for (const [rawKey, rawTons] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeCommodityKey(rawKey);
    const tons = typeof rawTons === 'number' ? rawTons : Number.parseFloat(String(rawTons ?? ''));
    if (!key || !Number.isFinite(tons) || tons <= 0) continue;
    cargo[key] = (cargo[key] ?? 0) + tons;
  }
  return Object.keys(cargo).length > 0 ? cargo : null;
}

function readOptions(value: unknown): Partial<ResolvedSourcingOptions> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const num = (key: string): number | undefined => {
    const parsed = typeof record[key] === 'number' ? record[key] : Number.parseFloat(String(record[key] ?? ''));
    return Number.isFinite(parsed as number) ? (parsed as number) : undefined;
  };
  return {
    maxDistanceLy: num('maxDistanceLy'),
    capacityTons: num('capacityTons'),
    maxOffersPerCommodity: num('maxOffersPerCommodity'),
    minStockTons: num('minStockTons'),
    maxAgeDays: num('maxAgeDays'),
  };
}

/**
 * «Где купить»: раскладка закупок под план по своей базе EDDN.
 *
 * POST /api/architect/sourcing
 * { system: "HIP 90297", cargo: { steel: 14076, titanium: 8205 }, options? }
 *
 * Цены берутся из `market_prices` (EDDN-поток сайта), расстояния — из
 * каталога галактики `galaxy_systems`. Если в базе нет свежих цен по товару,
 * товар возвращается с нулевым покрытием и пометкой — интерфейс предлагает
 * поиск по EDSM (`/api/market/find`), а не выдумывает цены.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const system = typeof record.system === 'string' ? record.system.trim() : '';
    const cargo = readCargo(record.cargo);

    if (!system) return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    if (!cargo) return NextResponse.json({ error: 'cargo map is required' }, { status: 400 });

    const keys = Object.keys(cargo).slice(0, MAX_COMMODITIES);
    const limitedCargo = Object.fromEntries(keys.map((key) => [key, cargo[key]]));
    const options = readOptions(record.options);

    const svc = createServiceClient();

    const variants = Array.from(new Set(keys.flatMap(commodityNameVariants))).slice(0, MAX_VARIANTS);
    const { data: rows, error } = await svc
      .from('market_prices')
      .select('station_name,system_name,commodity_name,sell_price,stock,reported_at')
      .in('commodity_name', variants)
      .gt('stock', 0)
      .order('reported_at', { ascending: false })
      .limit(MAX_ROWS);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const priceRows = (rows ?? []) as MarketPriceRow[];

    // Координаты: своя система + все системы из выдачи рынков.
    const originRow = await findSystemByName(system).catch(() => null);
    const origin: SystemCoords | null = originRow ? { x: originRow.x, y: originRow.y, z: originRow.z } : null;
    const wantedNames = Array.from(new Set(priceRows.map((row) => String(row.system_name ?? '')).filter(Boolean)));
    let coordsByName = new Map<string, SystemCoords>();
    if (wantedNames.length > 0) {
      const found = await findSystemsByNames(wantedNames).catch(() => new Map());
      coordsByName = new Map(
        Array.from(found.values()).map((row) => [row.name.toLowerCase(), { x: row.x, y: row.y, z: row.z }]),
      );
    }

    const offers = buildOffers(limitedCargo, priceRows, { origin, coordsByName });
    const plan = planSourcing(limitedCargo, offers, options);

    return NextResponse.json({
      source: 'db',
      system,
      originFound: Boolean(origin),
      rowsScanned: priceRows.length,
      offers: offers.length,
      plan,
      empty: priceRows.length === 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/sourcing] POST error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
