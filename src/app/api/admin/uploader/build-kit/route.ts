import { NextResponse } from 'next/server';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { requireAdmin } from '@/lib/billing/auth';
import { createZip, embedTrustedKeys, trustedPublicKeys } from '@/lib/uploaderStore';

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
        data = Buffer.from(embedTrustedKeys(data.toString('utf8'), keys), 'utf8');
      } else if (entry.name === 'launcher.py') {
        const source = data.toString('utf8');
        data = Buffer.from(source.replace(
          /^LAUNCHER_VERSION\s*=\s*["'][^"']+["']/m,
          `LAUNCHER_VERSION = "${version}"`,
        ), 'utf8');
      }
      files.set(`ColonialHelper-build/${entry.name}`, data);
    }

    const bat = [
      '@echo off',
      'setlocal',
      'cd /d "%~dp0"',
      'where py >nul 2>nul || (echo Python 3 is not installed. Install it from python.org and enable Add Python to PATH.& pause & exit /b 1)',
      'py -3 -m venv .venv || goto :error',
      'call .venv\\Scripts\\activate.bat || goto :error',
      'python -m pip install --upgrade pip || goto :error',
      'python -m pip install -r requirements.txt pyinstaller || goto :error',
      'python build_exe.py || goto :error',
      'python build_installer.py || goto :error',
      'echo.',
      'echo READY: %CD%\\dist\\ColonialHelperSetup.exe',
      'echo Launcher payload for the updater: %CD%\\dist\\ColonialHelper.exe',
      'explorer "%CD%\\dist"',
      'pause',
      'exit /b 0',
      ':error',
      'echo.',
      'echo Build failed. See the error above.',
      'pause',
      'exit /b 1',
      '',
    ].join('\r\n');
    const guide = `# Первая сборка Colonial Helper ${version}\n\n1. Распакуйте весь архив на доверенной машине Windows 10/11.\n2. Установите 64-битный Python 3 (рекомендуется 3.11) с python.org и включите **Add Python to PATH**.\n3. Запустите **BUILD-WINDOWS.bat**. Первый запуск скачает зависимости и соберёт оба файла.\n4. Для первичной установки и распространения используйте **dist\\ColonialHelperSetup.exe**. Он устанавливает лаунчер, создаёт ярлыки и запускает Helper.\n5. Файл **dist\\ColonialHelper.exe** — встроенный лаунчер/payload для штатной системы обновлений. В админке загружайте именно его в поле «Базовая сборка ColonialHelper.exe»; не заменяйте его установщиком Setup.\n\nВ комплект уже встроены публичные ключи текущего сервера. Приватные ключи в архив не попадают. Пользователям для первой установки раздаётся Setup; установленный лаунчер сохраняет получение пакетных обновлений.\n`;
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
