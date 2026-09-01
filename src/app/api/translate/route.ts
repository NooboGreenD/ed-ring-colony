import { NextResponse } from 'next/server';

const YANDEX_API_URL = 'https://translate.api.cloud.yandex.net/translate/v2/translate';
const SUPPORTED_LANGS = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'];

function getYandexApiKey(): string {
  const key = process.env.YANDEX_TRANSLATE_API_KEY;
  if (!key) throw new Error('YANDEX_TRANSLATE_API_KEY not configured');
  return key;
}

async function translateBatch(
  texts: string[],
  targetLang: string,
  sourceLang: string
): Promise<string[]> {
  const apiKey = getYandexApiKey();
  const response = await fetch(YANDEX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Api-Key ${apiKey}`,
    },
    body: JSON.stringify({
      sourceLanguageCode: sourceLang,
      targetLanguageCode: targetLang,
      format: 'PLAIN_TEXT',
      texts: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Yandex Translate API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (!data.translations || !Array.isArray(data.translations)) {
    throw new Error('Yandex Translate API unexpected response');
  }
  return data.translations.map((t: any) => t.text);
}

export async function POST(req: Request) {
  try {
    const { texts, sourceLang = 'ru' } = await req.json();
    // texts: array of strings to translate
    if (!Array.isArray(texts) || texts.length === 0) {
      return NextResponse.json({ error: 'texts must be a non-empty array' }, { status: 400 });
    }

    const targetLangs = SUPPORTED_LANGS.filter((l) => l !== sourceLang);
    const results: Record<string, string[]> = {};

    await Promise.all(
      targetLangs.map(async (lang) => {
        results[lang] = await translateBatch(texts, lang, sourceLang);
      })
    );

    // Also include source language as-is
    results[sourceLang] = texts;

    return NextResponse.json({ success: true, translations: results });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
