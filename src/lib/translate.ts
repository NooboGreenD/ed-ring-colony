export const SUPPORTED_TRANSLATION_LANGS = ['ru', 'en', 'de', 'it', 'ko', 'zh', 'ja'] as const;
export type TranslationLang = (typeof SUPPORTED_TRANSLATION_LANGS)[number];

export interface TranslationResult {
  title: Record<TranslationLang, string>;
  body: Record<TranslationLang, string>;
  translatedAt: string;
}

// Yandex Cloud Translate API v2 (2026)
// Endpoint: https://translate.api.cloud.yandex.net/translate/v2/translate
// Auth: Authorization: Api-Key YOUR_KEY
// Format: POST JSON body with texts[] array (batch support)

const YANDEX_API_URL = 'https://translate.api.cloud.yandex.net/translate/v2/translate';

function getYandexApiKey(): string {
  const key = process.env.YANDEX_TRANSLATE_API_KEY;
  if (!key) {
    throw new Error('YANDEX_TRANSLATE_API_KEY not configured');
  }
  return key;
}

/**
 * Переводит массив текстов через Yandex Cloud Translate API v2.
 * Поддерживает batch: до 10000 символов суммарно.
 * Возвращает массив переведённых строк.
 */
async function translateBatch(
  texts: string[],
  targetLang: TranslationLang,
  sourceLang: string = 'en'
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

  // Response format: { translations: [{ text: "...", detectedLanguageCode: "en" }] }
  if (!data.translations || !Array.isArray(data.translations)) {
    throw new Error(`Yandex Translate API unexpected response: ${JSON.stringify(data)}`);
  }

  return data.translations.map((t: any) => t.text);
}

/**
 * Переводит заголовок и тело статьи на все 7 языков параллельно.
 * Использует batch-перевод (title + body в одном запросе на язык).
 */
export async function translateToAllLangs(
  title: string,
  body: string,
  sourceLang: string = 'en'
): Promise<TranslationResult> {
  const titleResults: Partial<Record<TranslationLang, string>> = {};
  const bodyResults: Partial<Record<TranslationLang, string>> = {};

  await Promise.all(
    SUPPORTED_TRANSLATION_LANGS.map(async (lang) => {
      // Batch: переводим title и body в одном запросе
      const translated = await translateBatch([title, body], lang, sourceLang);
      titleResults[lang] = translated[0];
      bodyResults[lang] = translated[1];
    })
  );

  return {
    title: titleResults as Record<TranslationLang, string>,
    body: bodyResults as Record<TranslationLang, string>,
    translatedAt: new Date().toISOString(),
  };
}

/**
 * Переводит одну статью и сохраняет все переводы в Supabase.
 */
export async function translateAndSaveArticle(
  table: 'news' | 'galnet_news',
  articleId: number | string,
  title: string,
  body: string,
  supabase: any,
  sourceLang: string = 'en'
): Promise<void> {
  const translated = await translateToAllLangs(title, body, sourceLang);

  const updateData: Record<string, string> = {};
  SUPPORTED_TRANSLATION_LANGS.forEach((lang) => {
    updateData[`title_${lang}`] = translated.title[lang];
    updateData[`body_${lang}`] = translated.body[lang];
  });
  updateData['translated_at'] = translated.translatedAt;
  updateData['translation_status'] = 'completed';

  const { error } = await supabase
    .from(table)
    .update(updateData)
    .eq('id', articleId);

  if (error) throw error;
}