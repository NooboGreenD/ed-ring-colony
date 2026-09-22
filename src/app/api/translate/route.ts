import { NextResponse } from 'next/server';
import { SUPPORTED_TRANSLATION_LANGS, hasTranslateCredentials, translateTexts } from '@/lib/translate';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Ручной перевод строк из админки.
 * Логика вызова Yandex Translate живёт в scripts/lib/translate.mjs
 * (общий модуль для сайта и скриптов GitHub Actions).
 *
 * ВАЖНО про индексы: входной массив переводится целиком, ничего не
 * отфильтровывается. Раньше пустые строки выкидывались через `filter(Boolean)`,
 * из-за чего массив переводов съезжал относительно полей формы — кнопка
 * «перевести» заполняла чужими текстами или не заполняла недостающие блоки.
 */
const MAX_TEXTS = 40;
const MAX_TEXT_CHARS = 20_000;

function normalizeTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_TEXTS)
    .map((item) => (typeof item === 'string' ? item.trim().slice(0, MAX_TEXT_CHARS) : ''));
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as { texts?: unknown; sourceLang?: unknown } | null;
    const texts = normalizeTexts(body?.texts);

    if (texts.length === 0) {
      return NextResponse.json({ error: 'texts must be a non-empty array' }, { status: 400 });
    }

    const sourceLang = String(body?.sourceLang || 'ru').toLowerCase();
    const lang = /^[a-z]{2}$/.test(sourceLang) ? sourceLang : 'ru';
    // Пустые позиции не отправляем в API, но сохраняем индексы: translateTexts
    // возвращает массив ровно той же длины, что и входной.
    const hasWork = texts.some((item) => item.trim().length > 0);

    if (!hasWork) {
      return NextResponse.json({ success: false, error: 'Нечего переводить: исходные поля пусты', translations: {} }, { status: 400 });
    }

    if (!hasTranslateCredentials()) {
      return NextResponse.json(
        { success: false, error: 'YANDEX_TRANSLATE_API_KEY is not configured' },
        { status: 500 }
      );
    }

    const targetLangs = SUPPORTED_TRANSLATION_LANGS.filter((item) => item !== lang);
    const results: Record<string, string[]> = {};
    const errors: string[] = [];
    // Язык оригинала возвращается как есть — с той же индексацией.
    results[lang] = texts;

    const settled = await Promise.allSettled(
      targetLangs.map(async (targetLang) => {
        const translated = await translateTexts(texts, targetLang as typeof targetLang, lang);
        // Защита от «съехавшего» ответа API: длина обязана совпадать.
        if (translated.length !== texts.length) {
          throw new Error(`${targetLang}: API вернул ${translated.length} строк вместо ${texts.length}`);
        }
        return [targetLang, translated.map((item) => String(item ?? ''))] as const;
      }),
    );

    settled.forEach((outcome, index) => {
      const targetLang = targetLangs[index];
      if (outcome.status === 'fulfilled') {
        results[outcome.value[0]] = outcome.value[1];
      } else {
        errors.push(`${targetLang}: ${outcome.reason?.message || outcome.reason}`);
      }
    });

    const failedLangs = targetLangs.filter((targetLang) => !(targetLang in results));

    return NextResponse.json({
      success: errors.length === 0,
      sourceLang: lang,
      translations: results,
      translatedLangs: targetLangs.filter((targetLang) => targetLang in results),
      failedLangs,
      errors: errors.length ? errors : undefined,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
