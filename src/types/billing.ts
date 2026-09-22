export type SubscriptionStatus = 'active' | 'trial' | 'canceled' | 'expired';

export type CosmeticCategory = 'frame' | 'badge' | 'skin' | 'glow' | 'title';

export type ItemRarity = 'common' | 'rare' | 'epic' | 'legendary';

export type TransactionType = 'subscription' | 'shop_purchase' | 'credit_topup' | 'refund' | 'admin_grant';

export type PaymentMethod = 'card' | 'sbp' | 'credits' | 'admin' | 'crypto';

export type TransactionStatus = 'completed' | 'pending' | 'refunded' | 'failed';

export interface BillingPlan {
  id: string;
  name: string;
  name_en?: string;
  description: string;
  description_en?: string;
  price_rub: number;
  price_credits: number;
  period_days: number;
  perks: string[];
  badge_label: string;
  color: string;
  is_active: boolean;
  is_popular?: boolean;
  display_order: number;
  discount_pct?: number;
  created_at: string;
  updated_at?: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  cmdr_name: string;
  plan_id: string;
  status: SubscriptionStatus;
  started_at: string;
  expires_at: string | null;
  auto_renew: boolean;
  payment_method: string;
  notes?: string;
  provider_id?: string | null;
  external_id?: string | null;
  created_at: string;
  updated_at: string;
  plan?: BillingPlan;
}

export interface ShopItemPreviewData {
  color?: string;
  accentColor?: string;
  glowColor?: string;
  icon?: string;
  frameStyle?: string;
  gradient?: string;
  hudSkinClass?: string;
  borderWidth?: number;
  badgeSvg?: string;
  subTitle?: string;
  cssEffects?: Record<string, string>;
  /** Full-site colour scheme (skin category): CSS variable overrides applied to <html>. */
  theme?: {
    bg?: string;
    panel?: string;
    panelHover?: string;
    line?: string;
    text?: string;
    muted?: string;
    orange?: string;
    orangeHover?: string;
    cyan?: string;
    green?: string;
    red?: string;
    /** optional page background (gradient/image) */
    background?: string;
    /** subtle visual effect: 'scanlines' | 'grid' | 'stars' | 'vignette' */
    effect?: string;
    /** font stack override for the whole site */
    font?: string;
  };
  emoji?: string;
}

export interface ShopItem {
  id: string;
  category: CosmeticCategory;
  title: string;
  title_en?: string;
  description: string;
  description_en?: string;
  price_credits: number;
  price_rub: number;
  rarity: ItemRarity;
  requires_subscription?: string | null;
  subscriber_discount_pct: number;
  preview_data: ShopItemPreviewData;
  is_active: boolean;
  is_featured: boolean;
  sales_count: number;
  display_order?: number;
  created_at: string;
  updated_at?: string;
  // computed for the current viewer (API only)
  applied_discount_pct?: number;
  final_price_credits?: number;
  final_price_rub?: number;
  is_locked_for_user?: boolean;
}

export interface UserInventoryItem {
  id: string;
  user_id: string;
  item_id: string;
  purchased_at: string;
  price_paid_credits: number;
  price_paid_rub: number;
  transaction_id?: string;
  is_equipped?: boolean;
  item?: ShopItem;
}

export interface EquippedCosmetics {
  user_id: string;
  frame_id?: string | null;
  badge_id?: string | null;
  skin_id?: string | null;
  glow_id?: string | null;
  title_id?: string | null;
  updated_at?: string;
}

