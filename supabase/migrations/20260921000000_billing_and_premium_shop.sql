-- ============================================================================
-- 20260921000000_billing_and_premium_shop.sql
-- ED Ring Colony — Billing, Subscription Management, Analytics & Premium Shop
-- ============================================================================

-- 1. Тарифные планы подписок
CREATE TABLE IF NOT EXISTS public.billing_plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_en         TEXT,
  description     TEXT,
  description_en  TEXT,
  price_rub       INTEGER NOT NULL DEFAULT 0,
  price_credits   INTEGER NOT NULL DEFAULT 0,
  period_days     INTEGER NOT NULL DEFAULT 30,
  perks           JSONB NOT NULL DEFAULT '[]'::jsonb,
  badge_label     TEXT,
  color           TEXT DEFAULT '#e67e22',
  is_active       BOOLEAN DEFAULT true,
  is_popular      BOOLEAN DEFAULT false,
  display_order   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- 2. Подписки пользователей
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  cmdr_name       TEXT,
  plan_id         TEXT REFERENCES public.billing_plans(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'active', -- 'active', 'trial', 'canceled', 'expired'
  started_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  auto_renew      BOOLEAN DEFAULT true,
  payment_method  TEXT DEFAULT 'card',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON public.user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.user_subscriptions(status);

-- 3. Предметы премиум-магазина (украшения UI)
CREATE TABLE IF NOT EXISTS public.shop_items (
  id                      TEXT PRIMARY KEY,
  category                TEXT NOT NULL, -- 'frame', 'badge', 'skin', 'glow', 'title'
  title                   TEXT NOT NULL,
  title_en                TEXT,
  description             TEXT,
  description_en          TEXT,
  price_credits           INTEGER NOT NULL DEFAULT 0,
  price_rub               INTEGER NOT NULL DEFAULT 0,
  rarity                  TEXT NOT NULL DEFAULT 'common', -- 'common', 'rare', 'epic', 'legendary'
  requires_subscription   TEXT, -- null or plan_id (e.g. 'elite', 'admiral')
  subscriber_discount_pct INTEGER DEFAULT 0,
  preview_data            JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active               BOOLEAN DEFAULT true,
  is_featured             BOOLEAN DEFAULT false,
  sales_count             INTEGER DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_items_category ON public.shop_items(category);
CREATE INDEX IF NOT EXISTS idx_shop_items_active ON public.shop_items(is_active);

-- 4. Инвентарь покупок пользователя
CREATE TABLE IF NOT EXISTS public.user_inventory (
  id                  TEXT PRIMARY KEY,
  user_id             UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_id             TEXT REFERENCES public.shop_items(id) ON DELETE CASCADE,
  purchased_at        TIMESTAMPTZ DEFAULT now(),
  price_paid_credits  INTEGER DEFAULT 0,
  price_paid_rub      NUMERIC(10,2) DEFAULT 0,
  transaction_id      TEXT,
  is_equipped         BOOLEAN DEFAULT false,
  UNIQUE(user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_inventory_user_id ON public.user_inventory(user_id);

-- 5. Экипированные украшения интерфейса
CREATE TABLE IF NOT EXISTS public.user_cosmetics_equipped (
  user_id         UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  frame_id        TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  badge_id        TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  skin_id         TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  glow_id         TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  title_id        TEXT REFERENCES public.shop_items(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- 6. Финансовые и внутриигровые транзакции
CREATE TABLE IF NOT EXISTS public.billing_transactions (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  cmdr_name       TEXT,
  type            TEXT NOT NULL, -- 'subscription', 'shop_purchase', 'credit_topup', 'refund', 'admin_grant'
  item_or_plan_id TEXT,
  item_title      TEXT,
  amount_rub      NUMERIC(10,2) DEFAULT 0,
  amount_credits  INTEGER DEFAULT 0,
  payment_method  TEXT DEFAULT 'card', -- 'card', 'sbp', 'credits', 'admin', 'crypto'
  status          TEXT NOT NULL DEFAULT 'completed', -- 'completed', 'pending', 'refunded', 'failed'
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_tx_user_id ON public.billing_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_billing_tx_type ON public.billing_transactions(type);
CREATE INDEX IF NOT EXISTS idx_billing_tx_created ON public.billing_transactions(created_at DESC);

-- 7. Баланс очков/кредитов пользователя
CREATE TABLE IF NOT EXISTS public.user_balances (
  user_id               UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  credits               INTEGER NOT NULL DEFAULT 1500,
  total_spent_rub       NUMERIC(10,2) DEFAULT 0,
  total_spent_credits   INTEGER DEFAULT 0,
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- RLS Policies
ALTER TABLE public.billing_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_cosmetics_equipped ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_balances ENABLE ROW LEVEL SECURITY;

-- Plans & shop items can be read by everyone
CREATE POLICY "billing_plans_read" ON public.billing_plans FOR SELECT USING (true);
CREATE POLICY "shop_items_read" ON public.shop_items FOR SELECT USING (true);

-- Subscriptions: users can read their own, admins can read/write all
CREATE POLICY "user_subscriptions_read_own" ON public.user_subscriptions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_inventory_read_own" ON public.user_inventory FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "user_cosmetics_read_public" ON public.user_cosmetics_equipped FOR SELECT USING (true);
CREATE POLICY "user_balances_read_own" ON public.user_balances FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "billing_transactions_read_own" ON public.billing_transactions FOR SELECT USING (auth.uid() = user_id);

-- End of migration
