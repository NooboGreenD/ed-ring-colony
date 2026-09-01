-- ED Ring Colony Wiki — Database Schema Migration
-- ============================================================

-- 1. Categories
CREATE TABLE IF NOT EXISTS public.wiki_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order  INT DEFAULT 0,
  parent_id   UUID REFERENCES public.wiki_categories(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_categories_slug ON public.wiki_categories(slug);
CREATE INDEX IF NOT EXISTS idx_wiki_categories_parent ON public.wiki_categories(parent_id);

-- 2. Articles
CREATE TABLE IF NOT EXISTS public.wiki_articles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  content        TEXT NOT NULL DEFAULT '',
  category_id    UUID REFERENCES public.wiki_categories(id) ON DELETE SET NULL,
  author_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_editor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  is_featured    BOOLEAN DEFAULT FALSE,
  view_count     INT DEFAULT 0,
  version        INT DEFAULT 1,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_articles_slug ON public.wiki_articles(slug);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_category ON public.wiki_articles(category_id);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_status ON public.wiki_articles(status);
CREATE INDEX IF NOT EXISTS idx_wiki_articles_featured ON public.wiki_articles(is_featured) WHERE is_featured = TRUE;

-- 3. Revisions
CREATE TABLE IF NOT EXISTS public.wiki_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id      UUID NOT NULL REFERENCES public.wiki_articles(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  editor_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  change_summary  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_revisions_article ON public.wiki_revisions(article_id);
CREATE INDEX IF NOT EXISTS idx_wiki_revisions_number ON public.wiki_revisions(article_id, revision_number DESC);

-- 4. Tags
CREATE TABLE IF NOT EXISTS public.wiki_tags (
  id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_wiki_tags_slug ON public.wiki_tags(slug);

-- 5. Article Tags (many-to-many)
CREATE TABLE IF NOT EXISTS public.wiki_article_tags (
  article_id UUID NOT NULL REFERENCES public.wiki_articles(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES public.wiki_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_article_tags_tag ON public.wiki_article_tags(tag_id);

-- 6. Redirects
CREATE TABLE IF NOT EXISTS public.wiki_redirects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_slug  TEXT NOT NULL UNIQUE,
  to_slug    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_redirects_from ON public.wiki_redirects(from_slug);

-- 7. Favorites
CREATE TABLE IF NOT EXISTS public.wiki_favorites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  article_id UUID NOT NULL REFERENCES public.wiki_articles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, article_id)
);

CREATE INDEX IF NOT EXISTS idx_wiki_favorites_user ON public.wiki_favorites(user_id);

-- ============================================================
-- RLS Policies
-- ============================================================

ALTER TABLE public.wiki_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_article_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_redirects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wiki_favorites ENABLE ROW LEVEL SECURITY;

-- wiki_categories: public read, admin write
DROP POLICY IF EXISTS wiki_categories_select ON public.wiki_categories;
CREATE POLICY wiki_categories_select ON public.wiki_categories
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_categories_insert ON public.wiki_categories;
CREATE POLICY wiki_categories_insert ON public.wiki_categories
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_categories_update ON public.wiki_categories;
CREATE POLICY wiki_categories_update ON public.wiki_categories
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_categories_delete ON public.wiki_categories;
CREATE POLICY wiki_categories_delete ON public.wiki_categories
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

-- wiki_articles: public read published, auth create/edit own or admin any
DROP POLICY IF EXISTS wiki_articles_select ON public.wiki_articles;
CREATE POLICY wiki_articles_select ON public.wiki_articles
  FOR SELECT TO anon, authenticated USING (
    status = 'published' OR auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_articles_insert ON public.wiki_articles;
CREATE POLICY wiki_articles_insert ON public.wiki_articles
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = author_id);

DROP POLICY IF EXISTS wiki_articles_update ON public.wiki_articles;
CREATE POLICY wiki_articles_update ON public.wiki_articles
  FOR UPDATE TO authenticated USING (
    auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_articles_delete ON public.wiki_articles;
CREATE POLICY wiki_articles_delete ON public.wiki_articles
  FOR DELETE TO authenticated USING (
    auth.uid() = author_id OR
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

-- wiki_revisions: public read, insert by editor only
DROP POLICY IF EXISTS wiki_revisions_select ON public.wiki_revisions;
CREATE POLICY wiki_revisions_select ON public.wiki_revisions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_revisions_insert ON public.wiki_revisions;
CREATE POLICY wiki_revisions_insert ON public.wiki_revisions
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = editor_id);

-- wiki_tags: public read, auth create
DROP POLICY IF EXISTS wiki_tags_select ON public.wiki_tags;
CREATE POLICY wiki_tags_select ON public.wiki_tags
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_tags_insert ON public.wiki_tags;
CREATE POLICY wiki_tags_insert ON public.wiki_tags
  FOR INSERT TO authenticated WITH CHECK (true);

-- wiki_article_tags: public read, auth manage
DROP POLICY IF EXISTS wiki_article_tags_select ON public.wiki_article_tags;
CREATE POLICY wiki_article_tags_select ON public.wiki_article_tags
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_article_tags_insert ON public.wiki_article_tags;
CREATE POLICY wiki_article_tags_insert ON public.wiki_article_tags
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS wiki_article_tags_delete ON public.wiki_article_tags;
CREATE POLICY wiki_article_tags_delete ON public.wiki_article_tags
  FOR DELETE TO authenticated USING (true);

-- wiki_redirects: public read, admin write
DROP POLICY IF EXISTS wiki_redirects_select ON public.wiki_redirects;
CREATE POLICY wiki_redirects_select ON public.wiki_redirects
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS wiki_redirects_insert ON public.wiki_redirects;
CREATE POLICY wiki_redirects_insert ON public.wiki_redirects
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_redirects_update ON public.wiki_redirects;
CREATE POLICY wiki_redirects_update ON public.wiki_redirects
  FOR UPDATE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

DROP POLICY IF EXISTS wiki_redirects_delete ON public.wiki_redirects;
CREATE POLICY wiki_redirects_delete ON public.wiki_redirects
  FOR DELETE TO authenticated USING (
    EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','moderator'))
  );

-- wiki_favorites: self only
DROP POLICY IF EXISTS wiki_favorites_select ON public.wiki_favorites;
CREATE POLICY wiki_favorites_select ON public.wiki_favorites
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS wiki_favorites_insert ON public.wiki_favorites;
CREATE POLICY wiki_favorites_insert ON public.wiki_favorites
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS wiki_favorites_delete ON public.wiki_favorites;
CREATE POLICY wiki_favorites_delete ON public.wiki_favorites
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ============================================================
-- Grants
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_categories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_articles TO anon, authenticated;
GRANT SELECT, INSERT ON public.wiki_revisions TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.wiki_tags TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.wiki_article_tags TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wiki_redirects TO anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.wiki_favorites TO anon, authenticated;

-- ============================================================
-- Updated at trigger for wiki_articles
-- ============================================================
DROP TRIGGER IF EXISTS wiki_articles_updated_at ON public.wiki_articles;
CREATE TRIGGER wiki_articles_updated_at
  BEFORE UPDATE ON public.wiki_articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Seed categories
-- ============================================================
INSERT INTO public.wiki_categories (name, slug, description, sort_order) VALUES
  ('Корабли', 'ships', 'Все корабли Elite Dangerous', 1),
  ('Инженеры', 'engineers', 'Инженеры и их модификации', 2),
  ('Материалы', 'materials', 'Редкие и обычные материалы', 3),
  ('Гайды', 'guides', 'Руководства и советы', 4),
  ('Лор', 'lore', 'История и лор вселенной', 5),
  ('Механики', 'mechanics', 'Игровые механики', 6),
  ('Колонизация', 'colonization', 'Всё о колонизации систем', 7),
  ('Проект Кольцо', 'ring-project', 'The Galaxy Ring Project', 8)
ON CONFLICT (slug) DO NOTHING;
