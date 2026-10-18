# Публикация гайда по колонизации на вики ED Ring Colony

> Гайд уже создаётся миграцией `supabase/migrations/20260903010000_wiki_update_colonization.sql`
> (на свежей базе — создаётся, на существующей — обновляется). Способы ниже нужны,
> только если статью надо опубликовать или обновить вручную.

## Файлы, подготовленные для публикации

### 1. Изображения (скопированы в проект)

```
public/wiki/colonization-guide/
├── ed_colonization_flowchart_v2.png     (135 KB)
├── ed_colonization_techtree_v2.png      (221 KB)
├── ed_colonization_stats_v2.png         (201 KB)
├── ed_colonization_logistics_v2.png     (170 KB)
└── ed_colonization_system_choice_v2.png (185 KB)
```

### 2. Статья (Markdown для ручной вставки)

```
public/wiki/colonization-guide/article.md
```

### 3. SQL-скрипт для вставки в БД

```
supabase/templates/wiki_colonization_guide.sql.template
```

---

## Способ 1: ручная публикация через вики-интерфейс (рекомендуется)

1. Войдите на сайт ED Ring Colony.
2. Откройте **Вики → Создать статью** (`/wiki/create`).
3. Заполните поля:
   - **Заголовок:** `Полный гайд по колонизации в Elite Dangerous`
   - **Slug:** `polnyy-gayd-po-kolonizacii-v-elite-dangerous`
   - **Категория:** `Колонизация`
   - **Содержание:** скопируйте содержимое `public/wiki/colonization-guide/article.md`
4. Нажмите **Сохранить**.
5. Проверьте, что изображения отображаются корректно.

---

## Способ 2: публикация через API (для разработчиков)

`POST /api/wiki/articles` принимает сессию сайта (cookie) или заголовок
`Authorization: Bearer <access_token>`; обязательные поля — `title`, `slug`,
`content`, необязательное — `category_id`.

```bash
curl -X POST https://edringcolony.ru/api/wiki/articles \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -d '{
    "title": "Полный гайд по колонизации в Elite Dangerous",
    "slug": "polnyy-gayd-po-kolonizacii-v-elite-dangerous",
    "content": "...markdown content...",
    "category_id": "uuid-категории-колонизация"
  }'
```

---

## Способ 3: прямая вставка в БД (для администраторов)

1. Откройте SQL-консоль базы (Supabase Studio или `psql`).
2. Найдите UUID категории `Колонизация`:
   ```sql
   SELECT id FROM public.wiki_categories WHERE slug = 'colonization';
   ```
3. Найдите UUID пользователя-автора:
   ```sql
   SELECT id FROM auth.users WHERE email = 'your-email@example.com';
   ```
4. Замените `:category_id`, `:author_id` и `:last_editor_id` в SQL-скрипте
   `supabase/templates/wiki_colonization_guide.sql.template`. Каталог
   `supabase/migrations/` — только для миграций: там гайд накатывается
   автоматически в `20260903010000_wiki_update_colonization.sql`.
5. Выполните скрипт.
6. Проверьте результат:
   ```sql
   SELECT * FROM public.wiki_articles
   WHERE slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous';
   ```

---

## Проверка после публикации

- [ ] Статья открывается по адресу `/wiki/polnyy-gayd-po-kolonizacii-v-elite-dangerous`
- [ ] Все 5 изображений отображаются корректно
- [ ] Таблицы рендерятся без ошибок
- [ ] Содержание (оглавление) работает
- [ ] Статья отображается в категории `Колонизация`
- [ ] Статья помечена как `is_featured = true`

---

## Обновление статьи

1. Создайте новую ревизию через `/wiki/history/{slug}`
2. или обновите через **Редактировать** (`/wiki/edit/{slug}`).
3. Не забудьте обновить дату и версию в шапке статьи.

---

## Контакты

Если возникли проблемы с публикацией — обратитесь к администратору проекта.
