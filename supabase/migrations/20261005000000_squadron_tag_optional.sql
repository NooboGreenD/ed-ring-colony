-- ─────────────────────────────────────────────────────────────
-- Эскадрильи: тег перестаёт быть обязательным в базе.
--
-- Зачем
-- -----
-- Жалоба «не создаются эскадрильи». Одна из причин — расхождение между
-- интерфейсом и схемой: форма считает тег необязательным (в личном кабинете
-- он отправляется как `undefined`), а колонка объявлена
-- `tag TEXT NOT NULL` ещё в 000_base_schema.sql. Insert падал с
-- «null value in column "tag" violates not-null constraint», и пилот видел
-- общее «Could not create squadron».
--
-- Приложение теперь собирает тег из названия, когда пилот его не ввёл
-- (см. src/lib/squadronForm.ts), но держать в схеме требование, которого нет
-- в интерфейсе, всё равно неправильно: любой другой клиент (мобильное
-- приложение, скрипт) наступит на те же грабли.
--
-- Идемпотентно: DROP NOT NULL можно выполнять повторно.
-- ─────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.squadrons') IS NULL THEN
    RAISE NOTICE 'Таблицы public.squadrons нет — миграция пропущена';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'squadrons'
      AND column_name = 'tag' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.squadrons ALTER COLUMN tag DROP NOT NULL;
    RAISE NOTICE 'squadrons.tag теперь необязателен';
  END IF;
END $$;

COMMENT ON COLUMN public.squadrons.tag IS
  'Тег эскадрильи (2–10 латинских букв/цифр). Необязателен: приложение собирает его из названия, если пилот не ввёл свой';

-- Поиск по тегу — частый путь (страница эскадрилий, проверка занятости).
CREATE INDEX IF NOT EXISTS idx_squadrons_tag_lower
  ON public.squadrons (lower(tag))
  WHERE tag IS NOT NULL;
