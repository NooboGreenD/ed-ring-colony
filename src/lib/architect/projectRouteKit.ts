/**
 * Общая обвязка маршрутов `/api/architect/projects/**`: кто спрашивает,
 * разбор JSON, доступ к проекту и единый формат ошибок.
 */

import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';
import { loadProjectAccess, type AccessResult } from './projectStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;

export type ProjectAccess = Extract<AccessResult, { ok: true }>;

export function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[architect/projects]', message);
  return jsonError(message, 500);
}

export async function currentUserId(req: Request): Promise<string | null> {
  try {
    const { user } = await authFromRequest(req);
    return user?.id ?? null;
  } catch {
    return null;
  }
}

export async function readJson(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, response: jsonError('Ожидается JSON-объект', 400) };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, response: jsonError('Неверный JSON', 400) };
  }
}

/** Пилот вошёл и видит проект: иначе готовый ответ 401/404. */
export async function openProject(
  req: Request,
  projectId: string,
): Promise<{ ok: true; svc: Svc; userId: string; access: ProjectAccess } | { ok: false; response: Response }> {
  const userId = await currentUserId(req);
  if (!userId) return { ok: false, response: jsonError('Войдите, чтобы работать с проектом', 401) };
  const svc = createServiceClient();
  const access = await loadProjectAccess(svc, projectId, userId);
  if (!access.ok) return { ok: false, response: jsonError(access.error, access.status) };
  return { ok: true, svc, userId, access };
}
