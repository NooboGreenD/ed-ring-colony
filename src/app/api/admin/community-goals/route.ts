import { randomInt, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { normalizeCommunityGoals } from '@/lib/inara/community-goals.mjs';
import { syncCommunityGoalsFromCapi, upsertCommunityGoalCatalog } from '@/lib/communityGoalCatalog';
import { InaraClient } from '@/lib/inara/client';
import { CapiError, describeCapiError } from '@/lib/capi/client';
import { capiSession } from '@/lib/capi/session';
import { safeCapiDiagnostic } from '@/lib/capi/syncJobs';
import {
  COMMUNITY_GOAL_EDITABLE_FIELDS,
  effectiveCommunityGoal,
  isCommunityGoalModerationStatus,
} from '@/lib/communityGoalAdmin';
import { requireAdmin } from '@/lib/billing/auth';
import { readAllRows } from '@/lib/readAllRows';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const headers = { 'Cache-Control': 'no-store' };
const MAX_TEXT_LENGTH: Record<string, number> = {
  title: 300,
  description: 12_000,
  system_name: 200,
  station_name: 300,
  objective: 4_000,
  reward: 4_000,
  inara_url: 500,
};
const NUMBER_FIELDS = new Set(['tier_current', 'tier_max', 'contributors', 'contributions_total']);
const TEXT_FIELDS = new Set(Object.keys(MAX_TEXT_LENGTH));
const BOOLEAN_FIELDS = new Set(['is_complete', 'is_colonisation_related']);

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400, headers });
}

function normalizeEditableFields(value: Record<string, unknown>): { fields?: Record<string, unknown>; error?: string } {
  const fields: Record<string, unknown> = {};
  for (const field of COMMUNITY_GOAL_EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const item = value[field];
    if (TEXT_FIELDS.has(field)) {
      if (item !== null && typeof item !== 'string') return { error: `Поле ${field}: ожидается текст` };
      const text = typeof item === 'string' ? item.trim() : '';
      if (field === 'title' && !text) return { error: 'Название CG обязательно' };
      if (text.length > MAX_TEXT_LENGTH[field]) return { error: `Поле ${field} превышает допустимую длину` };
      if (field === 'inara_url' && text && !/^https:\/\/inara\.cz\//i.test(text)) {
        return { error: 'Ссылка должна вести на https://inara.cz/' };
      }
      fields[field] = text || null;
      continue;
    }
    if (NUMBER_FIELDS.has(field)) {
      if (item === null || item === '') {
        fields[field] = null;
        continue;
      }
      const parsed = typeof item === 'number' ? item : Number(item);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return { error: `Поле ${field}: требуется целое число не меньше нуля` };
      fields[field] = parsed;
      continue;
    }
    if (BOOLEAN_FIELDS.has(field)) {
      if (typeof item !== 'boolean') return { error: `Поле ${field}: ожидается true/false` };
      fields[field] = item;
      continue;
    }
    if (field === 'expiry_date') {
      if (item === null || item === '') {
        fields[field] = null;
        continue;
      }
      if (typeof item !== 'string' || !Number.isFinite(Date.parse(item))) return { error: 'Некорректная дата завершения' };
      fields[field] = new Date(item).toISOString();
    }
  }
  return { fields };
}

function accountId(actor: { userId: string }): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(actor.userId) ? actor.userId : null;
}

export async function GET(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  const svc = createServiceClient();
  const result = await readAllRows((from, to) => svc
    .from('community_goals')
    .select('*')
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to));
  if (result.error) {
    return NextResponse.json({ error: result.error.message }, { status: 500, headers });
  }
  const rows = result.data.map((row: Record<string, any>) => effectiveCommunityGoal(row));
  const sourceNames = ['inara', 'capi', 'journal', 'manual'] as const;
  const sources = Object.fromEntries(sourceNames.map((source) => [source, {
    records: 0,
    latestAt: null as string | null,
  }]));
  for (const row of rows) {
    const source = row.source as typeof sourceNames[number];
    if (!source || !sources[source]) continue;
    sources[source].records += 1;
    const updatedAt = typeof row.source_updated_at === 'string' ? row.source_updated_at : null;
    if (updatedAt && (!sources[source].latestAt || updatedAt > sources[source].latestAt!)) {
      sources[source].latestAt = updatedAt;
    }
  }
  const { data: latestHelperReport } = await svc.from('community_goal_commander_reports')
    .select('observed_at')
    .eq('source', 'helper')
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return NextResponse.json({
    goals: rows,
    counts: {
      all: rows.length,
      active: rows.filter((row) => !row.is_complete).length,
      completed: rows.filter((row) => row.is_complete).length,
      pending: rows.filter((row) => row.moderation_status === 'pending').length,
      pendingJournalActive: rows.filter((row) => row.source === 'journal'
        && row.moderation_status === 'pending'
        && row.is_complete !== true
        && typeof row.expiry_date === 'string'
        && Date.parse(row.expiry_date) > Date.now()).length,
      pendingJournalStale: rows.filter((row) => row.source === 'journal'
        && row.moderation_status === 'pending'
        && (row.is_complete === true || typeof row.expiry_date !== 'string'
          || !Number.isFinite(Date.parse(row.expiry_date)) || Date.parse(row.expiry_date) <= Date.now())).length,
      missingGoalText: rows.filter((row) => !String(row.objective || '').trim()
        && !String(row.description || '').trim()
        && !String(row.reward || '').trim()).length,
      hidden: rows.filter((row) => row.moderation_status === 'hidden').length,
      rejected: rows.filter((row) => row.moderation_status === 'rejected').length,
      manual: sources.manual.records,
      capi: sources.capi.records,
      journal: sources.journal.records,
      inara: sources.inara.records,
    },
    sources: {
      catalog: sources,
      helperReports: { latestAt: latestHelperReport?.observed_at ?? null },
    },
  }, { headers });
}

