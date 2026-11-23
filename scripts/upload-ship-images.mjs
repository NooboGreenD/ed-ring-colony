/*
 * Массовая загрузка картинок кораблей в Supabase Storage bucket `ship-images`.
 *
 * Использование:
 *   node --env-file=.env.local scripts/upload-ship-images.mjs [folder]
 *
 * folder — папка с PNG картинками (по умолчанию public/ship-images-realistic).
 *   public/ship-images/ — векторный стиль
 *   public/ship-images-realistic/ — реалистичный стиль
 *
 * Требуемые переменные окружения (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL — публичный URL Supabase
 *   SUPABASE_SERVICE_ROLE_KEY — сервисный ключ с правами на запись в storage
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Create .env.local with both values and re-run.');
  process.exit(1);
}

const folder = process.argv[2] || 'public/ship-images-realistic';
const bucket = 'ship-images';
const maxBytes = 10 * 1024 * 1024; // 10 MB

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }) },
});

async function main() {
  const files = readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.png'));
  files.sort();

  console.log(`📁 Папка: ${folder}`);
  console.log(`🖼️  Найдено PNG: ${files.length}`);
  console.log(`🪣 Bucket: ${bucket}`);
  console.log('');

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = join(folder, file);
    const stat = statSync(filePath);
    if (stat.size > maxBytes) {
      console.log(`⏭️  Пропуск (слишком большой): ${file} (${Math.round(stat.size / 1024)} KB)`);
      skipped++;
      continue;
    }

    const shipId = file.replace(/\.png$/i, '');
    const buffer = readFileSync(filePath);

    try {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(file, buffer, {
          contentType: 'image/png',
          upsert: true,
        });

      if (error) {
        console.log(`❌ Ошибка загрузки ${file}: ${error.message}`);
        failed++;
      } else {
        console.log(`✅ Загружено: ${file} (${Math.round(stat.size / 1024)} KB)`);
        success++;
      }
    } catch (err) {
      console.log(`❌ Исключение при загрузке ${file}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log('');
  console.log('━'.repeat(40));
  console.log(`✅ Успешно: ${success}`);
  console.log(`⏭️  Пропущено: ${skipped}`);
  console.log(`❌ Ошибок: ${failed}`);
  console.log(`📊 Всего: ${files.length}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('❌ Неожиданная ошибка:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
