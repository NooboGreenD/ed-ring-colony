-- ============================================================================
-- 20260922000000_billing_real_data_payments.sql
-- ED Ring Colony — Billing v2: real data storage, product settings,
-- payment providers & payment intents (webhook-driven fulfilment)
-- ============================================================================

-- 1. Extra columns for product configuration
ALTER TABLE public.shop_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;

ALTER TABLE public.billing_plans
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS discount_pct INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS provider_id TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE public.billing_transactions
  ADD COLUMN IF NOT EXISTS provider_id TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE public.user_balances
  ALTER COLUMN credits SET DEFAULT 0;

-- 2. Payment providers (admin-configured integrations)
CREATE TABLE IF NOT EXISTS public.payment_providers (
  id            TEXT PRIMARY KEY,                -- 'yookassa', 'stripe', 'robokassa', 'cryptobot', 'manual'
  name          TEXT NOT NULL,
  is_enabled    BOOLEAN NOT NULL DEFAULT false,
  test_mode     BOOLEAN NOT NULL DEFAULT true,
  config        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- server-only secrets & settings
  methods       TEXT[] NOT NULL DEFAULT '{}',        -- supported payment methods ('card','sbp','crypto')
  display_order INTEGER NOT NULL DEFAULT 0,
  last_check_at TIMESTAMPTZ,
  last_check_ok BOOLEAN,
  last_check_msg TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 3. Payment intents — one per checkout; fulfilled via webhook/return
CREATE TABLE IF NOT EXISTS public.payment_intents (
  id              TEXT PRIMARY KEY,
  user_id         UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  cmdr_name       TEXT,
  provider_id     TEXT REFERENCES public.payment_providers(id) ON DELETE SET NULL,
  external_id     TEXT,                         -- id in the payment system
  purpose         TEXT NOT NULL,                -- 'credit_topup' | 'subscription' | 'shop_purchase'
  target_id       TEXT,                         -- plan_id / item_id / topup pack id
  amount_rub      NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount_credits  INTEGER NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'RUB',
  status          TEXT NOT NULL DEFAULT 'pending', -- 'pending','paid','failed','canceled','expired'
  payment_url     TEXT,
  transaction_id  TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  paid_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON public.payment_intents(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_external ON public.payment_intents(provider_id, external_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status ON public.payment_intents(status);

-- 4. Webhook event log (idempotency & audit)
CREATE TABLE IF NOT EXISTS public.payment_webhook_events (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT,
  event_type    TEXT,
  external_id   TEXT,
  payload       JSONB,
  processed     BOOLEAN DEFAULT false,
  error         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 4b. Key/value settings (welcome credits, credit packs, etc.)
CREATE TABLE IF NOT EXISTS public.billing_settings (
  id          TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.billing_settings ENABLE ROW LEVEL SECURITY;

-- 5. RLS
ALTER TABLE public.payment_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_webhook_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payment_intents_read_own" ON public.payment_intents;
CREATE POLICY "payment_intents_read_own" ON public.payment_intents FOR SELECT USING (auth.uid() = user_id);
-- providers / webhook events: service role only (no policies => no anon access)

-- 6. Seed default providers (disabled until configured by admin)
INSERT INTO public.payment_providers (id, name, is_enabled, test_mode, methods, display_order) VALUES
  ('yookassa',  'ЮKassa (YooMoney)',      false, true, ARRAY['card','sbp'],   1),
  ('robokassa', 'Robokassa',              false, true, ARRAY['card','sbp'],   2),
  ('stripe',    'Stripe',                 false, true, ARRAY['card'],         3),
  ('cryptobot', 'Crypto Pay (CryptoBot)', false, true, ARRAY['crypto'],       4),
  ('manual',    'Ручное подтверждение',   false, false, ARRAY['manual'],      9)
ON CONFLICT (id) DO NOTHING;

-- 7. Seed default plans
INSERT INTO public.billing_plans (id, name, name_en, description, description_en, price_rub, price_credits, period_days, perks, badge_label, color, is_active, is_popular, display_order, discount_pct) VALUES
  ('pioneer', 'Пионер Кольца', 'Ring Pioneer',
   'Базовый премиальный статус для исследователей и строителей колонии.',
   'Standard premium tier for Ring explorers and builders.',
   290, 2500, 30,
   '["Особый позывной и тактический префикс [PIO]","Приоритетная синхронизация логов CAPI и журнала","Скидка 25% на косметические улучшения в магазине","Эксклюзивный знак отличия Пионера в профиле","Доступ к расширенной телеметрии экспедиции"]'::jsonb,
   'PIONEER', '#3498db', true, false, 1, 25),
  ('elite', 'Элита Колонии', 'Colonia Elite',
   'Расширенный статус с кастомными темами интерфейса и голографическими рамками.',
   'Advanced tier with custom HUD interface themes and holographic avatar frames.',
   590, 5000, 30,
   '["Все привилегии уровня «Пионер Кольца»","Голографическая неоновая рамка аватара на выбор","Кастомные HUD-темы оформления интерфейса сайта","Скидка 50% на все товары Премиум-магазина","Приоритет в голосовых каналах эскадрилий","Нагрудный знак ветерана Элиты Колонии","Увеличенный лимит избранных систем в Атласе до 100"]'::jsonb,
   'ELITE', '#e67e22', true, true, 2, 50),
  ('admiral', 'Флотоводец VIP', 'Fleet Admiral VIP',
   'Высший ранг покровителя проекта с полным доступом ко всем украшениям и VIP-каналам.',
   'Highest benefactor tier with full access to all cosmetics and VIP priority.',
   1190, 10000, 30,
   '["Полный безлимитный доступ ко всем модулям платформы","Анимированные эффекты хроматического свечения ника","Все легендарные голографические рамки аватаров","Скидка 75% в магазине косметики + доступ к VIP-эксклюзивам","VIP-статус в технической поддержке с ускоренным ответом","Именная золотая запись в реестре Основателей Кольца","Личный золотой штандарт Флотоводца с орлиными крыльями","Возможность закреплять сообщения в общем чате"]'::jsonb,
   'VIP ADMIRAL', '#9b59b6', true, false, 3, 75)
ON CONFLICT (id) DO NOTHING;

-- 8. Seed default shop catalogue (the app also seeds these on first run)
INSERT INTO public.shop_items (id, category, title, title_en, description, description_en, price_credits, price_rub, rarity, requires_subscription, subscriber_discount_pct, preview_data, is_active, is_featured, display_order) VALUES
  ('frame-singularity','frame','Квантовая Сингулярность','Quantum Singularity','Вращающееся гравитационное кольцо аккреционного диска с фиолетовым свечением искривленного пространства.','Rotating gravitational accretion disk with violet curved space glow.',3500,450,'legendary',NULL,35,'{"color":"#a855f7","accentColor":"#3b82f6","glowColor":"rgba(168, 85, 247, 0.65)","frameStyle":"singularity","borderWidth":3}'::jsonb,true,true,1),
  ('frame-vanguard','frame','Авангард Колонии','Colonia Vanguard','Тактическая бронированная рамка с угловыми оптическими визирами и янтарной телеметрией.','Tactical armored frame with corner optical brackets and amber telemetry.',2200,290,'epic',NULL,25,'{"color":"#e67e22","accentColor":"#f39c12","glowColor":"rgba(230, 126, 34, 0.55)","frameStyle":"vanguard","borderWidth":2}'::jsonb,true,false,2),
  ('frame-subzero','frame','Ледяной Импульс','Sub-Zero Pulse','Криогенный гексагональный силовой щит с бегущей волной неонового циана.','Cryogenic hexagonal power shield with running neon cyan wave.',1500,190,'rare',NULL,20,'{"color":"#06b6d4","accentColor":"#38bdf8","glowColor":"rgba(6, 182, 212, 0.6)","frameStyle":"subzero","borderWidth":2}'::jsonb,true,false,3),
  ('frame-solar','frame','Вспышка Сверхновой','Solar Flare','Плазменная корона звезды O-класса с пульсирующими выбросами солнечного протуберанца.','O-class star plasma corona with pulsing solar prominences.',2400,320,'epic','elite',50,'{"color":"#f97316","accentColor":"#eab308","glowColor":"rgba(249, 115, 22, 0.7)","frameStyle":"solar","borderWidth":3}'::jsonb,true,true,4),
  ('frame-stealth','frame','Призрак Пустоты','Void Phantom','Матовая стелс-рамка с красными лазерными прицельными маркерами.','Matte stealth frame with red laser targeting markers.',1200,150,'rare',NULL,20,'{"color":"#ef4444","accentColor":"#991b1b","glowColor":"rgba(239, 68, 68, 0.5)","frameStyle":"stealth","borderWidth":2}'::jsonb,true,false,5),
  ('badge-founder','badge','Орден Основателя Кольца','Ring Founder Order','Золотой знак с орлиными крыльями для первых покровителей проекта.','Golden badge with eagle wings for the first project benefactors.',2800,350,'legendary','admiral',75,'{"color":"#fbbf24","icon":"crown"}'::jsonb,true,true,10),
  ('badge-explorer','badge','Звездный Первопроходец','Star Trailblazer','Компас исследователя дальнего космоса в неоново-голубом обрамлении.','Deep-space explorer compass in neon-blue trim.',900,120,'rare',NULL,20,'{"color":"#38bdf8","icon":"star"}'::jsonb,true,false,11),
  ('badge-titan','badge','Покоритель Титанов','Titan Breaker','Изумрудный клинок — знак участника операций против Таргоидских Титанов.','Emerald blade — mark of anti-Thargoid Titan operations.',1600,210,'epic',NULL,25,'{"color":"#10b981","icon":"sword"}'::jsonb,true,false,12),
  ('badge-carrier','badge','Владелец Флагмана','Fleet Carrier Owner','Синий якорь для командиров, владеющих собственным флотоносцем.','Blue anchor for commanders who own a Fleet Carrier.',1400,180,'epic',NULL,25,'{"color":"#60a5fa","icon":"anchor"}'::jsonb,true,false,13),
  ('badge-mining','badge','Мастер Глубинного Бурения','Deep Core Mining Master','Салатовый кристалл — знак опытного добытчика.','Lime crystal — mark of an experienced miner.',600,80,'common',NULL,15,'{"color":"#a3e635","icon":"diamond"}'::jsonb,true,false,14),
  ('skin-amber','skin','Янтарь Колонии','Colonia Amber','Классическая тёплая HUD-тема с янтарными акцентами Elite Dangerous.','Classic warm HUD theme with Elite Dangerous amber accents.',1800,240,'rare',NULL,25,'{"color":"#f59e0b","accentColor":"#fbbf24","hudSkinClass":"skin-colonia-amber"}'::jsonb,true,false,20),
  ('skin-cyber','skin','Киберпанк 3309','Cyberpunk 3309','Высококонтрастная футуристичная тема с кибер-цианом и пульсирующей неоновой маджентой.','High-contrast futuristic HUD skin with cyber cyan and pulsing neon magenta.',2600,340,'epic','elite',50,'{"color":"#ec4899","accentColor":"#06b6d4","hudSkinClass":"skin-cyberpunk-3309"}'::jsonb,true,true,21),
  ('skin-void','skin','Навигатор Пустоты','Void Navigator','Глубокая сине-фиолетовая тема дальних экспедиций.','Deep blue-violet theme for long-range expeditions.',2000,260,'rare',NULL,25,'{"color":"#3b82f6","accentColor":"#8b5cf6","hudSkinClass":"skin-void-navigator"}'::jsonb,true,false,22),
  ('skin-imperial','skin','Имперское Золото','Imperial Gold','Роскошная тема в цветах Империи Ахенара.','Luxurious theme in the colours of the Achenar Empire.',3200,420,'legendary','admiral',75,'{"color":"#eab308","accentColor":"#f5f5f4","hudSkinClass":"skin-imperial-gold"}'::jsonb,true,false,23),
  ('skin-emerald','skin','Изумрудный Аванпост','Emerald Outpost','Спокойная зелёная тема терраформированных миров.','Calm green theme of terraformed worlds.',1500,200,'common',NULL,15,'{"color":"#10b981","accentColor":"#34d399","hudSkinClass":"skin-emerald-outpost"}'::jsonb,true,false,24),
  ('glow-hyperspace','glow','Гиперпространственный След','Hyperspace Trail','Анимированный хроматический градиент позывного.','Animated chromatic gradient callsign.',2900,380,'legendary','admiral',75,'{"color":"#8b5cf6","gradient":"linear-gradient(90deg, #ec4899, #8b5cf6, #06b6d4, #ec4899)"}'::jsonb,true,true,30),
  ('glow-neutron','glow','Нейтронное Сияние','Neutron Glow','Холодное бело-голубое свечение нейтронной звезды.','Cold white-blue neutron star glow.',1700,220,'epic',NULL,25,'{"color":"#38bdf8","gradient":"linear-gradient(90deg, #38bdf8, #e0f2fe, #38bdf8)"}'::jsonb,true,false,31),
  ('glow-solar','glow','Солнечная Корона','Solar Corona','Тёплое золотое свечение звезды класса G.','Warm golden G-class star glow.',1100,150,'rare',NULL,20,'{"color":"#f59e0b","gradient":"linear-gradient(90deg, #f59e0b, #fef08a, #f59e0b)"}'::jsonb,true,false,32),
  ('glow-voidpulse','glow','Пульс Пустоты','Void Pulse','Глубокое фиолетовое пульсирующее свечение.','Deep violet pulsing glow.',1300,170,'rare',NULL,20,'{"color":"#9333ea","gradient":"linear-gradient(90deg, #9333ea, #e9d5ff, #9333ea)"}'::jsonb,true,false,33),
  ('title-architect','title','Архитектор Нового Рубежа','Architect of the New Frontier','Почётный титул строителя колоний.','Honorary colony builder title.',1800,230,'epic',NULL,25,'{"color":"#f97316","subTitle":"ARCHITECT OF THE NEW FRONTIER"}'::jsonb,true,false,40),
  ('title-trailblazer','title','Первопроходец Бездны','Void Trailblazer','Титул исследователя неизведанных секторов.','Explorer of uncharted sectors title.',1400,180,'rare',NULL,20,'{"color":"#a855f7","subTitle":"VOID TRAILBLAZER"}'::jsonb,true,false,41),
  ('title-jaques','title','Легенда Жак-Стейшн','Jaques Station Legend','Титул в честь легендарной станции Колонии.','Title honouring the legendary Colonia station.',2200,290,'legendary','elite',50,'{"color":"#38bdf8","subTitle":"JAQUES STATION LEGEND"}'::jsonb,true,true,42),
  ('title-marshal','title','Маршал Звездного Пути','Starway Marshal','Титул координатора маршрутов экспедиции.','Expedition route coordinator title.',1600,210,'epic',NULL,25,'{"color":"#eab308","subTitle":"STARWAY MARSHAL"}'::jsonb,true,false,43)
ON CONFLICT (id) DO NOTHING;

-- 9. Public read model for cosmetics (joined preview data for rendering across the site)
CREATE OR REPLACE VIEW public.user_cosmetics_public AS
SELECT
  e.user_id,
  p.cmdr_name,
  e.frame_id, e.badge_id, e.skin_id, e.glow_id, e.title_id,
  s.plan_id AS subscription_plan_id,
  bp.badge_label AS subscription_badge
FROM public.user_cosmetics_equipped e
LEFT JOIN public.profiles p ON p.id = e.user_id
LEFT JOIN LATERAL (
  SELECT plan_id FROM public.user_subscriptions us
  WHERE us.user_id = e.user_id AND us.status = 'active'
    AND (us.expires_at IS NULL OR us.expires_at > now())
  ORDER BY us.expires_at DESC NULLS LAST LIMIT 1
) s ON true
LEFT JOIN public.billing_plans bp ON bp.id = s.plan_id;

GRANT SELECT ON public.user_cosmetics_public TO anon, authenticated;

-- End of migration
