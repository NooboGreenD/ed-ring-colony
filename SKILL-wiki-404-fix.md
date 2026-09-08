# Навык: Исправление 404 на динамических wiki-страницах (Next.js + Supabase + Vercel)

## Проблема
На Vercel динамические страницы wiki (`/wiki/[slug]`, `/wiki/category/[slug]`, `/wiki/tag/[slug]`)
отдавали 404, хотя на главной `/wiki` всё работало.

## Корень проблемы

### 1. `generateStaticParams` падает на этапе сборки
`generateStaticParams` вызывается во время `next build` на Vercel. `createServiceClient()`
требует `SUPABASE_SERVICE_ROLE_KEY`, которая недоступна в окружении сборки.
Результат — пустой список slug'ов, статические страницы не генерируются.

### 2. `.single()` выбрасывает ошибку при пустом результате
Supabase `.single()` возвращает ошибку, если запрос не нашёл ровно одну строку.
На Vercel в serverless-функциях это приводит к `notFound()` → 404.

### 3. JOIN с внешними ключами падает на Vercel
```ts
.select('*, profiles!wiki_articles_author_id_fkey(cmdr_name)')
```
Такие JOIN'ы иногда падают в serverless-окружении из-за таймаутов или RLS.

## Решение

### Шаг 1: Убрать `generateStaticParams`
Заменить на `export const dynamic = 'force-dynamic'`:
```tsx
// ❌ Было
export async function generateStaticParams() { ... }

// ✅ Стало
export const dynamic = 'force-dynamic';
```

### Шаг 2: Заменить `createClient()` на `createServiceClient()`
```tsx
// ❌ Было
import { createClient } from '@/lib/supabaseServer';
const supabase = createClient(); // использует cookies() из next/headers

// ✅ Стало
import { createServiceClient } from '@/lib/supabaseServer';
const supabase = createServiceClient(); // прямой service role key
```

### Шаг 3: Заменить `.single()` на `.maybeSingle()`
```tsx
// ❌ Было
const { data } = await supabase.from('table').select('*').eq('slug', slug).single();
if (!data) return notFound();

// ✅ Стало
const { data, error } = await supabase.from('table').select('*').eq('slug', slug).maybeSingle();
if (error) {
  // Показать страницу ошибки вместо 404
  return <ErrorPage message={error.message} />;
}
if (!data) return notFound();
```

### Шаг 4: Разделить JOIN на отдельные запросы
```tsx
// ❌ Было — один запрос с JOIN
const { data: articles } = await supabase
  .from('wiki_articles')
  .select('id, title, profiles!fk(cmdr_name)')
  .eq('category_id', catId);

// ✅ Стало — раздельные запросы
const { data: articles } = await supabase
  .from('wiki_articles')
  .select('id, title, author_id')
  .eq('category_id', catId);

const authorIds = [...new Set(articles.map(a => a.author_id))];
const { data: profiles } = await supabase
  .from('profiles')
  .select('id, cmdr_name')
  .in('id', authorIds);

const authorMap = Object.fromEntries(profiles.map(p => [p.id, p.cmdr_name]));
```

## Проверка
1. Главная `/wiki` — работает (не динамическая)
2. Статья `/wiki/[slug]` — работает
3. Категория `/wiki/category/[slug]` — работает
4. Тег `/wiki/tag/[slug]` — работает

## Применённые коммиты
- `66a1717` — убран `generateStaticParams`, добавлен `revalidate=30`
- `91faed9` — заменено на `dynamic = 'force-dynamic'`
- `d8fd88c` — удалён `public/wiki` (конфликт маршрутов)
- `be34c5a` — `createClient` → `createServiceClient`
- `0840cd3` — разделены запросы, `.single()` → `.maybeSingle()`
- `ae233ed` — аналогичные фиксы для category/tag/edit/history

## Когда применять
- Next.js 14 App Router + Supabase + Vercel
- Динамические маршруты `[slug]` отдают 404
- Работает локально, но не на проде
- В логах Vercel: ошибки Supabase или `notFound()`
