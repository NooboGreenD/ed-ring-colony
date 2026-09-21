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
  created_at: string;
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
  created_at: string;
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
  created_at: string;
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
