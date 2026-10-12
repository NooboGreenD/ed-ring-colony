-- Ближайшие системы кэша Atlas в кубе — для поиска галактического кольца.
--
-- Зачем: поиск кольца читал кэш систем через листание коробки по 1000 строк
-- (до 40 последовательных запросов на каждый сегмент). При большом радиусе
-- поиска шаг не укладывался в таймаут шлюза и отвечал 504. Здесь ближайшие
-- системы выбираются одним запросом по GiST-индексу, по возрастанию расстояния.

CREATE EXTENSION IF NOT EXISTS cube;

CREATE INDEX IF NOT EXISTS idx_atlas_system_cache_cube
  ON public.atlas_system_cache USING gist (cube(ARRAY[x, y, z]));

CREATE OR REPLACE FUNCTION public.atlas_system_cache_near(
  cx double precision,
  cy double precision,
  cz double precision,
  half double precision,
  lim integer
)
RETURNS TABLE(system_name text, x double precision, y double precision, z double precision, id64 text, source text)
LANGUAGE sql
STABLE
AS $$
  SELECT c.system_name, c.x, c.y, c.z, c.id64, c.source
  FROM public.atlas_system_cache c
  WHERE cube(ARRAY[c.x, c.y, c.z]) && cube(
          ARRAY[cx - half, cy - half, cz - half],
          ARRAY[cx + half, cy + half, cz + half]
        )
  ORDER BY cube(ARRAY[c.x, c.y, c.z]) <-> cube(ARRAY[cx, cy, cz])
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 800), 2000));
$$;

GRANT EXECUTE ON FUNCTION public.atlas_system_cache_near(
  double precision, double precision, double precision, double precision, integer
) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
