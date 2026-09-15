import { NextResponse } from 'next/server';
import { SUPPORTED_TRANSLATION_LANGS, hasTranslateCredentials, translateTexts } from '@/lib/translate';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Ручной перевод строк из админки.
 * Логика вызова Yandex Translate живёт в scripts/lib/translate.mjs
 * (общий модуль для сайта и скриптов GitHub Actions).
 */
export async function POST(req: Request) {
  try {
    const { texts, sourceLang = 'ru' } = await req.json();

    if (!Array.isArray(texts) || texts.length === 0) {
      return NextResponse.json({ error: 'texts must be a non-empty array' }, { status: 400 });
    }

    if (!hasTranslateCredentials()) {
      return NextResponse.json(
        { success: false, error: 'YANDEX_TRANSLATE_API_KEY is not configured' },
        { status: 500 }
      );
    }

    const targetLangs = SUPPORTED_TRANSLATION_LANGS.filter((lang) => lang !== sourceLang);
    const results: Record<string, string[]> = {};
    const errors: string[] = [];

    await Promise.all(
      targetLangs.map(async (lang) => {
        try {
          results[lang] = await translateTexts(texts, lang, sourceLang);
        } catch (err: any) {
          errors.push(`${lang}: ${err?.message || err}`);
        }
      })
    );

    // Язык оригинала возвращаем как есть.
    results[sourceLang] = texts;

    return NextResponse.json({
      success: errors.length === 0,
      translations: results,
      errors: errors.length ? errors : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
