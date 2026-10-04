import { NextResponse } from 'next/server';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { requireAdmin } from '@/lib/billing/auth';
import { createZip, trustedPublicKeys } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const VERSION = /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]{1,40})?$/;
const INCLUDED_SUFFIXES = new Set(['.py', '.txt', '.ico', '.png', '.csv', '.md']);

function suffix(name: string) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Готовит переносимый комплект для первой Windows-сборки.
 *
 * Сам production-сервер работает под Linux и не может выпустить Windows PE.
 * Поэтому администратор скачивает ZIP, распаковывает его на доверенной Windows
 * машине и запускает один bat-файл. Комплект уже содержит публичные ключи
 * текущего канала — собранный EXE сможет принимать последующие обновления.
 */
export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if ('response' in auth) return auth.response;

  const version = new URL(request.url).searchParams.get('version')?.trim().replace(/^v/i, '') || '';
  if (!VERSION.test(version)) {
    return NextResponse.json({ ok: false, error: 'Укажите корректную версию базовой сборки' }, { status: 400 });
  }

  const keys = trustedPublicKeys();
  if (Object.keys(keys).length === 0) {
    return NextResponse.json({ ok: false, error: 'Сначала настройте ключ подписи обновлений' }, { status: 400 });
  }

  try {
    const root = join(process.cwd(), 'uploader');
    const files = new Map<string, Buffer>();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !INCLUDED_SUFFIXES.has(suffix(entry.name))) continue;
      let data = await readFile(join(root, entry.name));
      if (entry.name === 'bundle.py') {
        const source = data.toString('utf8');
        if (!/^TRUSTED_KEYS:\s*Dict\[str, str\]\s*=\s*\{.*\}\s*$/m.test(source)) {
          throw new Error('Не удалось встроить ключи: в bundle.py не найден TRUSTED_KEYS');
        }
        const pythonKeys = JSON.stringify(keys, null, 2);
        data = Buffer.from(source.replace(
          /^TRUSTED_KEYS:\s*Dict\[str, str\]\s*=\s*\{.*\}\s*$/m,
          `TRUSTED_KEYS: Dict[str, str] = ${pythonKeys}`,
        ), 'utf8');
      } else if (entry.name === 'launcher.py') {
        const source = data.toString('utf8');
        data = Buffer.from(source.replace(
          /^LAUNCHER_VERSION\s*=\s*["'][^"']+["']/m,
          `LAUNCHER_VERSION = "${version}"`,
        ), 'utf8');
      }
      files.set(`ColonialHelper-build/${entry.name}`, data);
    }

    const bat = `@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nwhere py >nul 2>nul || (echo Python 3 is not installed. Install it from python.org and enable Add Python to PATH.& pause & exit /b 1)\r\npy -3 -m venv .venv || goto :error\r\ncall .venv\\Scripts\\activate.bat || goto :error\r\npython -m pip install --upgrade pip || goto :error\r\npython -m pip install -r requirements.txt pyinstaller || goto :error\r\npython build_exe.py || goto :error\r\necho.\r\necho READY: %CD%\\dist\\ColonialHelper.exe\r\nexplorer "%CD%\\dist"\r\npause\r\nexit /b 0\r\n:error\r\necho.\r\necho Build failed. See the error above.\r\npause\r\nexit /b 1\r\n`;
    const guide = `# Первая сборка Colonial Helper ${version}\n\n1. Распакуйте весь архив на доверенной машине Windows 10/11.\n2. Установите 64-битный Python 3 (рекомендуется 3.11) с python.org и включите **Add Python to PATH**.\n3. Запустите **BUILD-WINDOWS.bat**. Первый запуск скачает зависимости.\n4. Готовый файл находится в **dist\\ColonialHelper.exe**.\n5. В админке, в этом же разделе, выберите EXE и нажмите «Загрузить exe на сервер».\n\nВ комплект уже встроены публичные ключи текущего сервера. Приватные ключи в архив не попадают. После публикации пользователи скачивают этот EXE один раз, а следующие релизы приходят пакетами обновлений.\n`;
    files.set('ColonialHelper-build/BUILD-WINDOWS.bat', Buffer.from(bat, 'utf8'));
    files.set('ColonialHelper-build/КАК-СОБРАТЬ.md', Buffer.from(guide, 'utf8'));

    const archive = await createZip(files);
    return new NextResponse(new Uint8Array(archive), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="ColonialHelper-build-${version}.zip"`,
        'Content-Length': String(archive.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Не удалось подготовить комплект сборки' },
      { status: 500 },
    );
  }
}
