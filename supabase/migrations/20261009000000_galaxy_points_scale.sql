-- Масштаб облака точек карты: больше точек в файле и выборка на стороне базы.
--
-- Контекст. «Собрать облако точек» читает `galaxy_systems` (~2×10⁸ строк) и
-- кладёт бинарник в бакет `galaxy-data`. Раньше потолок числа точек был жёсткой
-- константой (1 400 000 = сколько влезало в файл под лимит бакета 50 МиБ),
-- а при нехватке места строки просто отбрасывались в конце чтения — то есть
-- облако было не «равномерная выборка галактики», а «первые N систем по id»,
-- и любое изменение порядка строк меняло карту.
--
-- Здесь: (1) лимит бакета поднят до 64 МиБ — этого хватает на 2 307 040 точек,
-- т.е. потолок файла (2 000 000 точек = 58 МиБ) перестаёт упираться в бакет;
-- (2) появляется `galaxy_points_sample` — равномерная выборка строк по id,
-- которую использует путь PostgREST (прямое подключение к Postgres делает то же
-- самое через `mod(id, stride)` в своём запросе, RPC ему не нужен).
--
-- GREATEST в обновлении бакета — чтобы откат миграции не уменьшил лимит и не
-- сломал уже лежащие в бакете файлы.

-- ─── Бакет под облако побольше ───
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'galaxy-data',
    'galaxy-data',
    true,
    67108864,
    ARRAY['application/octet-stream']::text[]
  )
  ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = GREATEST(storage.buckets.file_size_limit, EXCLUDED.file_size_limit);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy-data bucket limit skipped: %', SQLERRM;
END $$;

-- ─── Равномерная выборка систем для облака точек ───
-- Вызывается как `POST /rest/v1/rpc/galaxy_points_sample` со страницы
-- `readPointsFromSupabase` (src/lib/galaxyImport.ts). Ключ пагинации — `id`
-- (PK таблицы), шаг — `mod(id, stride)`: выборка не зависит от того, в каком
-- порядке физически лежат строки, и одинакова при любом числе страниц.
CREATE OR REPLACE FUNCTION public.galaxy_points_sample(
  after_id bigint default 0,
  stride integer default 1,
  lim integer default 5000
)
RETURNS TABLE(
  id bigint,
  id64 text,
  x double precision,
  y double precision,
  z double precision,
  star_type text
)
LANGUAGE sql
STABLE
AS $$
  SELECT g.id, g.id64, g.x, g.y, g.z, g.star_type
  FROM public.galaxy_systems g
  WHERE g.id > COALESCE(after_id, 0)
    AND mod(g.id, GREATEST(COALESCE(stride, 1), 1)) = 0
  ORDER BY g.id
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 5000), 20000));
$$;

-- Чтение каталога и так открыто для всех (RLS-политика `galaxy_systems_public`),
-- функция ничего не добавляет; service_role нужен импорту.
GRANT EXECUTE ON FUNCTION public.galaxy_points_sample(bigint, integer, integer)
  TO anon, authenticated, service_role;
