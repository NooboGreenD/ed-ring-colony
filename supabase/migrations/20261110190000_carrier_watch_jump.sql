-- ══════════════════════════════════════════════════════════════════════════
-- Подписка на прыжок авианосца: снимок плана в личной записи.
--
-- Зачем
-- -----
-- Страница «Авианосцы перед прыжком» (`/carriers/jumps`) показывает носители
-- с заказанным прыжком — цель и время вылета. Пилот может подписаться на
-- носитель, чтобы не пропустить: когда он прыгнет и куда.
--
-- Самой подписки (флага в `atlas_carrier_watch`) мало: важно, **что было
-- обещано** в момент подписки. Заказ прыжка можно перенести, отменить или
-- заменить другой целью, и подписчик должен увидеть именно это — «план
-- изменился», а не просто «носитель куда-то летит».
--
-- Поэтому при подписке пишем снимок плана:
--   * `jump_system_name`  — куда собирался прыгнуть;
--   * `jump_departure_at` — когда;
--   * `jump_seen_at`      — когда снимок сделан.
--
-- Обычное избранное Атласа эти колонки не трогает: маршрут `/api/atlas/
-- carriers/watch` пишет их только когда клиент передал снимок. Внешние данные
-- (EDDN) сюда не пишут вовсе — это личные записи пилота, а не реестр.
--
-- Доступ не меняется: RLS по `auth.uid()`, чужих подписок не видит никто.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.atlas_carrier_watch
  ADD COLUMN IF NOT EXISTS jump_system_name  TEXT,
  ADD COLUMN IF NOT EXISTS jump_departure_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS jump_seen_at      TIMESTAMPTZ;

COMMENT ON COLUMN public.atlas_carrier_watch.jump_system_name IS
  'Куда авианосец собирался прыгнуть в момент подписки (страница /carriers/jumps).';
COMMENT ON COLUMN public.atlas_carrier_watch.jump_departure_at IS
  'Время вылета из снимка подписки: с ним сравнивается живой заказ прыжка.';
COMMENT ON COLUMN public.atlas_carrier_watch.jump_seen_at IS
  'Когда сделан снимок плана прыжка.';

-- Подписок на прыжок немного, но по ним страница собирает «мои подписки».
CREATE INDEX IF NOT EXISTS atlas_carrier_watch_jump
  ON public.atlas_carrier_watch(user_id, jump_departure_at)
  WHERE jump_departure_at IS NOT NULL;
