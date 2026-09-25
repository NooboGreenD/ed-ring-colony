-- ─────────────────────────────────────────────────────────────────────────
-- system_plans — серверное хранение и публикация планов застройки («Архитектор»)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Зачем. До этой миграции план архитектора жил только в `localStorage`
-- браузера (`ed-architect:plan:<система>`): показать замысел эскадрилье было
-- нечем, кроме выгрузки JSON вручную, а два командира не могли работать над
-- одной системой. Таблица переносит план на сервер и добавляет три режима
-- видимости:
--
--   * `private`  — видит только автор;
--   * `unlisted` — читается по прямой ссылке `/architect?plan=<id>`, но в
--     общем списке системы не показывается (то, что называют «поделиться
--     ссылкой»);
--   * `public`   — попадает в список планов системы и виден всем.
--
-- Что хранится. Сам план — JSONB той же структуры, что и в браузере
-- (`src/lib/architect/types.ts` → `ArchitectPlan`), плюс версии формата и
-- каталога: импорт обязан честно говорить, что план считался по другому
-- набору стоимостей. Рядом лежат сводные числа (`site_count`, `haul_tons`,
-- `score`, `tier2_points`, `tier3_points`, `cargo_items`) — их считает сервер
-- движком `evaluatePlan()` при каждой записи, поэтому в списке планов не
-- может оказаться «оценка 999», нарисованная клиентом, а список строится без
-- чтения каждого JSONB целиком.
--
-- RLS. Читать разрешено всё, что не `private` (иначе `unlisted` нельзя было
-- бы открыть по ссылке неавтору); в список система-страница берёт только
-- `public` — фильтр по «unlisted» делается в API, а не политикой. Писать,
-- менять видимость и удалять может только автор; админ/модератор удаляет
-- чужое (как в `comments`).

CREATE TABLE IF NOT EXISTS public.system_plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  system_name       TEXT NOT NULL CHECK (LENGTH(TRIM(system_name)) BETWEEN 1 AND 128),
  -- Поиск планов системы идёт без учёта регистра: `HIP 90297` и `hip 90297`
  -- обязаны находить одно и то же.
  system_name_lc    TEXT GENERATED ALWAYS AS (lower(TRIM(system_name))) STORED,
  title             TEXT NOT NULL DEFAULT '',
  author_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name       TEXT NOT NULL DEFAULT '',
  visibility        TEXT NOT NULL DEFAULT 'private'
                    CHECK (visibility IN ('private', 'unlisted', 'public')),
  plan              JSONB NOT NULL,
  format_version    INTEGER NOT NULL DEFAULT 1,
  catalogue_version INTEGER NOT NULL DEFAULT 0,
  site_count        INTEGER NOT NULL DEFAULT 0,
  haul_tons         BIGINT NOT NULL DEFAULT 0,
  score             INTEGER NOT NULL DEFAULT 0,
  tier2_points      INTEGER NOT NULL DEFAULT 0,
  tier3_points      INTEGER NOT NULL DEFAULT 0,
  cargo_items       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT NOT NULL DEFAULT '',
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.system_plans IS
  'Планы застройки систем из «Архитектора» (/architect). plan — JSONB формата ArchitectPlan, сводные числа считает сервер.';

CREATE INDEX IF NOT EXISTS idx_system_plans_system
  ON public.system_plans (system_name_lc, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_plans_author
  ON public.system_plans (author_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_plans_public
  ON public.system_plans (system_name_lc, updated_at DESC)
  WHERE visibility = 'public';

ALTER TABLE public.system_plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_plans_select ON public.system_plans;
CREATE POLICY system_plans_select ON public.system_plans
  FOR SELECT TO anon, authenticated USING (
    visibility <> 'private' OR author_id = auth.uid()
  );

DROP POLICY IF EXISTS system_plans_insert ON public.system_plans;
CREATE POLICY system_plans_insert ON public.system_plans
  FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS system_plans_update ON public.system_plans;
CREATE POLICY system_plans_update ON public.system_plans
  FOR UPDATE TO authenticated USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());

DROP POLICY IF EXISTS system_plans_delete ON public.system_plans;
CREATE POLICY system_plans_delete ON public.system_plans
  FOR DELETE TO authenticated USING (
    author_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role IN ('admin', 'moderator')
    )
  );

GRANT SELECT ON public.system_plans TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.system_plans TO authenticated;

-- `update_updated_at_column()` уже создаёт миграция комментариев; повторяем
-- определение, чтобы файл применялся и сам по себе.
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS system_plans_updated_at ON public.system_plans;
CREATE TRIGGER system_plans_updated_at
  BEFORE UPDATE ON public.system_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
