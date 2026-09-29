import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import {
  GOVERNANCE_TABLE,
  loadAssignment,
  loadCallerProfile,
  rowToAssignment,
  systemKey,
  type SystemArchitectRow,
} from '@/lib/architect/governance';

export const dynamic = 'force-dynamic';

/**
 * Администрирование архитектора системы.
 *
 *   GET    ?system=<имя>   — кто сейчас архитектор системы (видно всем) и
 *                            права того, кто спрашивает. `?search=<позывной>`
 *                            — подсказка имён для формы назначения (только админ).
 *   PUT    { system, architect } — назначить/сменить архитектора (только админ).
 *   DELETE { system }      — снять архитектора: админ или сам архитектор
 *                            («отказаться от системы»).
 */

function validSystemName(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

/** Поисковый запрос по позывному: вычищаем спецсимволы PostgREST/LIKE. */
function sanitizeSearch(value: string): string {
  return value.replace(/["(),%_\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const search = sanitizeSearch(searchParams.get('search') || '');
    if (search) {
      if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      const caller = await loadCallerProfile(supabase, user.id);
      if (caller.role !== 'admin') {
        return NextResponse.json({ error: 'Подбирать архитектора может только администратор' }, { status: 403 });
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('id, cmdr_name')
        .ilike('cmdr_name', `%${search}%`)
        .limit(8);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      const candidates = ((data ?? []) as { id?: unknown; cmdr_name?: unknown }[])
        .map((row) => ({ id: String(row.id ?? ''), name: String(row.cmdr_name ?? '') }))
        .filter((row) => row.id && row.name);
      return NextResponse.json({ search, candidates });
    }

    const system = validSystemName(searchParams.get('system'));
    if (!system) {
      return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    }

    const architect = await loadAssignment(supabase, system);
    let viewer = { userId: user?.id ?? null, isAdmin: false, isArchitect: false };
    if (user) {
      const caller = await loadCallerProfile(supabase, user.id);
      viewer = {
        userId: user.id,
        isAdmin: caller.role === 'admin',
        isArchitect: Boolean(architect) && architect?.userId === user.id,
      };
    }

    return NextResponse.json({ system, architect, viewer });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/governance] GET error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Назначить или сменить архитектора системы — только админ. */
export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const caller = await loadCallerProfile(supabase, user.id);
    if (caller.role !== 'admin') {
      return NextResponse.json({ error: 'Назначить архитектора системы может только администратор' }, { status: 403 });
    }

    const system = validSystemName(record.system);
    if (!system) {
      return NextResponse.json({ error: 'Не указано название системы' }, { status: 400 });
    }
    const architectName = validSystemName(record.architect);
    const needle = sanitizeSearch(architectName);
    if (!architectName || !needle) {
      return NextResponse.json({ error: 'Не указан позывной архитектора' }, { status: 400 });
    }

    // Позывной ищем без учёта регистра: командир введёт его как помнит.
    const { data: matches, error: findError } = await supabase
      .from('profiles')
      .select('id, cmdr_name')
      .ilike('cmdr_name', needle)
      .limit(2);
    if (findError) return NextResponse.json({ error: findError.message }, { status: 500 });
    const candidates = (matches ?? []) as { id?: unknown; cmdr_name?: unknown }[];
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: `Командир «${architectName}» не найден — пусть он хотя бы раз войдёт на сайт` },
        { status: 404 },
      );
    }
    if (candidates.length > 1) {
      return NextResponse.json(
        { error: 'Найдено несколько командиров с таким позывным — укажите точное имя' },
        { status: 409 },
      );
    }
    const candidate = candidates[0];
    const candidateId = String(candidate.id ?? '');
    const candidateName = String(candidate.cmdr_name ?? '').trim() || 'Командир';
    if (!candidateId) {
      return NextResponse.json({ error: 'У найденного профиля нет id' }, { status: 500 });
    }

    const { error } = await supabase
      .from(GOVERNANCE_TABLE)
      .upsert({
        system_name: system,
        system_name_lc: systemKey(system),
        user_id: candidateId,
        architect_name: candidateName,
        assigned_by: user.id,
        assigned_by_name: caller.cmdrName || 'Командир',
      }, { onConflict: 'system_name_lc' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const architect = await loadAssignment(supabase, system);
    return NextResponse.json({ ok: true, system, architect });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/governance] PUT error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Снять архитектора: админ всегда, сам архитектор — отказом от системы. */
export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const system = validSystemName(
      body && typeof body === 'object'
        ? (body as Record<string, unknown>).system
        : new URL(req.url).searchParams.get('system'),
    );
    if (!system) {
      return NextResponse.json({ error: 'Не указано название системы' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: existing, error: readError } = await supabase
      .from(GOVERNANCE_TABLE)
      .select('id,system_name,user_id,architect_name,assigned_by,assigned_by_name,created_at,updated_at')
      .eq('system_name_lc', systemKey(system))
      .maybeSingle();
    if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
    const assignment = rowToAssignment(existing as SystemArchitectRow | null);
    if (!assignment || !existing?.id) {
      return NextResponse.json({ error: 'Архитектор этой системе не назначен' }, { status: 404 });
    }

    const caller = await loadCallerProfile(supabase, user.id);
    if (assignment.userId !== user.id && caller.role !== 'admin') {
      return NextResponse.json(
        { error: 'Снять архитектора может админ или сам архитектор (отказ от системы)' },
        { status: 403 },
      );
    }

    const { error } = await supabase
      .from(GOVERNANCE_TABLE)
      .delete()
      .eq('id', existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const resigned = assignment.userId === user.id && caller.role !== 'admin';
    return NextResponse.json({ ok: true, system, resigned });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[architect/governance] DELETE error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
