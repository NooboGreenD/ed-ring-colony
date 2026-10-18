-- ══════════════════════════════════════════════════════════════════════════
-- PowerPlay: ход импорта и журнал процесса для админки.
--
-- Админка → Игровые данные → PowerPlay показывает загрузку дампа EDSM по
-- этапам (запрос, скачивание, распаковка, разбор, запись в базу, завершение)
-- с прогресс-барами и журналом. Живой прогон виден из памяти веб-процесса,
-- а копия хода и журнала пишется сюда — после перезапуска сайта (обновление,
-- сбой) админ всё равно видит, чем закончилась последняя загрузка: ночная
-- задача планировщика, ленивое обновление из вкладки Atlas или ручной запуск.
--
--   progress — ход последнего прогона: этапы, проценты, итог (JSON из
--              src/lib/powerplayProgress.ts);
--   log      — последние строки журнала (до 200), по прогонам подряд.
--
-- powerplay_admin_summary() — что сейчас лежит в таблице: системы по
-- державам и состояниям, самое старое и свежее наблюдение. Одной выборкой,
-- без перекачки всего слоя в админку.
--
-- Миграция идемпотентна: снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh не ломают уже созданные объекты.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.powerplay_sync_state
  ADD COLUMN IF NOT EXISTS progress JSONB;
ALTER TABLE public.powerplay_sync_state
  ADD COLUMN IF NOT EXISTS log JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.powerplay_sync_state.progress IS
  'Ход последнего импорта PowerPlay: этапы с процентами и итог (src/lib/powerplayProgress.ts).';
COMMENT ON COLUMN public.powerplay_sync_state.log IS
  'Журнал импорта PowerPlay: последние строки [{at, level, text}] для админки.';

CREATE OR REPLACE FUNCTION public.powerplay_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'total', (SELECT count(*) FROM public.powerplay_systems),
    'powers', COALESCE((
      SELECT json_agg(
        json_build_object(
          'power', p.power,
          'Stronghold', p.stronghold,
          'Fortified', p.fortified,
          'Exploited', p.exploited,
          'total', p.total
        )
        ORDER BY p.total DESC, p.power
      )
      FROM (
        SELECT
          s.power,
          count(*) FILTER (WHERE s.power_state = 'Stronghold') AS stronghold,
          count(*) FILTER (WHERE s.power_state = 'Fortified') AS fortified,
          count(*) FILTER (WHERE s.power_state = 'Exploited') AS exploited,
          count(*) AS total
        FROM public.powerplay_systems s
        GROUP BY s.power
      ) p
    ), '[]'::json),
    'oldest_observation', (SELECT min(observed_at) FROM public.powerplay_systems),
    'newest_observation', (SELECT max(observed_at) FROM public.powerplay_systems),
    'last_change', (SELECT max(updated_at) FROM public.powerplay_systems)
  );
$$;

-- Сводку читает только сервер (service_role) — админский маршрут.
REVOKE ALL ON FUNCTION public.powerplay_admin_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_admin_summary() TO service_role;

NOTIFY pgrst, 'reload schema';
