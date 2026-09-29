import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { GOVERNANCE_TABLE } from '@/lib/architect/governance';
import { PLAN_TABLE } from '@/lib/architect/store';
import { readableProgress, statusFromProgress, systemNameKey } from '@/lib/systemProgress';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 1000;
const TOP_LIMIT = 10;

/**
 * Статистика для блоков лидерборда:
 *
 *   builtSystems  — самые застроенные системы за период: сумма тонн, что наши
 *                   пилоты завезли в систему (по deliveries), число пилотов и
 *                   текущий прогресс системы из кэша Raven (`system_progress`).
 *   topArchitects — топ-10 архитекторов: кто за какие системы закреплён
 *                   (`system_architects`) и сколько опубликованных планов,
 *                   построек и тонн перевозок у каждого автора (public-планы).
 */

interface SystemAggregate {
  systemName: string;
  totalAmount: number;
  deliveries: number;
  pilots: Set<string>;
  latestAt: string;
}

interface ArchitectAggregate {
  userId: string;
  cmdrName: string;
  plans: number;
  sites: number;
  haulTons: number;
  updatedAt: string;
  assignedSystems: number;
  assignedNames: string[];
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const period = searchParams.get('period') || 'all';
    const since = period === 'week'
      ? new Date(Date.now() - 7 * 86400000).toISOString()
      : period === 'month'
        ? new Date(Date.now() - 30 * 86400000).toISOString()
        : null;

    const supabase = await createClient();

    // ── Системы: сколько тонн завезено в каждую ────────────────────────
    const systems = new Map<string, SystemAggregate>();
    let offset = 0;
    while (true) {
      let query = supabase
        .from('deliveries')
        .select('id, user_id, system_name, amount, delivered_at')
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (since) query = query.gte('delivered_at', since);

      const { data, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      for (const row of data || []) {
        const amount = num(row.amount);
        if (amount <= 0) continue;
        const key = systemNameKey(row.system_name);
        if (!key) continue;
        let entry = systems.get(key);
        if (!entry) {
          entry = {
            systemName: String(row.system_name ?? '').trim(),
            totalAmount: 0,
            deliveries: 0,
            pilots: new Set<string>(),
            latestAt: String(row.delivered_at ?? ''),
          };
          systems.set(key, entry);
        }
        entry.totalAmount += amount;
        entry.deliveries += 1;
        const pilot = String(row.user_id ?? '');
        if (pilot) entry.pilots.add(pilot);
        // Название показываем свежим написанием; при равном времени остаётся
        // первое увиденное — обычно это каноничный регистр из журнала.
        const deliveredAt = String(row.delivered_at ?? '');
        if (deliveredAt > entry.latestAt) {
          entry.latestAt = deliveredAt;
          entry.systemName = String(row.system_name ?? '').trim() || entry.systemName;
        }
      }

      if (!data || data.length < PAGE_SIZE) break;
      offset += data.length;
    }

    const builtSystems = Array.from(systems.values())
      .sort((a, b) => b.totalAmount - a.totalAmount || b.deliveries - a.deliveries || a.systemName.localeCompare(b.systemName))
      .slice(0, TOP_LIMIT);

    // Прогресс стройки из кэша Raven — только для топа, колонки лёгкие.
    let progressBySystem = new Map<string, number | null>();
    if (builtSystems.length > 0) {
      const { data: progressRows, error: progressError } = await supabase
        .from('system_progress')
        .select('system_name, progress')
        .in('system_name', builtSystems.map((row) => row.systemName));
      if (!progressError) {
        progressBySystem = new Map(
          (progressRows || []).map((row: { system_name?: unknown; progress?: unknown }) => [
            systemNameKey(row.system_name),
            readableProgress(row.progress),
          ]),
        );
      }
    }

    // ── Архитекторы: опубликованные планы + закреплённые системы ───────
    const architects = new Map<string, ArchitectAggregate>();
    offset = 0;
    while (true) {
      const query = supabase
        .from(PLAN_TABLE)
        .select('id, author_id, author_name, site_count, haul_tons, updated_at')
        .eq('visibility', 'public')
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      const { data, error } = await query;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });

      for (const row of data || []) {
        const userId = String(row.author_id ?? '');
        if (!userId) continue;
        let entry = architects.get(userId);
        if (!entry) {
          entry = {
            userId,
            cmdrName: String(row.author_name ?? '') || 'Командир',
            plans: 0,
            sites: 0,
            haulTons: 0,
            updatedAt: '',
            assignedSystems: 0,
            assignedNames: [],
          };
          architects.set(userId, entry);
        }
        entry.plans += 1;
        entry.sites += num(row.site_count);
        entry.haulTons += num(row.haul_tons);
        // Позывной берём из самого свежего обновления, имя могло меняться.
        const updatedAt = String(row.updated_at ?? '');
        if (updatedAt >= entry.updatedAt && row.author_name) {
          entry.updatedAt = updatedAt;
          entry.cmdrName = String(row.author_name);
        }
      }

      if (!data || data.length < PAGE_SIZE) break;
      offset += data.length;
    }

    const { data: assignmentRows, error: assignmentError } = await supabase
      .from(GOVERNANCE_TABLE)
      .select('system_name, user_id, architect_name')
      .range(0, PAGE_SIZE - 1);
    if (!assignmentError) {
      for (const row of assignmentRows || []) {
        const userId = String(row.user_id ?? '');
        if (!userId) continue;
        let entry = architects.get(userId);
        if (!entry) {
          entry = {
            userId,
            cmdrName: String(row.architect_name ?? '') || 'Командир',
            plans: 0,
            sites: 0,
            haulTons: 0,
            updatedAt: '',
            assignedSystems: 0,
            assignedNames: [],
          };
          architects.set(userId, entry);
        }
        entry.assignedSystems += 1;
        const name = String(row.system_name ?? '').trim();
        if (name && entry.assignedNames.length < 3) entry.assignedNames.push(name);
        if (!entry.cmdrName || entry.cmdrName === 'Командир') {
          const architectName = String(row.architect_name ?? '').trim();
          if (architectName) entry.cmdrName = architectName;
        }
      }
    }

    const topArchitects = Array.from(architects.values())
      .map((entry) => ({
        user_id: entry.userId,
        cmdr_name: entry.cmdrName,
        plans_count: entry.plans,
        sites_count: entry.sites,
        haul_tons: entry.haulTons,
        assigned_systems: entry.assignedSystems,
        assigned_names: entry.assignedNames,
      }))
      .sort((a, b) =>
        b.assigned_systems - a.assigned_systems
        || b.sites_count - a.sites_count
        || b.haul_tons - a.haul_tons
        || a.cmdr_name.localeCompare(b.cmdr_name),
      )
      .slice(0, TOP_LIMIT)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));

    return NextResponse.json(
      {
        period,
        builtSystems: builtSystems.map((entry, index) => {
          const progress = progressBySystem.get(systemNameKey(entry.systemName)) ?? null;
          return {
            rank: index + 1,
            system_name: entry.systemName,
            total_amount: entry.totalAmount,
            deliveries_count: entry.deliveries,
            pilots: entry.pilots.size,
            progress,
            status: progress == null ? null : statusFromProgress(progress),
          };
        }),
        topArchitects,
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[leaderboard/stats] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