export interface BillingTransaction {
  id: string;
  user_id: string;
  cmdr_name: string;
  type: TransactionType;
  item_or_plan_id: string;
  item_title: string;
  amount_rub: number;
  amount_credits: number;
  payment_method: PaymentMethod;
  status: TransactionStatus;
  metadata?: Record<string, any>;
  provider_id?: string | null;
  external_id?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface UserBalance {
  user_id: string;
  credits: number;
  total_spent_rub: number;
  total_spent_credits: number;
  updated_at: string;
}

export interface ChartDataPoint {
  date: string;
  label: string;
  subscriptions: number;
  shop: number;
  total: number;
}

export interface PilotGrowthPoint {
  date: string;
  label: string;
  totalPilots: number;
  activePilots: number;
  premiumPilots: number;
}

export interface TierDistribution {
  planId: string;
  name: string;
  count: number;
  percentage: number;
  mrrContribution: number;
  color: string;
}

export interface CategorySalesStat {
  category: CosmeticCategory;
  name: string;
  unitsSold: number;
  revenueRub: number;
  percentage: number;
  color: string;
}

export interface FunnelStep {
  step: string;
  count: number;
  percentage: number;
  description: string;
}

export interface ProjectBillingStats {
  period: '7d' | '30d' | '90d' | '1y' | 'all';
  updatedAt: string;
  kpis: {
    mrr: number;
    mrrDelta: number;
    grossRevenue: number;
    grossRevenueDelta: number;
    activeSubscribers: number;
    activeSubscribersDelta: number;
    arpu: number;
    churnRate: number;
    cosmeticsSoldTotal: number;
    cosmeticsRevenue: number;
    averageOrderValue: number;
  };
  charts: {
    revenueTimeline: ChartDataPoint[];
    pilotGrowth: PilotGrowthPoint[];
    tierDistribution: TierDistribution[];
    categorySales: CategorySalesStat[];
    conversionFunnel: FunnelStep[];
  };
  telemetry: {
    totalRegisteredPilots: number;
    totalSystemsClaimed: number;
    totalFacilitiesBuilt: number;
    totalTonnageHauled: number;
    journalEventsParsed: number;
    supportTicketsOpen: number;
    supportTicketsResolved: number;
    apiTokensActive: number;
    serverUptimePct: number;
    avgLatencyMs: number;
    pendingPayments?: number;
    storageBackend?: 'supabase' | 'file';
  };
  recentTransactions: BillingTransaction[];
  topSpenders: {
    cmdrName: string;
    tier: string;
    totalSpentRub: number;
    purchasesCount: number;
    avatarUrl?: string;
  }[];
}

// ── Payment providers & intents ──

export type PaymentProviderId = 'tbank' | 'yookassa' | 'robokassa' | 'stripe' | 'cryptobot' | 'manual' | (string & {});

export type PaymentIntentStatus = 'processing' | 'pending' | 'paid' | 'failed' | 'canceled' | 'expired';

export type PaymentPurpose = 'credit_topup' | 'subscription' | 'shop_purchase';

export interface ProviderConfigField {
  key: string;
  label: string;
  type: 'text' | 'secret' | 'url' | 'select' | 'boolean';
  placeholder?: string;
  help?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
}

export interface PaymentProvider {
  id: PaymentProviderId;
  name: string;
  is_enabled: boolean;
  test_mode: boolean;
  config: Record<string, any>;
  methods: string[];
  display_order: number;
  last_check_at?: string | null;
  last_check_ok?: boolean | null;
  last_check_msg?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** Provider as exposed to admin UI: secrets are masked. */
export interface PaymentProviderView extends Omit<PaymentProvider, 'config'> {
  config: Record<string, any>;
  config_fields: ProviderConfigField[];
  webhook_url: string;
  docs_url?: string;
  description?: string;
  configured: boolean;
}

/** Provider as exposed to end users (checkout). */
export interface PublicPaymentProvider {
  id: PaymentProviderId;
  name: string;
  methods: string[];
  test_mode: boolean;
}

export interface PaymentIntent {
  id: string;
  user_id: string | null;
  cmdr_name: string | null;
  provider_id: PaymentProviderId | null;
  external_id: string | null;
  purpose: PaymentPurpose;
  target_id: string | null;
  amount_rub: number;
  amount_credits: number;
  currency: string;
  status: PaymentIntentStatus;
  payment_url: string | null;
  transaction_id: string | null;
  metadata: Record<string, any>;
  created_at: string;
  updated_at: string;
  paid_at?: string | null;
}

export interface CreditPack {
  id: string;
  credits: number;
  price_rub: number;
  bonus_pct: number;
  label: string;
}

export interface BillingSettings {
  welcome_credits: number;
  credit_packs: CreditPack[];
  currency: string;
  shop_enabled: boolean;
}