export async function POST(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try {
    const value = await req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return badRequest('Ожидается JSON-объект');
    body = value as Record<string, unknown>;
  } catch {
    return badRequest('Некорректный JSON');
  }

  const svc = createServiceClient();
  if (body.action === 'bulk-approve-current-journal') {
    const now = new Date().toISOString();
    const { data, error } = await svc.from('community_goals').update({
      moderation_status: 'approved',
      updated_at: now,
      updated_by: accountId(auth.actor),
    })
      .eq('source', 'journal')
      .eq('moderation_status', 'pending')
      .eq('is_complete', false)
      .gt('expiry_date', now)
      .select('id');
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
    return NextResponse.json({ ok: true, updated: Array.isArray(data) ? data.length : 0 }, { headers });
  }
  if (body.action === 'bulk-archive-stale-journal') {
    const now = new Date().toISOString();
    const patch = {
      moderation_status: 'hidden',
      updated_at: now,
      updated_by: accountId(auth.actor),
    };
    let updated = 0;
    for (const applyFilter of [
      (query: any) => query.eq('is_complete', true),
      (query: any) => query.lte('expiry_date', now),
      (query: any) => query.is('expiry_date', null),
    ]) {
      const { data, error } = await applyFilter(svc.from('community_goals').update(patch)
        .eq('source', 'journal').eq('moderation_status', 'pending')).select('id');
      if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
      updated += Array.isArray(data) ? data.length : 0;
    }
    return NextResponse.json({ ok: true, updated }, { headers });
  }

  if (body.action === 'sync') {
    const apiKey = process.env.INARA_API_KEY;
    if (!apiKey) return NextResponse.json({
      error: 'Не задан INARA_API_KEY. Каталог продолжит получать данные из CAPI и журналов; новые журнальные CG ожидают модерации.',
      fallbackSources: ['Frontier CAPI', 'commander journal uploads'],
    }, { status: 503, headers });
    try {
      const sourceGoals = await new InaraClient(apiKey).getCommunityGoals();
      const rows = normalizeCommunityGoals(sourceGoals);
      const synced = await upsertCommunityGoalCatalog(svc, rows, 'inara');
      return NextResponse.json({ ok: true, synced, received: sourceGoals.length, completed: rows.filter((row) => row.is_complete).length }, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[admin/community-goals] Inara sync failed:', message);
      return NextResponse.json({
        error: `${message}. В это время каталог продолжает получать официальные CG из Frontier CAPI; журнальные находки доступны в очереди модерации.`,
        fallbackSources: ['Frontier CAPI', 'commander journal uploads'],
      }, { status: 502, headers });
    }
  }

  if (body.action === 'sync-capi') {
    const { data: token, error: tokenError } = await svc.from('capi_tokens')
      .select('*')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (tokenError) return NextResponse.json({ error: tokenError.message }, { status: 500, headers });
    if (!token) return NextResponse.json({
      error: 'Нет активной Frontier OAuth-привязки сайта для чтения CAPI. Helper не создаёт отдельную Frontier-привязку.',
      source: 'capi',
    }, { status: 409, headers });

    try {
      const session = await capiSession(svc, token.user_id, token);
      const payload = await session.run((client) => client.getCommunityGoals());
      const received = Array.isArray(payload.goals) ? payload.goals.length : 0;
      const synced = await syncCommunityGoalsFromCapi(svc, payload);
      return NextResponse.json({ ok: true, source: 'capi', received, synced }, { headers });
    } catch (error) {
      const message = safeCapiDiagnostic(error instanceof CapiError
        ? describeCapiError(error)
        : error instanceof Error ? error.message : String(error));
      console.error('[admin/community-goals] Frontier CAPI sync failed:', message);
      return NextResponse.json({
        error: `Frontier CAPI sync failed: ${message}. Inara and Colonial Helper journal sources remain independent.`,
        source: 'capi',
      }, { status: 502, headers });
    }
  }

  if (body.action !== 'create') return badRequest('Неизвестное действие');
  const parsed = normalizeEditableFields(body);
  if (!parsed.fields) return badRequest(parsed.error || 'Некорректные поля CG');
  const fields = parsed.fields;
  if (typeof fields.title !== 'string' || !fields.title) return badRequest('Название CG обязательно');
  if (typeof body.moderation_status === 'string' && body.moderation_status !== 'approved') {
    return badRequest('Создаваемая CG должна быть опубликована администратором');
  }

  let cgId = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    cgId = -randomInt(1, 2_147_483_648);
    const { data, error } = await svc.from('community_goals').select('id').eq('cg_id', cgId).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
    if (!data) break;
    cgId = 0;
  }
  if (cgId === 0) return NextResponse.json({ error: 'Не удалось выделить ID для пользовательской CG; повторите попытку' }, { status: 503, headers });

  const now = new Date().toISOString();
  const row = {
    ...fields,
    cg_id: cgId,
    identity_key: `manual:${randomUUID()}`,
    source: 'manual',
    moderation_status: 'approved',
    manual_overrides: {},
    admin_note: typeof body.admin_note === 'string' ? body.admin_note.trim().slice(0, 2_000) || null : null,
    created_by: accountId(auth.actor),
    updated_by: accountId(auth.actor),
    is_colonisation_related: true,
    is_complete: fields.is_complete ?? false,
    updated_at: now,
  };
  const { data, error } = await svc.from('community_goals').insert(row).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
  return NextResponse.json({ goal: effectiveCommunityGoal(data) }, { status: 201, headers });
}

