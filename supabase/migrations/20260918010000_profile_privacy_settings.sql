-- ═══════════════════════════════════════════════════════════════
-- Конфиденциальность досье пилота
-- ═══════════════════════════════════════════════════════════════
--
-- Досье командира публично: его читает любой посетитель страницы
-- `/cmdr/[name]`. Раньше публичными были и чувствительные числа — баланс
-- кредитов, ARX, ранги, текущее положение корабля и история поставок. Теперь
-- командир сам решает, что показывать.
--
-- Настройки хранятся одним JSONB-столбцом: добавление нового переключателя не
-- должно требовать миграции. Отсутствующий ключ трактуется как «показывать»
-- (см. `src/lib/privacy.ts`), поэтому существующие профили ничего не теряют.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS privacy_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.profiles.privacy_settings IS
  'Публичность блоков досье: balance, ranks, cargo, deliveries, location. Отсутствующий ключ = показывать';

-- ─── Доступ к чувствительным таблицам ───────────────────────────────────────
--
-- `pilot_stats` читалась кем угодно (`USING (true)` в миграции
-- 20260916000000): настройки приватности можно было обойти прямым запросом к
-- базе, минуя досье. Теперь таблицу видит только владелец, а публичное досье
-- собирает сервер через service-role клиент и сам решает, какие поля отдать
-- (`src/lib/privacy.ts::publicPilotView`).

DROP POLICY IF EXISTS pilot_stats_select ON public.pilot_stats;
CREATE POLICY pilot_stats_select ON public.pilot_stats
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS pilot_stats_upsert ON public.pilot_stats;
CREATE POLICY pilot_stats_upsert ON public.pilot_stats
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- `capi_profiles` видна владельцу и одноэскадрильцам: это нужно живой карте
-- эскадрильи. Но если командир выключил публичность положения или статистики,
-- чужие глаза не должны видеть соответствующие колонки — их отсекает сервер,
-- а здесь остаётся правило «свой или свой по эскадрилье».
DROP POLICY IF EXISTS capi_profiles_select_own ON public.capi_profiles;
CREATE POLICY capi_profiles_select_own ON public.capi_profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS capi_profiles_select_squadron ON public.capi_profiles;
CREATE POLICY capi_profiles_select_squadron ON public.capi_profiles
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1
      FROM public.squadron_members sm
      WHERE sm.user_id = capi_profiles.user_id
        AND EXISTS (
          SELECT 1 FROM public.squadron_members sm2
          WHERE sm2.user_id = auth.uid()
            AND sm2.squadron_id = sm.squadron_id
        )
    )
    AND COALESCE(
      (SELECT (p.privacy_settings ->> 'location')::boolean
         FROM public.profiles p
        WHERE p.id = capi_profiles.user_id),
      true
    )
  );
