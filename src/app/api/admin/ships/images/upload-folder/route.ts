import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { requireAdmin } from '@/lib/billing/auth';
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/** POST — массовая загрузка картинок кораблей из локальной папки в bucket ship-images.
 *
 * Тело запроса: JSON { folder: 'ship-images' | 'ship-images-realistic' }
 * folder — имя папки внутри public/ (без префикса public/).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
  } catch {
    return response({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const body = await req.json().catch(() => ({}));
  const folder = String(body.folder ?? '');

  if (!folder || !/^[a-z0-9_-]+$/.test(folder)) {
    return response({ error: 'Invalid folder name' }, { status: 400 });
  }

  const folderPath = join(process.cwd(), 'public', folder);
  let files: string[];
  try {
    files = readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith('.png'));
    files.sort();
  } catch {
    return response({ error: `Folder public/${folder} not found` }, { status: 404 });
  }

  let success = 0;
  let skipped = 0;
  let failed = 0;
  const errors: Array<{ file: string; error: string }> = [];

  for (const file of files) {
    const filePath = join(folderPath, file);
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      skipped++;
      errors.push({ file, error: 'too large' });
      continue;
    }

    const shipId = file.replace(/\.png$/i, '');
    const buffer = readFileSync(filePath);

    try {
      const { error } = await svc.storage.from('ship-images').upload(file, buffer, {
        contentType: 'image/png',
        upsert: true,
      });

      if (error) {
        failed++;
        errors.push({ file, error: error.message });
      } else {
        success++;
      }
    } catch (err) {
      failed++;
      errors.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return response({
    success,
    skipped,
    failed,
    total: files.length,
    folder,
    errors: errors.slice(0, 20), // ограничиваем вывод ошибок
  }, { status: failed > 0 ? 207 : 200 });
}