export async function PATCH(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try {
    const value = await req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return badRequest('Ожидается JSON-объект');
    body = value as Record<string, unknown>;
  } catch {
    return badRequest('Некорректный JSON');
  }

  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id < 1) return badRequest('Некорректный ID CG');
  const svc = createServiceClient();
  const { data: existing, error: readError } = await svc.from('community_goals').select('*').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500, headers });
  if (!existing) return NextResponse.json({ error: 'CG не найдена' }, { status: 404, headers });

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: accountId(auth.actor),
  };
  const hasEditableValues = COMMUNITY_GOAL_EDITABLE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (body.resetOverrides === true) {
    if (existing.source === 'manual') return badRequest('Для локальной CG нечего сбрасывать');
    update.manual_overrides = {};
  } else if (hasEditableValues) {
    const parsed = normalizeEditableFields(body);
    if (!parsed.fields) return badRequest(parsed.error || 'Некорректные поля CG');
    if (existing.source !== 'manual') {
      const previous = existing.manual_overrides && typeof existing.manual_overrides === 'object' && !Array.isArray(existing.manual_overrides)
        ? existing.manual_overrides
        : {};
      update.manual_overrides = { ...previous, ...parsed.fields };
    } else {
      Object.assign(update, parsed.fields);
    }
  }

  if (body.moderation_status !== undefined) {
    if (!isCommunityGoalModerationStatus(body.moderation_status)) return badRequest('Некорректный статус модерации');
    update.moderation_status = body.moderation_status;
  }
  if (body.admin_note !== undefined) {
    if (body.admin_note !== null && typeof body.admin_note !== 'string') return badRequest('Комментарий модератора должен быть текстом');
    update.admin_note = typeof body.admin_note === 'string' ? body.admin_note.trim().slice(0, 2_000) || null : null;
  }
  if (Object.keys(update).length <= 2) return badRequest('Нет изменений для сохранения');

  const { data, error } = await svc.from('community_goals').update(update).eq('id', id).select('*').single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
  return NextResponse.json({ goal: effectiveCommunityGoal(data) }, { headers });
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin(req);
  if ('response' in auth) return auth.response;
  let body: Record<string, unknown>;
  try {
    const value = await req.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return badRequest('Ожидается JSON-объект');
    body = value as Record<string, unknown>;
  } catch {
    return badRequest('Некорректный JSON');
  }
  const id = Number(body.id);
  if (!Number.isSafeInteger(id) || id < 1) return badRequest('Некорректный ID CG');
  const svc = createServiceClient();
  const { data: existing, error: readError } = await svc.from('community_goals').select('id,source').eq('id', id).maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500, headers });
  if (!existing) return NextResponse.json({ error: 'CG не найдена' }, { status: 404, headers });
  if (existing.source !== 'manual') return NextResponse.json({ error: 'Записи внешних источников нельзя физически удалить: используйте статус «Отклонена» или «Скрыта»' }, { status: 409, headers });
  const { error } = await svc.from('community_goals').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers });
  return NextResponse.json({ ok: true }, { headers });
}
