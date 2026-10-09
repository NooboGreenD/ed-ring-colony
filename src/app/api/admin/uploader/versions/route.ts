import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/billing/auth';
import { startHelperReleaseJob } from '@/lib/helperReleaseJobs';
import {
  CHANNELS,
  type Channel,
  channelState,
  listVersions,
  promoteVersion,
  readManifest,
  storeStatus,
} from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * Панель администратора для канала обновлений Colonial Helper.
 *
 * `GET`  — что опубликовано и что сейчас стоит в каналах.
 * `POST` — перевести канал на другую версию. Это же и откат: сломанный релиз
 *          снимается возвратом канала на предыдущую версию, и пилоты получают
 *          её обычным механизмом обновления (пакет уже лежит на сервере).
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const versions = await listVersions();
  const channels = await channelState();
  const store = await storeStatus();

  const details = await Promise.all(
    versions.slice(0, 30).map(async (version) => {
      const manifest = await readManifest(version);
      return {
        version,
        channel: String(manifest?.channel ?? ''),
        released_at: String(manifest?.released_at ?? ''),
        files: Array.isArray(manifest?.files) ? manifest.files.length : 0,
        bytes: Array.isArray(manifest?.files)
          ? manifest.files.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
          : 0,
        min_launcher: String(manifest?.min_launcher ?? ''),
        signed: Boolean(manifest?.signature),
        // Каким ключом подписана версия: панель предупреждает, когда канал
        // указывает на пакет, подписанный неизвестным клиентам ключом.
        signed_key: String(manifest?.signature?.key_id ?? ''),
      };
    }),
  );

  return NextResponse.json({ ok: true, store, channels, versions: details }, NO_STORE);
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const body = (await request.json().catch(() => null)) as { channel?: unknown; version?: unknown; async?: unknown } | null;
  const channel = String(body?.channel ?? '');
  const version = String(body?.version ?? '');
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    return NextResponse.json({ ok: false, error: 'Неизвестный канал' }, { status: 400, ...NO_STORE });
  }

  if (body?.async === true) {
    try {
      const job = await startHelperReleaseJob({ channel: channel as Channel, version, kind: 'promote' });
      return NextResponse.json({ ok: true, job }, { status: 202, ...NO_STORE });
    } catch (error) {
      return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Не удалось поставить задачу в очередь' }, { status: 409, ...NO_STORE });
    }
  }

  const result = await promoteVersion(channel as Channel, version);
  return NextResponse.json(result, { status: result.ok ? 200 : 400, ...NO_STORE });
}
