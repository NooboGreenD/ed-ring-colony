-- ============================================================================
-- 20261118000000_billing_subscription_bonuses.sql
-- Бонусы тарифных подписок: реальный функционал, а не только описание в perks.
--
-- Добавляет колонки в public.billing_plans, по которым код считает бонусы
-- подписки (лимит избранного в Атласе, бонус к лимиту эскадрильи, бонусные
-- кредиты при пополнении, бонусный тонаж при сдаче груза).
--
-- Идемпотентна: ADD COLUMN IF NOT EXISTS — безопасно применять повторно.
-- ============================================================================

ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS atlas_favorites_limit INTEGER,
  ADD COLUMN IF NOT EXISTS squadron_member_limit_bonus INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS topup_credit_bonus_pct INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delivery_tonnage_bonus_pct INTEGER NOT NULL DEFAULT 0;

-- На filled existing plans: проставляем базовые бонусы по совпадению id,
-- если администратор ещё не задавал их вручную. Не перезаписывает существующие
-- значения (оставляем NULL для atlas_favorites_limit = «как было»).
UPDATE public.billing_plans SET
  squadron_member_limit_bonus = CASE id
    WHEN 'pioneer' THEN 25
    WHEN 'elite' THEN 75
    WHEN 'admiral' THEN 200
    ELSE squadron_member_limit_bonus
  END,
  topup_credit_bonus_pct = CASE id
    WHEN 'pioneer' THEN 5
    WHEN 'elite' THEN 10
    WHEN 'admiral' THEN 20
    ELSE topup_credit_bonus_pct
  END,
  delivery_tonnage_bonus_pct = CASE id
    WHEN 'pioneer' THEN 5
    WHEN 'elite' THEN 10
    WHEN 'admiral' THEN 20
    ELSE delivery_tonnage_bonus_pct
  END;

COMMENT ON COLUMN public.billing_plans.atlas_favorites_limit IS
  'Лимит избранных систем в Атласе. NULL — без ограничений (уровень адмирал).';
COMMENT ON COLUMN public.billing_plans.squadron_member_limit_bonus IS
  'Добавка к лимиту участников эскадрильи для создателя/лидера с этой подпиской.';
COMMENT ON COLUMN public.billing_plans.topup_credit_bonus_pct IS
  'Бонусный процент кредитов при пополнении баланса (0..100).';
COMMENT ON COLUMN public.billing_plans.delivery_tonnage_bonus_pct IS
  'Бонусный процент тонажа при сдаче груза (доставки) (0..100).';
