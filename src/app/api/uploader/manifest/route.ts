import { NextRequest, NextResponse } from 'next/server';

import { manifestForChannel, normalizeChannel, readManifest } from '@/lib/uploaderStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Манифест канала обновлений Colonial Helper.
 *
 * Отсюда программа узнаёт, какая версия кода сейчас актуальна и из каких
 * файлов она состоит. Дальше она качает ТОЛЬКО те файлы, чей sha256 не
 * совпал с локальным — обычно 1–3 модуля вместо 22-мегабайтного exe.
 *
 * Ответ публичный: в нём нет ничего, кроме списка файлов и подписи. Подпись
 * (Ed25519) и делает канал безопасным — клиент не поставит пакет, который
 * подписан не нашим ключом, кем бы этот ответ ни был отдан.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const channel = normalizeChannel(url.searchParams.get('channel'));
  const version = (url.searchParams.get('version') ?? '').trim();

  const manifest = version ? await readManifest(version) : await manifestForChannel(channel);
  if (!manifest) {
    return NextResponse.json(
      {
        ok: false,
        error: version
          ? `Версия ${version} не опубликована`
          : `В канале «${channel}» пока нет опубликованных сборок`,
        channel,
      },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    { ok: true, channel, manifest },
    {
      headers: {
        // Минута — компромисс: обновление доезжает быстро, а массовая
        // автопроверка на старте не бьёт по серверу.
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    },
  );
}
