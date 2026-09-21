/**
 * Billing repository — single entry point for plans, subscriptions, shop
 * catalogue, inventory, balances, transactions, payment providers & intents.
 *
 * All data lives in Supabase (see migrations 20260921000000 / 20260922000000).
 * When the service role key is absent the same API transparently works on a
 * local JSON file so previews/tests still function.
 */
import crypto from 'crypto';
import type {
  BillingPlan,
  UserSubscription,
  ShopItem,
  UserInventoryItem,
  EquippedCosmetics,
  BillingTransaction,
  UserBalance,
  ProjectBillingStats,
  ChartDataPoint,
  PilotGrowthPoint,
  TierDistribution,
  CategorySalesStat,
  FunnelStep,
  PaymentProvider,
  PaymentIntent,
  PaymentPurpose,
  BillingSettings,
  CreditPack,
  CosmeticCategory,
} from '@/types/billing';
import { getBillingAdapter, type TableAdapter } from './billing/storage';
import { INITIAL_PLANS, INITIAL_SHOP_ITEMS } from './billing/catalogSeed';
import { PROVIDER_DRIVERS } from './billing/providers';

export { INITIAL_PLANS, INITIAL_SHOP_ITEMS };

const CATEGORIES: CosmeticCategory[] = ['frame', 'badge', 'skin', 'glow', 'title'];

export const DEFAULT_CREDIT_PACKS: CreditPack[] = [
  { id: 'pack-500', credits: 500, price_rub: 79, bonus_pct: 0, label: 'Стартовый' },
  { id: 'pack-1500', credits: 1500, price_rub: 199, bonus_pct: 5, label: 'Разведчик' },
  { id: 'pack-4000', credits: 4000, price_rub: 490, bonus_pct: 10, label: 'Строитель' },
  { id: 'pack-9000', credits: 9000, price_rub: 990, bonus_pct: 20, label: 'Флотоводец' },
];

export const DEFAULT_SETTINGS: BillingSettings = {
  welcome_credits: 0,
  credit_packs: DEFAULT_CREDIT_PACKS,
  currency: 'RUB',
  shop_enabled: true,
};

const nowIso = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const txId = () => `TX-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function categoryField(category: string): keyof EquippedCosmetics | null {
  switch (category) {
    case 'frame':
      return 'frame_id';
    case 'badge':
      return 'badge_id';
    case 'skin':
      return 'skin_id';
    case 'glow':
      return 'glow_id';
    case 'title':
      return 'title_id';
    default:
      return null;
  }
}

export interface PurchaseResult {
  success: boolean;
  error?: string;
  item?: ShopItem;
  balance?: UserBalance;
  transaction?: BillingTransaction;
}

export interface SubscribeResult {
  success: boolean;
  error?: string;
  subscription?: UserSubscription;
  balance?: UserBalance;
  transaction?: BillingTransaction;
}

class BillingRepository {
  private adapterPromise: Promise<TableAdapter> | null = null;
  private seeded = false;

  private async db(): Promise<TableAdapter> {
    if (!this.adapterPromise) this.adapterPromise = getBillingAdapter();
    const a = await this.adapterPromise;
    if (!this.seeded) {
      this.seeded = true;
      await this.ensureSeed(a);
    }
    return a;
  }

  /** Seeds catalogue & providers if tables are empty (idempotent). */
  private async ensureSeed(a: TableAdapter) {
    try {
      if ((await a.count('billing_plans')) === 0) {
        for (const p of INITIAL_PLANS) await a.upsert('billing_plans', { ...p, discount_pct: p.discount_pct ?? 0 });
      }
      if ((await a.count('shop_items')) === 0) {
        let order = 0;
        for (const i of INITIAL_SHOP_ITEMS) await a.upsert('shop_items', { ...i, sales_count: 0, display_order: order++ });
      } else {
        // Catalogue upgrade: seed skins created before full-site colour schemes
        // existed get their `preview_data.theme` filled in (never overwrites admin edits).
        for (const seed of INITIAL_SHOP_ITEMS) {
          if (seed.category !== 'skin' || !seed.preview_data?.theme) continue;
          const cur = await a.get<ShopItem>('shop_items', seed.id);
          if (cur && !cur.preview_data?.theme) {
            await a.update('shop_items', seed.id, { preview_data: { ...cur.preview_data, theme: seed.preview_data.theme }, updated_at: nowIso() });
          }
        }
      }
      const providers = await a.list<PaymentProvider>('payment_providers');
      const have = new Set(providers.map((p) => p.id));
      let order = 1;
      for (const d of Object.values(PROVIDER_DRIVERS)) {
        if (!have.has(d.id)) {
          await a.upsert('payment_providers', {
            id: d.id,
            name: d.name,
            is_enabled: false,
            test_mode: d.id !== 'manual',
            config: {},
            methods: d.methods,
            display_order: d.id === 'manual' ? 9 : order,
            created_at: nowIso(),
            updated_at: nowIso(),
          });
        }
        order++;
      }
    } catch (e) {
      console.warn('[billing] seed skipped:', (e as any)?.message || e);
    }
  }

  get backendKind(): Promise<'supabase' | 'file'> {
    return this.db().then((a) => a.kind);
  }

  // ───────────────────────── Settings ─────────────────────────

  async getSettings(): Promise<BillingSettings> {
    const a = await this.db();
    const row = await a.get<{ id: string; value: any }>('billing_settings', 'general');
    const v = row?.value || {};
    return {
      welcome_credits: num(v.welcome_credits ?? DEFAULT_SETTINGS.welcome_credits),
      credit_packs: Array.isArray(v.credit_packs) && v.credit_packs.length ? v.credit_packs : DEFAULT_CREDIT_PACKS,
      currency: v.currency || 'RUB',
      shop_enabled: v.shop_enabled !== false,
    };
  }

  async updateSettings(patch: Partial<BillingSettings>): Promise<BillingSettings> {
    const a = await this.db();
    const cur = await this.getSettings();
    const next: BillingSettings = { ...cur, ...patch };
    if (patch.credit_packs) {
      next.credit_packs = patch.credit_packs
        .filter((p) => num(p.credits) > 0 && num(p.price_rub) > 0)
        .map((p, i) => ({
          id: p.id || `pack-${num(p.credits)}-${i}`,
          credits: Math.round(num(p.credits)),
          price_rub: Math.round(num(p.price_rub)),
          bonus_pct: Math.max(0, Math.round(num(p.bonus_pct))),
          label: String(p.label || '').slice(0, 40),
        }));
    }
    next.welcome_credits = Math.max(0, Math.round(num(next.welcome_credits)));
    await a.upsert('billing_settings', { id: 'general', value: next, updated_at: nowIso() });
    return next;
  }

  // ───────────────────────── Plans ─────────────────────────

  async getPlans(includeInactive = false): Promise<BillingPlan[]> {
    const a = await this.db();
    const plans = await a.list<BillingPlan>('billing_plans', { order: { column: 'display_order' } });
    return plans.filter((p) => includeInactive || p.is_active !== false).map(normalizePlan);
  }

  async getPlanById(id: string): Promise<BillingPlan | undefined> {
    const a = await this.db();
    const p = await a.get<BillingPlan>('billing_plans', id);
    return p ? normalizePlan(p) : undefined;
  }

  async updatePlan(id: string, updates: Partial<BillingPlan>): Promise<BillingPlan | null> {
    const a = await this.db();
    const allowed: (keyof BillingPlan)[] = [
      'name', 'name_en', 'description', 'description_en', 'price_rub', 'price_credits', 'period_days', 'perks',
      'badge_label', 'color', 'is_active', 'is_popular', 'display_order', 'discount_pct',
    ];
    const patch: Record<string, any> = { updated_at: nowIso() };
    for (const k of allowed) if (k in updates) patch[k] = (updates as any)[k];
    if (patch.perks && !Array.isArray(patch.perks)) patch.perks = String(patch.perks).split('\n').map((s: string) => s.trim()).filter(Boolean);
    for (const k of ['price_rub', 'price_credits', 'period_days', 'display_order', 'discount_pct']) if (k in patch) patch[k] = Math.max(0, Math.round(num(patch[k])));
    const res = await a.update<BillingPlan>('billing_plans', id, patch);
    return res ? normalizePlan(res) : null;
  }

  async createPlan(input: Partial<BillingPlan> & { id: string; name: string }): Promise<BillingPlan> {
    const a = await this.db();
    const id = slugify(input.id || input.name);
    if (await a.get('billing_plans', id)) throw new Error(`План с id «${id}» уже существует`);
    const row: BillingPlan = {
      id,
      name: input.name,
      name_en: input.name_en || input.name,
      description: input.description || '',
      description_en: input.description_en || '',
      price_rub: Math.max(0, Math.round(num(input.price_rub))),
      price_credits: Math.max(0, Math.round(num(input.price_credits))),
      period_days: Math.max(1, Math.round(num(input.period_days) || 30)),
      perks: Array.isArray(input.perks) ? input.perks : [],
      badge_label: input.badge_label || input.name.toUpperCase().slice(0, 14),
      color: input.color || '#e67e22',
      is_active: input.is_active ?? true,
      is_popular: input.is_popular ?? false,
      display_order: Math.round(num(input.display_order)),
      discount_pct: Math.max(0, Math.min(100, Math.round(num(input.discount_pct)))),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return normalizePlan(await a.insert<BillingPlan>('billing_plans', row));
  }

  async deletePlan(id: string): Promise<boolean> {
    const a = await this.db();
    const active = await a.count('user_subscriptions', { eq: { plan_id: id, status: 'active' } });
    if (active > 0) throw new Error(`Нельзя удалить план: ${active} активных подписок. Сначала деактивируйте его.`);
    return a.remove('billing_plans', id);
  }

  // ───────────────────────── Subscriptions ─────────────────────────

  async getSubscriptions(filter?: { status?: string; planId?: string; search?: string }): Promise<UserSubscription[]> {
    const a = await this.db();
    const plans = await this.getPlans(true);
    const opts: any = { order: { column: 'created_at', ascending: false } };
    if (filter?.status && filter.status !== 'all') opts.eq = { ...(opts.eq || {}), status: filter.status };
    if (filter?.planId && filter.planId !== 'all') opts.eq = { ...(opts.eq || {}), plan_id: filter.planId };
    let list = await a.list<UserSubscription>('user_subscriptions', opts);
    list = await this.expireStale(list);
    if (filter?.status && filter.status !== 'all') list = list.filter((s) => s.status === filter.status);
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter((s) => (s.cmdr_name || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.user_id || '').toLowerCase().includes(q));
    }
    return list.map((s) => ({ ...s, plan: plans.find((p) => p.id === s.plan_id) }));
  }

  /** Marks active-but-expired subscriptions as expired (lazy expiry). */
  private async expireStale(list: UserSubscription[]): Promise<UserSubscription[]> {
    const a = await this.db();
    const now = Date.now();
    const out: UserSubscription[] = [];
    for (const s of list) {
      if (s.status === 'active' && s.expires_at && new Date(s.expires_at).getTime() < now) {
        await a.update('user_subscriptions', s.id, { status: 'expired', updated_at: nowIso() });
        out.push({ ...s, status: 'expired' });
      } else out.push(s);
    }
    return out;
  }

  async getUserSubscription(userId: string): Promise<UserSubscription | null> {
    if (!userId) return null;
    const a = await this.db();
    let list = await a.list<UserSubscription>('user_subscriptions', { eq: { user_id: userId, status: 'active' }, order: { column: 'expires_at', ascending: false } });
    list = (await this.expireStale(list)).filter((s) => s.status === 'active');
    const sub = list[0];
    if (!sub) return null;
    return { ...sub, plan: await this.getPlanById(sub.plan_id) };
  }

  /** Discount percentage that a user's active plan grants in the shop. */
  async getUserDiscountPct(userId: string | null | undefined): Promise<{ pct: number; sub: UserSubscription | null }> {
    if (!userId) return { pct: 0, sub: null };
    const sub = await this.getUserSubscription(userId);
    return { pct: sub?.plan?.discount_pct || 0, sub };
  }

  async grantSubscription(params: {
    userId: string;
    cmdrName: string;
    planId: string;
    durationDays: number;
    notes?: string;
    autoRenew?: boolean;
    paymentMethod?: string;
    providerId?: string | null;
    externalId?: string | null;
    amountRub?: number;
    amountCredits?: number;
    transactionType?: BillingTransaction['type'];
  }): Promise<UserSubscription> {
    const a = await this.db();
    const plan = (await this.getPlanById(params.planId)) || (await this.getPlans())[0];
    if (!plan) throw new Error('Нет доступных тарифных планов');
    const now = new Date();

    // Extend if the same plan is already active; otherwise replace.
    const current = await this.getUserSubscription(params.userId);
    let startedAt = now;
    let base = now;
    if (current) {
      if (current.plan_id === plan.id && current.expires_at) {
        base = new Date(Math.max(now.getTime(), new Date(current.expires_at).getTime()));
      }
      await a.update('user_subscriptions', current.id, { status: 'canceled', auto_renew: false, updated_at: nowIso(), notes: `${current.notes ? current.notes + ' | ' : ''}Заменена новой подпиской` });
      startedAt = current.plan_id === plan.id ? new Date(current.started_at) : now;
    }
    const expiresAt = new Date(base.getTime() + params.durationDays * 86400000);

    const sub: UserSubscription = {
      id: uid('sub'),
      user_id: params.userId,
      cmdr_name: params.cmdrName || 'Командир',
      plan_id: plan.id,
      status: 'active',
      started_at: startedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      auto_renew: params.autoRenew ?? false,
      payment_method: params.paymentMethod || 'admin',
      notes: params.notes || 'Назначено администратором',
      provider_id: params.providerId || null,
      external_id: params.externalId || null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    await a.insert('user_subscriptions', stripJoins(sub));

    await this.addTransaction({
      userId: params.userId,
      cmdrName: params.cmdrName,
      type: params.transactionType || (params.paymentMethod && params.paymentMethod !== 'admin' ? 'subscription' : 'admin_grant'),
      itemOrPlanId: plan.id,
      itemTitle: `Подписка «${plan.name}» (${params.durationDays} дн)`,
      amountRub: num(params.amountRub),
      amountCredits: num(params.amountCredits),
      paymentMethod: (params.paymentMethod as any) || 'admin',
      status: 'completed',
      providerId: params.providerId,
      externalId: params.externalId,
      metadata: { durationDays: params.durationDays, notes: params.notes, subscriptionId: sub.id },
    });

    return { ...sub, plan };
  }

  /** User buys a plan for credits. */
  async subscribeWithCredits(params: { userId: string; cmdrName: string; planId: string }): Promise<SubscribeResult> {
    const plan = await this.getPlanById(params.planId);
    if (!plan || !plan.is_active) return { success: false, error: 'Тарифный план недоступен' };
    if (!plan.price_credits) return { success: false, error: 'Этот план нельзя оплатить кредитами' };
    const bal = await this.getUserBalance(params.userId);
    if (bal.credits < plan.price_credits) {
      return { success: false, error: `Недостаточно кредитов. Необходимо: ${plan.price_credits.toLocaleString('ru-RU')}, на балансе: ${bal.credits.toLocaleString('ru-RU')}` };
    }
    const newBal = await this.adjustBalance(params.userId, { credits: -plan.price_credits, spentCredits: plan.price_credits });
    const sub = await this.grantSubscription({
      ...params,
      durationDays: plan.period_days,
      paymentMethod: 'credits',
      amountCredits: plan.price_credits,
      transactionType: 'subscription',
      notes: 'Оплачено кредитами',
    });
    return { success: true, subscription: sub, balance: newBal };
  }

  async updateSubscription(
    id: string,
    updates: Partial<Pick<UserSubscription, 'status' | 'plan_id' | 'expires_at' | 'auto_renew' | 'notes'>>,
  ): Promise<UserSubscription | null> {
    const a = await this.db();
    const patch: Record<string, any> = { updated_at: nowIso() };
    for (const k of ['status', 'plan_id', 'expires_at', 'auto_renew', 'notes'] as const) if (updates[k] !== undefined) patch[k] = updates[k];
    const res = await a.update<UserSubscription>('user_subscriptions', id, patch);
    if (!res) return null;
    return { ...res, plan: await this.getPlanById(res.plan_id) };
  }

  async extendSubscription(id: string, additionalDays: number): Promise<UserSubscription | null> {
    const a = await this.db();
    const sub = await a.get<UserSubscription>('user_subscriptions', id);
    if (!sub) return null;
    const currentExpiry = sub.expires_at ? new Date(sub.expires_at) : new Date();
    const baseDate = currentExpiry.getTime() > Date.now() ? currentExpiry : new Date();
    const newExpiry = new Date(baseDate.getTime() + additionalDays * 86400000);
    const res = await this.updateSubscription(id, {
      expires_at: newExpiry.toISOString(),
      status: 'active',
      notes: `${sub.notes ? sub.notes + ' | ' : ''}Продлено на ${additionalDays} дн.`,
    });
    await this.addTransaction({
      userId: sub.user_id,
      cmdrName: sub.cmdr_name,
      type: 'admin_grant',
      itemOrPlanId: sub.plan_id,
      itemTitle: `Продление подписки на ${additionalDays} дн`,
      amountRub: 0,
      amountCredits: 0,
      paymentMethod: 'admin',
      status: 'completed',
      metadata: { subscriptionId: id, additionalDays },
    });
    return res;
  }

  async cancelSubscription(id: string, reason?: string): Promise<UserSubscription | null> {
    return this.updateSubscription(id, {
      status: 'canceled',
      auto_renew: false,
      notes: reason ? `Отменено: ${reason}` : 'Отменено пользователем/администратором',
    });
  }

  // ───────────────────────── Shop items ─────────────────────────

  async getShopItems(filter?: { category?: string; rarity?: string; search?: string; includeInactive?: boolean }): Promise<ShopItem[]> {
    const a = await this.db();
    let list = await a.list<ShopItem>('shop_items', { order: { column: 'display_order' } });
    list = list.map(normalizeItem);
    if (!filter?.includeInactive) list = list.filter((i) => i.is_active !== false);
    if (filter?.category && filter.category !== 'all') list = list.filter((i) => i.category === filter.category);
    if (filter?.rarity && filter.rarity !== 'all') list = list.filter((i) => i.rarity === filter.rarity);
    if (filter?.search) {
      const q = filter.search.toLowerCase().trim();
      list = list.filter((i) => i.title.toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q) || i.id.includes(q));
    }
    return list.sort((x, y) => (x.display_order || 0) - (y.display_order || 0) || x.title.localeCompare(y.title));
  }

  async getShopItemById(id: string): Promise<ShopItem | undefined> {
    const a = await this.db();
    const i = await a.get<ShopItem>('shop_items', id);
    return i ? normalizeItem(i) : undefined;
  }

  async getShopItemsByIds(ids: string[]): Promise<Map<string, ShopItem>> {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    if (!uniq.length) return new Map();
    const a = await this.db();
    const rows = await a.list<ShopItem>('shop_items', { in: { id: uniq } });
    return new Map(rows.map((r) => [r.id, normalizeItem(r)]));
  }

  async createShopItem(input: Partial<ShopItem> & { category: CosmeticCategory; title: string }): Promise<ShopItem> {
    const a = await this.db();
    if (!CATEGORIES.includes(input.category)) throw new Error('Неизвестная категория');
    const id = slugify(input.id || `${input.category}-${input.title}`);
    if (await a.get('shop_items', id)) throw new Error(`Товар с id «${id}» уже существует`);
    const count = await a.count('shop_items');
    const row: ShopItem = {
      id,
      category: input.category,
      title: input.title,
      title_en: input.title_en || input.title,
      description: input.description || '',
      description_en: input.description_en || '',
      price_credits: Math.max(0, Math.round(num(input.price_credits))),
      price_rub: Math.max(0, Math.round(num(input.price_rub))),
      rarity: (['common', 'rare', 'epic', 'legendary'] as const).includes(input.rarity as any) ? input.rarity! : 'common',
      requires_subscription: input.requires_subscription || null,
      subscriber_discount_pct: Math.max(0, Math.min(100, Math.round(num(input.subscriber_discount_pct)))),
      preview_data: input.preview_data || {},
      is_active: input.is_active ?? true,
      is_featured: input.is_featured ?? false,
      sales_count: 0,
      display_order: input.display_order ?? count,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return normalizeItem(await a.insert<ShopItem>('shop_items', row));
  }

  async updateShopItem(id: string, updates: Partial<ShopItem>): Promise<ShopItem | null> {
    const a = await this.db();
    const allowed: (keyof ShopItem)[] = [
      'category', 'title', 'title_en', 'description', 'description_en', 'price_credits', 'price_rub', 'rarity',
      'requires_subscription', 'subscriber_discount_pct', 'preview_data', 'is_active', 'is_featured', 'display_order',
    ];
    const patch: Record<string, any> = { updated_at: nowIso() };
    for (const k of allowed) if (k in updates) patch[k] = (updates as any)[k];
    if ('requires_subscription' in patch && !patch.requires_subscription) patch.requires_subscription = null;
    for (const k of ['price_credits', 'price_rub', 'subscriber_discount_pct', 'display_order']) if (k in patch) patch[k] = Math.max(0, Math.round(num(patch[k])));
    if ('category' in patch && !CATEGORIES.includes(patch.category)) delete patch.category;
    const res = await a.update<ShopItem>('shop_items', id, patch);
    return res ? normalizeItem(res) : null;
  }

  async deleteShopItem(id: string): Promise<{ deleted: boolean; owners: number }> {
    const a = await this.db();
    const owners = await a.count('user_inventory', { eq: { item_id: id } });
    if (owners > 0) {
      // Never break owners: archive instead of delete.
      await a.update('shop_items', id, { is_active: false, is_featured: false, updated_at: nowIso() });
      return { deleted: false, owners };
    }
    return { deleted: await a.remove('shop_items', id), owners: 0 };
  }

  // ───────────────────────── Inventory & cosmetics ─────────────────────────

  async getUserInventory(userId: string): Promise<UserInventoryItem[]> {
    if (!userId) return [];
    const a = await this.db();
    const inv = await a.list<UserInventoryItem>('user_inventory', { eq: { user_id: userId }, order: { column: 'purchased_at', ascending: false } });
    const items = await this.getShopItemsByIds(inv.map((i) => i.item_id));
    const eq = await this.getUserEquippedCosmetics(userId);
    return inv.map((i) => {
      const item = items.get(i.item_id);
      const f = item ? categoryField(item.category) : null;
      return { ...i, item, is_equipped: f ? eq[f] === i.item_id : false };
    });
  }

  async userOwnsItem(userId: string, itemId: string): Promise<boolean> {
    const a = await this.db();
    return (await a.count('user_inventory', { eq: { user_id: userId, item_id: itemId } })) > 0;
  }

  async getUserEquippedCosmetics(userId: string): Promise<EquippedCosmetics> {
    const empty: EquippedCosmetics = { user_id: userId, frame_id: null, badge_id: null, skin_id: null, glow_id: null, title_id: null };
    if (!userId) return empty;
    const a = await this.db();
    const row = await a.get<EquippedCosmetics>('user_cosmetics_equipped', userId);
    return row ? { ...empty, ...row } : empty;
  }

  /** Batch: equipped cosmetics + subscription tier + item preview data for many users. */
  async getPublicCosmetics(userIds: string[]): Promise<Record<string, PublicCosmetics>> {
    const ids = Array.from(new Set(userIds.filter(Boolean)));
    if (!ids.length) return {};
    const a = await this.db();
    const [equippedRows, subs, plans] = await Promise.all([
      a.list<EquippedCosmetics>('user_cosmetics_equipped', { in: { user_id: ids } }),
      a.list<UserSubscription>('user_subscriptions', { in: { user_id: ids }, eq: { status: 'active' } }),
      this.getPlans(true),
    ]);
    const now = Date.now();
    const activeSubs = subs.filter((s) => !s.expires_at || new Date(s.expires_at).getTime() > now);
    const itemIds: string[] = [];
    for (const e of equippedRows) for (const f of ['frame_id', 'badge_id', 'skin_id', 'glow_id', 'title_id'] as const) if (e[f]) itemIds.push(e[f]!);
    const items = await this.getShopItemsByIds(itemIds);
    const out: Record<string, PublicCosmetics> = {};
    for (const id of ids) {
      const e = equippedRows.find((r) => r.user_id === id);
      const s = activeSubs.find((r) => r.user_id === id);
      const plan = s ? plans.find((p) => p.id === s.plan_id) : undefined;
      const pick = (itemId?: string | null) => {
        const it = itemId ? items.get(itemId) : undefined;
        return it && it.is_active !== false ? { id: it.id, title: it.title, rarity: it.rarity, preview: it.preview_data || {} } : null;
      };
      out[id] = {
        user_id: id,
        frame: pick(e?.frame_id),
        badge: pick(e?.badge_id),
        skin: pick(e?.skin_id),
        glow: pick(e?.glow_id),
        title: pick(e?.title_id),
        tier: plan ? { id: plan.id, label: plan.badge_label, color: plan.color } : null,
      };
    }
    return out;
  }

  async equipCosmetic(userId: string, category: string, itemId: string | null): Promise<EquippedCosmetics> {
    const a = await this.db();
    const field = categoryField(category);
    if (!field) throw new Error('Неизвестная категория');
    if (itemId) {
      const item = await this.getShopItemById(itemId);
      if (!item) throw new Error('Предмет не найден');
      if (item.category !== category) throw new Error('Категория предмета не совпадает');
      if (!(await this.userOwnsItem(userId, itemId))) throw new Error('Этот предмет не куплен');
    }
    const current = await this.getUserEquippedCosmetics(userId);
    const updated: EquippedCosmetics = { ...current, [field]: itemId, user_id: userId, updated_at: nowIso() };
    await a.upsert('user_cosmetics_equipped', updated);
    // keep the denormalised flag in inventory in sync
    const inv = await a.list<UserInventoryItem>('user_inventory', { eq: { user_id: userId } });
    const items = await this.getShopItemsByIds(inv.map((i) => i.item_id));
    for (const i of inv) {
      const it = items.get(i.item_id);
      if (it && it.category === category) {
        const flag = i.item_id === itemId;
        if (Boolean(i.is_equipped) !== flag) await a.update('user_inventory', i.id, { is_equipped: flag });
      }
    }
    return updated;
  }

  // ───────────────────────── Balances ─────────────────────────

  async getUserBalance(userId: string): Promise<UserBalance> {
    const a = await this.db();
    const empty: UserBalance = { user_id: userId, credits: 0, total_spent_rub: 0, total_spent_credits: 0, updated_at: nowIso() };
    if (!userId) return empty;
    const row = await a.get<UserBalance>('user_balances', userId);
    if (row) return { ...row, credits: num(row.credits), total_spent_rub: num(row.total_spent_rub), total_spent_credits: num(row.total_spent_credits) };
    const settings = await this.getSettings();
    const fresh: UserBalance = { ...empty, credits: settings.welcome_credits };
    await a.upsert('user_balances', fresh);
    if (settings.welcome_credits > 0) {
      await this.addTransaction({
        userId,
        cmdrName: '',
        type: 'admin_grant',
        itemOrPlanId: 'welcome',
        itemTitle: `Приветственный бонус (+${settings.welcome_credits} Кредитов)`,
        amountRub: 0,
        amountCredits: settings.welcome_credits,
        paymentMethod: 'admin',
        status: 'completed',
      });
    }
    return fresh;
  }

  private async adjustBalance(userId: string, d: { credits?: number; spentRub?: number; spentCredits?: number }): Promise<UserBalance> {
    const a = await this.db();
    const cur = await this.getUserBalance(userId);
    const next: UserBalance = {
      user_id: userId,
      credits: Math.max(0, cur.credits + num(d.credits)),
      total_spent_rub: Math.max(0, cur.total_spent_rub + num(d.spentRub)),
      total_spent_credits: Math.max(0, cur.total_spent_credits + num(d.spentCredits)),
      updated_at: nowIso(),
    };
    await a.upsert('user_balances', next);
    return next;
  }

  async grantCredits(params: { userId: string; cmdrName: string; amountCredits: number; reason?: string; adminName?: string }): Promise<{ balance: UserBalance; transaction: BillingTransaction }> {
    const amount = Math.round(num(params.amountCredits));
    if (!amount) throw new Error('Сумма должна быть отлична от нуля');
    const balance = await this.adjustBalance(params.userId, { credits: amount });
    const transaction = await this.addTransaction({
      userId: params.userId,
      cmdrName: params.cmdrName,
      type: 'admin_grant',
      itemOrPlanId: 'credits',
      itemTitle: `${amount > 0 ? 'Начисление' : 'Списание'} кредитов администратором (${amount > 0 ? '+' : ''}${amount.toLocaleString('ru-RU')})`,
      amountRub: 0,
      amountCredits: amount,
      paymentMethod: 'admin',
      status: 'completed',
      metadata: { reason: params.reason, admin: params.adminName },
    });
    return { balance, transaction };
  }

  /** Credits a paid top-up (called from payment fulfilment). */
  async topupBalance(params: {
    userId: string;
    cmdrName: string;
    amountCredits: number;
    amountRub: number;
    paymentMethod: string;
    providerId?: string | null;
    externalId?: string | null;
  }): Promise<{ balance: UserBalance; transaction: BillingTransaction }> {
    const balance = await this.adjustBalance(params.userId, { credits: params.amountCredits, spentRub: params.amountRub });
    const transaction = await this.addTransaction({
      userId: params.userId,
      cmdrName: params.cmdrName,
      type: 'credit_topup',
      itemOrPlanId: `topup-${params.amountCredits}`,
      itemTitle: `Пополнение счета (+${params.amountCredits.toLocaleString('ru-RU')} Кредитов)`,
      amountRub: params.amountRub,
      amountCredits: params.amountCredits,
      paymentMethod: params.paymentMethod as any,
      status: 'completed',
      providerId: params.providerId,
      externalId: params.externalId,
    });
    return { balance, transaction };
  }

  // ───────────────────────── Pricing ─────────────────────────

  async priceFor(item: ShopItem, userId: string | null | undefined): Promise<{ credits: number; rub: number; discountPct: number; locked: boolean; lockReason?: string }> {
    const { pct, sub } = await this.getUserDiscountPct(userId);
    const discountPct = Math.min(100, Math.max(item.subscriber_discount_pct && sub ? item.subscriber_discount_pct : 0, pct));
    const credits = Math.round(item.price_credits * (1 - discountPct / 100));
    const rub = Math.round(item.price_rub * (1 - discountPct / 100));
    let locked = false;
    let lockReason: string | undefined;
    if (item.requires_subscription) {
      const plans = await this.getPlans(true);
      const req = plans.find((p) => p.id === item.requires_subscription);
      const reqOrder = req?.display_order ?? 0;
      const haveOrder = sub?.plan?.display_order ?? -1;
      if (!sub || haveOrder < reqOrder) {
        locked = true;
        lockReason = `Требуется подписка «${req?.name || item.requires_subscription}» или выше`;
      }
    }
    return { credits, rub, discountPct, locked, lockReason };
  }

  // ───────────────────────── Purchases ─────────────────────────

  async purchaseItem(params: {
    userId: string;
    cmdrName: string;
    itemId: string;
    useCredits?: boolean;
    autoEquip?: boolean;
    /** already-paid via provider */
    paid?: { amountRub: number; providerId: string; externalId: string; method: string };
  }): Promise<PurchaseResult> {
    const a = await this.db();
    const item = await this.getShopItemById(params.itemId);
    if (!item || item.is_active === false) return { success: false, error: 'Предмет не найден в каталоге' };
    if (await this.userOwnsItem(params.userId, item.id)) return { success: false, error: 'Вы уже владеете этим улучшением' };

    const price = await this.priceFor(item, params.userId);
    if (price.locked) return { success: false, error: price.lockReason };

    let balance: UserBalance;
    let tx: BillingTransaction;
    if (params.paid) {
      balance = await this.adjustBalance(params.userId, { spentRub: params.paid.amountRub });
      tx = await this.addTransaction({
        userId: params.userId, cmdrName: params.cmdrName, type: 'shop_purchase', itemOrPlanId: item.id, itemTitle: item.title,
        amountRub: params.paid.amountRub, amountCredits: 0, paymentMethod: params.paid.method as any, status: 'completed',
        providerId: params.paid.providerId, externalId: params.paid.externalId,
        metadata: { rarity: item.rarity, category: item.category, discountPct: price.discountPct },
      });
    } else {
      const bal = await this.getUserBalance(params.userId);
      if (bal.credits < price.credits) {
        return { success: false, error: `Недостаточно кредитов. Необходимо: ${price.credits.toLocaleString('ru-RU')}, на балансе: ${bal.credits.toLocaleString('ru-RU')}` };
      }
      balance = await this.adjustBalance(params.userId, { credits: -price.credits, spentCredits: price.credits });
      tx = await this.addTransaction({
        userId: params.userId, cmdrName: params.cmdrName, type: 'shop_purchase', itemOrPlanId: item.id, itemTitle: item.title,
        amountRub: 0, amountCredits: price.credits, paymentMethod: 'credits', status: 'completed',
        metadata: { rarity: item.rarity, category: item.category, discountPct: price.discountPct },
      });
    }

    await a.insert('user_inventory', {
      id: uid('inv'),
      user_id: params.userId,
      item_id: item.id,
      purchased_at: nowIso(),
      price_paid_credits: params.paid ? 0 : price.credits,
      price_paid_rub: params.paid ? params.paid.amountRub : 0,
      transaction_id: tx.id,
      is_equipped: false,
    });
    await a.update('shop_items', item.id, { sales_count: (item.sales_count || 0) + 1 });

    if (params.autoEquip !== false) await this.equipCosmetic(params.userId, item.category, item.id);
    return { success: true, item, balance, transaction: tx };
  }

  /** Admin gift: puts an item into inventory without charging. */
  async grantItem(params: { userId: string; cmdrName: string; itemId: string; adminName?: string }): Promise<PurchaseResult> {
    const a = await this.db();
    const item = await this.getShopItemById(params.itemId);
    if (!item) return { success: false, error: 'Предмет не найден' };
    if (await this.userOwnsItem(params.userId, item.id)) return { success: false, error: 'Пилот уже владеет этим предметом' };
    const tx = await this.addTransaction({
      userId: params.userId, cmdrName: params.cmdrName, type: 'admin_grant', itemOrPlanId: item.id, itemTitle: `Подарок: ${item.title}`,
      amountRub: 0, amountCredits: 0, paymentMethod: 'admin', status: 'completed', metadata: { admin: params.adminName, category: item.category },
    });
    await a.insert('user_inventory', { id: uid('inv'), user_id: params.userId, item_id: item.id, purchased_at: nowIso(), price_paid_credits: 0, price_paid_rub: 0, transaction_id: tx.id, is_equipped: false });
    return { success: true, item, transaction: tx };
  }

  // ───────────────────────── Transactions ─────────────────────────

  async getTransactions(filter?: { type?: string; status?: string; search?: string; userId?: string; limit?: number; offset?: number }): Promise<{ transactions: BillingTransaction[]; total: number }> {
    const a = await this.db();
    const eq: Record<string, any> = {};
    if (filter?.type && filter.type !== 'all') eq.type = filter.type;
    if (filter?.status && filter.status !== 'all') eq.status = filter.status;
    if (filter?.userId) eq.user_id = filter.userId;
    const search = filter?.search?.toLowerCase().trim();
    // Search needs client-side filtering; fetch a wider window in that case.
    const all = await a.list<BillingTransaction>('billing_transactions', {
      eq: Object.keys(eq).length ? eq : undefined,
      order: { column: 'created_at', ascending: false },
      limit: search ? 2000 : (filter?.limit || 50),
      offset: search ? 0 : (filter?.offset || 0),
    });
    let list = all.map(normalizeTx);
    let total: number;
    if (search) {
      list = list.filter((t) => t.id.toLowerCase().includes(search) || (t.cmdr_name || '').toLowerCase().includes(search) || (t.item_title || '').toLowerCase().includes(search) || (t.external_id || '').toLowerCase().includes(search));
      total = list.length;
      const offset = filter?.offset || 0;
      list = list.slice(offset, offset + (filter?.limit || 50));
    } else {
      total = await a.count('billing_transactions', { eq: Object.keys(eq).length ? eq : undefined });
    }
    return { transactions: list, total };
  }

  async addTransaction(params: {
    userId: string;
    cmdrName: string;
    type: BillingTransaction['type'];
    itemOrPlanId: string;
    itemTitle: string;
    amountRub: number;
    amountCredits: number;
    paymentMethod: BillingTransaction['payment_method'];
    status: BillingTransaction['status'];
    metadata?: Record<string, any>;
    providerId?: string | null;
    externalId?: string | null;
  }): Promise<BillingTransaction> {
    const a = await this.db();
    const tx: BillingTransaction = {
      id: txId(),
      user_id: params.userId,
      cmdr_name: params.cmdrName,
      type: params.type,
      item_or_plan_id: params.itemOrPlanId,
      item_title: params.itemTitle,
      amount_rub: num(params.amountRub),
      amount_credits: num(params.amountCredits),
      payment_method: params.paymentMethod,
      status: params.status,
      metadata: params.metadata || {},
      provider_id: params.providerId || null,
      external_id: params.externalId || null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return normalizeTx(await a.insert<BillingTransaction>('billing_transactions', tx));
  }

  async refundTransaction(id: string, reason?: string): Promise<{ success: boolean; error?: string; transaction?: BillingTransaction }> {
    const a = await this.db();
    const tx = await a.get<BillingTransaction>('billing_transactions', id);
    if (!tx) return { success: false, error: 'Транзакция не найдена' };
    if (tx.status === 'refunded') return { success: false, error: 'Транзакция уже возвращена' };
    if (tx.status !== 'completed') return { success: false, error: 'Вернуть можно только завершённую транзакцию' };

    if (tx.type === 'credit_topup' && tx.user_id) {
      await this.adjustBalance(tx.user_id, { credits: -num(tx.amount_credits), spentRub: -num(tx.amount_rub) });
    }
    if (tx.type === 'shop_purchase' && tx.user_id) {
      const item = await this.getShopItemById(tx.item_or_plan_id);
      if (item) {
        const eq = await this.getUserEquippedCosmetics(tx.user_id);
        const f = categoryField(item.category);
        if (f && eq[f] === item.id) await this.equipCosmetic(tx.user_id, item.category, null);
        await a.update('shop_items', item.id, { sales_count: Math.max(0, (item.sales_count || 0) - 1) });
      }
      await a.removeWhere('user_inventory', { user_id: tx.user_id, item_id: tx.item_or_plan_id });
      // refund credits if the purchase was made with credits
      await this.adjustBalance(tx.user_id, { credits: num(tx.amount_credits), spentCredits: -num(tx.amount_credits), spentRub: -num(tx.amount_rub) });
    }
    if (tx.type === 'subscription' && tx.user_id) {
      const subId = tx.metadata?.subscriptionId;
      if (subId) await this.cancelSubscription(subId, 'Возврат средств');
      if (num(tx.amount_credits) > 0) await this.adjustBalance(tx.user_id, { credits: num(tx.amount_credits), spentCredits: -num(tx.amount_credits) });
      if (num(tx.amount_rub) > 0) await this.adjustBalance(tx.user_id, { spentRub: -num(tx.amount_rub) });
    }

    const updated = await a.update<BillingTransaction>('billing_transactions', id, {
      status: 'refunded',
      updated_at: nowIso(),
      metadata: { ...(tx.metadata || {}), refundReason: reason || 'Возврат по запросу администратора', refundedAt: nowIso() },
    });
    return { success: true, transaction: updated ? normalizeTx(updated) : undefined };
  }

  // ───────────────────────── Payment providers ─────────────────────────

  async getProviders(): Promise<PaymentProvider[]> {
    const a = await this.db();
    const rows = await a.list<PaymentProvider>('payment_providers', { order: { column: 'display_order' } });
    return rows.map((r) => ({ ...r, config: r.config || {}, methods: r.methods || [] }));
  }

  async getProvider(id: string): Promise<PaymentProvider | null> {
    const a = await this.db();
    const r = await a.get<PaymentProvider>('payment_providers', id);
    return r ? { ...r, config: r.config || {}, methods: r.methods || [] } : null;
  }

  async updateProvider(id: string, patch: Partial<PaymentProvider>): Promise<PaymentProvider | null> {
    const a = await this.db();
    const allowed: Record<string, any> = { updated_at: nowIso() };
    for (const k of ['name', 'is_enabled', 'test_mode', 'config', 'methods', 'display_order', 'last_check_at', 'last_check_ok', 'last_check_msg'] as const) {
      if (k in patch) allowed[k] = (patch as any)[k];
    }
    return a.update<PaymentProvider>('payment_providers', id, allowed);
  }

  async getEnabledProviders(): Promise<PaymentProvider[]> {
    const list = await this.getProviders();
    return list.filter((p) => p.is_enabled && PROVIDER_DRIVERS[p.id]?.isConfigured(p.config));
  }

  // ───────────────────────── Payment intents ─────────────────────────

  async createIntent(input: {
    userId: string;
    cmdrName: string;
    providerId: string;
    purpose: PaymentPurpose;
    targetId: string | null;
    amountRub: number;
    amountCredits: number;
    metadata?: Record<string, any>;
  }): Promise<PaymentIntent> {
    const a = await this.db();
    const intent: PaymentIntent = {
      id: uid('pi'),
      user_id: input.userId,
      cmdr_name: input.cmdrName,
      provider_id: input.providerId,
      external_id: null,
      purpose: input.purpose,
      target_id: input.targetId,
      amount_rub: Math.round(num(input.amountRub) * 100) / 100,
      amount_credits: Math.round(num(input.amountCredits)),
      currency: 'RUB',
      status: 'pending',
      payment_url: null,
      transaction_id: null,
      metadata: input.metadata || {},
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    return a.insert<PaymentIntent>('payment_intents', intent);
  }

  async getIntent(id: string): Promise<PaymentIntent | null> {
    const a = await this.db();
    return a.get<PaymentIntent>('payment_intents', id);
  }

  async findIntentByExternal(providerId: string, externalId: string): Promise<PaymentIntent | null> {
    const a = await this.db();
    const rows = await a.list<PaymentIntent>('payment_intents', { eq: { provider_id: providerId, external_id: externalId }, limit: 1 });
    return rows[0] || null;
  }

  async updateIntent(id: string, patch: Partial<PaymentIntent>): Promise<PaymentIntent | null> {
    const a = await this.db();
    return a.update<PaymentIntent>('payment_intents', id, { ...patch, updated_at: nowIso() });
  }

  async listIntents(filter?: { status?: string; userId?: string; limit?: number }): Promise<PaymentIntent[]> {
    const a = await this.db();
    const eq: Record<string, any> = {};
    if (filter?.status && filter.status !== 'all') eq.status = filter.status;
    if (filter?.userId) eq.user_id = filter.userId;
    return a.list<PaymentIntent>('payment_intents', { eq: Object.keys(eq).length ? eq : undefined, order: { column: 'created_at', ascending: false }, limit: filter?.limit || 100 });
  }

  async logWebhook(entry: { providerId: string; eventType?: string; externalId?: string; payload: any; processed: boolean; error?: string }): Promise<void> {
    const a = await this.db();
    try {
      await a.insert('payment_webhook_events', {
        id: uid('wh'),
        provider_id: entry.providerId,
        event_type: entry.eventType || null,
        external_id: entry.externalId || null,
        payload: entry.payload,
        processed: entry.processed,
        error: entry.error || null,
        created_at: nowIso(),
      });
    } catch (e) {
      console.warn('[billing] webhook log failed:', (e as any)?.message);
    }
  }

  async listWebhookEvents(limit = 50): Promise<any[]> {
    const a = await this.db();
    return a.list('payment_webhook_events', { order: { column: 'created_at', ascending: false }, limit });
  }

  /**
   * Fulfils a paid intent exactly once: credits balance / grants subscription /
   * delivers item and links the resulting transaction to the intent.
   */
  async fulfilIntent(intentId: string, ext: { externalId?: string | null; method?: string }): Promise<{ ok: boolean; already?: boolean; error?: string; intent?: PaymentIntent }> {
    const intent = await this.getIntent(intentId);
    if (!intent) return { ok: false, error: 'Intent not found' };
    if (intent.status === 'paid') return { ok: true, already: true, intent };
    if (!intent.user_id) return { ok: false, error: 'Intent has no user' };

    // Optimistic lock — move to 'processing' state via updated_at compare is not
    // available in the simple adapter, so we set status first and re-read.
    await this.updateIntent(intent.id, { status: 'paid', paid_at: nowIso(), external_id: ext.externalId || intent.external_id });
    const reread = await this.getIntent(intent.id);
    if (reread?.transaction_id) return { ok: true, already: true, intent: reread };

    const method = ext.method || (intent.provider_id === 'cryptobot' ? 'crypto' : intent.provider_id === 'manual' ? 'manual' : 'card');
    const cmdr = intent.cmdr_name || '';
    let txIdOut: string | null = null;
    try {
      if (intent.purpose === 'credit_topup') {
        const r = await this.topupBalance({ userId: intent.user_id, cmdrName: cmdr, amountCredits: intent.amount_credits, amountRub: num(intent.amount_rub), paymentMethod: method, providerId: intent.provider_id, externalId: ext.externalId || intent.external_id });
        txIdOut = r.transaction.id;
      } else if (intent.purpose === 'subscription' && intent.target_id) {
        const plan = await this.getPlanById(intent.target_id);
        const sub = await this.grantSubscription({
          userId: intent.user_id, cmdrName: cmdr, planId: intent.target_id, durationDays: plan?.period_days || 30,
          paymentMethod: method, providerId: intent.provider_id, externalId: ext.externalId || intent.external_id,
          amountRub: num(intent.amount_rub), transactionType: 'subscription', notes: `Оплачено через ${intent.provider_id}`,
          autoRenew: false,
        });
        await this.adjustBalance(intent.user_id, { spentRub: num(intent.amount_rub) });
        txIdOut = sub.id;
      } else if (intent.purpose === 'shop_purchase' && intent.target_id) {
        const r = await this.purchaseItem({ userId: intent.user_id, cmdrName: cmdr, itemId: intent.target_id, autoEquip: true, paid: { amountRub: num(intent.amount_rub), providerId: intent.provider_id || 'unknown', externalId: ext.externalId || intent.external_id || '', method } });
        if (!r.success) {
          // Item can't be delivered (already owned etc.) — convert to credits equivalent
          const item = await this.getShopItemById(intent.target_id);
          const credits = item?.price_credits || 0;
          const rr = await this.topupBalance({ userId: intent.user_id, cmdrName: cmdr, amountCredits: credits, amountRub: num(intent.amount_rub), paymentMethod: method, providerId: intent.provider_id, externalId: ext.externalId });
          txIdOut = rr.transaction.id;
        } else txIdOut = r.transaction!.id;
      }
    } catch (e: any) {
      await this.updateIntent(intent.id, { status: 'failed', metadata: { ...(intent.metadata || {}), fulfilError: e?.message } });
      return { ok: false, error: e?.message || 'Fulfilment failed' };
    }
    const done = await this.updateIntent(intent.id, { transaction_id: txIdOut });
    return { ok: true, intent: done || undefined };
  }

  // ───────────────────────── Statistics (real data) ─────────────────────────

  async getProjectStatistics(period: '7d' | '30d' | '90d' | '1y' | 'all' = '30d'): Promise<ProjectBillingStats> {
    const a = await this.db();
    const now = new Date();
    const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : period === '1y' ? 365 : 3650;
    const cutoff = new Date(now.getTime() - days * 86400000);
    const prevCutoff = new Date(cutoff.getTime() - days * 86400000);

    const [allTx, allSubs, plans, items, balances] = await Promise.all([
      a.list<BillingTransaction>('billing_transactions', { order: { column: 'created_at', ascending: false }, limit: 20000 }),
      a.list<UserSubscription>('user_subscriptions', { limit: 20000 }),
      this.getPlans(true),
      this.getShopItems({ includeInactive: true }),
      a.list<UserBalance>('user_balances', { limit: 20000 }),
    ]);
    const txs = allTx.map(normalizeTx);
    const completed = txs.filter((t) => t.status === 'completed');
    const inWindow = completed.filter((t) => new Date(t.created_at) >= cutoff);
    const inPrev = completed.filter((t) => new Date(t.created_at) >= prevCutoff && new Date(t.created_at) < cutoff);

    const activeSubs = allSubs.filter((s) => s.status === 'active' && (!s.expires_at || new Date(s.expires_at) > now));
    const activeSubsPrev = allSubs.filter((s) => new Date(s.started_at || s.created_at) < cutoff && (!s.expires_at || new Date(s.expires_at) > cutoff) && s.status !== 'canceled');
    const planOf = (id: string) => plans.find((p) => p.id === id);
    const mrr = activeSubs.reduce((sum, s) => {
      const p = planOf(s.plan_id);
      return sum + (p ? (p.price_rub * 30) / (p.period_days || 30) : 0);
    }, 0);
    const mrrPrev = activeSubsPrev.reduce((sum, s) => sum + (planOf(s.plan_id)?.price_rub || 0), 0);

    const rub = (list: BillingTransaction[]) => list.reduce((s, t) => s + num(t.amount_rub), 0);
    const grossRevenue = rub(inWindow);
    const grossPrev = rub(inPrev);
    const shopTx = inWindow.filter((t) => t.type === 'shop_purchase');
    const cosmeticsRevenue = rub(shopTx);
    const cosmeticsSoldTotal = shopTx.length;
    const payingUsers = new Set(inWindow.filter((t) => num(t.amount_rub) > 0).map((t) => t.user_id)).size;
    const arpu = payingUsers ? Math.round(grossRevenue / payingUsers) : 0;

    // churn = canceled/expired in window / active at start of window
    const churned = allSubs.filter((s) => (s.status === 'canceled' || s.status === 'expired') && new Date(s.updated_at || s.created_at) >= cutoff).length;
    const churnRate = activeSubsPrev.length ? Math.round((churned / activeSubsPrev.length) * 1000) / 10 : 0;

    const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0);

    // Timeline buckets
    const pointsCount = period === '7d' ? 7 : period === '30d' ? 15 : 12;
    const stepMs = (days * 86400000) / pointsCount;
    const revenueTimeline: ChartDataPoint[] = [];
    const pilotGrowth: PilotGrowthPoint[] = [];

    // profiles created_at for growth (best-effort)
    let profileDates: number[] = [];
    try {
      if (a.kind === 'supabase') {
        const rows = await a.list<{ created_at: string }>('profiles', { order: { column: 'created_at' }, limit: 50000 });
        profileDates = rows.map((r) => new Date(r.created_at).getTime()).filter(Number.isFinite);
      }
    } catch {
      profileDates = [];
    }
    if (!profileDates.length) profileDates = balances.map((b) => new Date(b.updated_at).getTime());

    for (let i = pointsCount - 1; i >= 0; i--) {
      const end = new Date(now.getTime() - i * stepMs);
      const start = new Date(end.getTime() - stepMs);
      const label = `${String(end.getDate()).padStart(2, '0')}.${String(end.getMonth() + 1).padStart(2, '0')}`;
      const slot = completed.filter((t) => {
        const ts = new Date(t.created_at);
        return ts >= start && ts < end;
      });
      const subRev = rub(slot.filter((t) => t.type === 'subscription'));
      const shopRev = rub(slot.filter((t) => t.type !== 'subscription'));
      revenueTimeline.push({ date: end.toISOString().slice(0, 10), label, subscriptions: Math.round(subRev), shop: Math.round(shopRev), total: Math.round(subRev + shopRev) });

      const totalPilots = profileDates.filter((d) => d <= end.getTime()).length;
      const activePilots = new Set(completed.filter((t) => new Date(t.created_at) >= new Date(end.getTime() - 30 * 86400000) && new Date(t.created_at) < end).map((t) => t.user_id)).size;
      const premiumPilots = allSubs.filter((s) => new Date(s.started_at || s.created_at) <= end && (!s.expires_at || new Date(s.expires_at) > end) && s.status !== 'canceled').length;
      pilotGrowth.push({ date: end.toISOString().slice(0, 10), label, totalPilots, activePilots, premiumPilots });
    }

    const tierDistribution: TierDistribution[] = plans.map((plan) => {
      const count = activeSubs.filter((s) => s.plan_id === plan.id).length;
      return {
        planId: plan.id,
        name: plan.name,
        count,
        percentage: activeSubs.length ? Math.round((count / activeSubs.length) * 100) : 0,
        mrrContribution: count * plan.price_rub,
        color: plan.color,
      };
    });

    const catMeta: Record<CosmeticCategory, { name: string; color: string }> = {
      frame: { name: 'Голографические рамки', color: '#a855f7' },
      skin: { name: 'HUD-темы интерфейса', color: '#e67e22' },
      glow: { name: 'Свечение позывного', color: '#38bdf8' },
      badge: { name: 'Знаки отличия', color: '#fbbf24' },
      title: { name: 'Почетные титулы', color: '#10b981' },
    };
    const shopAll = completed.filter((t) => t.type === 'shop_purchase');
    const categorySales: CategorySalesStat[] = CATEGORIES.map((c) => {
      const itemIds = new Set(items.filter((i) => i.category === c).map((i) => i.id));
      const list = shopAll.filter((t) => itemIds.has(t.item_or_plan_id) || t.metadata?.category === c);
      return { category: c, name: catMeta[c].name, color: catMeta[c].color, unitsSold: list.length, revenueRub: Math.round(rub(list)), percentage: 0 };
    });
    const totalUnits = categorySales.reduce((s, c) => s + c.unitsSold, 0) || 1;
    categorySales.forEach((c) => (c.percentage = Math.round((c.unitsSold / totalUnits) * 100)));

    // Funnel from real data
    let totalRegistered = profileDates.length;
    let activeExplorers = 0;
    try {
      if (a.kind === 'supabase') {
        totalRegistered = await a.count('profiles');
        const rows = await a.list<{ user_id: string }>('deliveries', { limit: 50000 });
        activeExplorers = new Set(rows.map((r) => r.user_id)).size;
      }
    } catch {
      /* ignore */
    }
    const shopVisitors = balances.length;
    const buyers = new Set(completed.filter((t) => t.type === 'shop_purchase' || t.type === 'credit_topup').map((t) => t.user_id)).size;
    const top = plans[plans.length - 1];
    const topSubs = top ? activeSubs.filter((s) => s.plan_id === top.id).length : 0;
    const f = (n: number) => (totalRegistered ? Math.round((n / totalRegistered) * 1000) / 10 : 0);
    const conversionFunnel: FunnelStep[] = [
      { step: 'Зарегистрированные пилоты', count: totalRegistered, percentage: totalRegistered ? 100 : 0, description: 'Создан профиль CMDR' },
      { step: 'Активные исследователи', count: activeExplorers, percentage: f(activeExplorers), description: 'Сдавали грузы (таблица deliveries)' },
      { step: 'Посетители магазина', count: shopVisitors, percentage: f(shopVisitors), description: 'Открыт счёт кредитов' },
      { step: 'Покупатели', count: buyers, percentage: f(buyers), description: 'Хотя бы одна покупка или пополнение' },
      { step: 'Премиум-подписчики', count: activeSubs.length, percentage: f(activeSubs.length), description: 'Действующая подписка' },
      { step: top ? `Уровень «${top.name}»` : 'Высший уровень', count: topSubs, percentage: f(topSubs), description: 'Высший тарифный план' },
    ];

    const spenders = new Map<string, { cmdrName: string; userId: string; totalSpentRub: number; purchasesCount: number }>();
    for (const t of completed) {
      if (!t.user_id) continue;
      const cur = spenders.get(t.user_id) || { cmdrName: t.cmdr_name || t.user_id.slice(0, 8), userId: t.user_id, totalSpentRub: 0, purchasesCount: 0 };
      cur.totalSpentRub += num(t.amount_rub);
      if (t.type !== 'admin_grant') cur.purchasesCount += 1;
      if (t.cmdr_name) cur.cmdrName = t.cmdr_name;
      spenders.set(t.user_id, cur);
    }
    const topSpenders = Array.from(spenders.values())
      .sort((x, y) => y.totalSpentRub - x.totalSpentRub)
      .slice(0, 5)
      .map((s) => {
        const sub = activeSubs.find((x) => x.user_id === s.userId);
        return { cmdrName: s.cmdrName, tier: sub ? planOf(sub.plan_id)?.badge_label || 'PREMIUM' : '—', totalSpentRub: Math.round(s.totalSpentRub), purchasesCount: s.purchasesCount };
      });

    // Telemetry: only real counters; unknown = 0 (routes may enrich further)
    const t0 = Date.now();
    let pendingIntents = 0;
    try {
      pendingIntents = await a.count('payment_intents', { eq: { status: 'pending' } });
    } catch {
      /* ignore */
    }
    const latency = Date.now() - t0;

    return {
      period,
      updatedAt: now.toISOString(),
      kpis: {
        mrr: Math.round(mrr),
        mrrDelta: pct(mrr, mrrPrev),
        grossRevenue: Math.round(grossRevenue),
        grossRevenueDelta: pct(grossRevenue, grossPrev),
        activeSubscribers: activeSubs.length,
        activeSubscribersDelta: pct(activeSubs.length, activeSubsPrev.length),
        arpu,
        churnRate,
        cosmeticsSoldTotal,
        cosmeticsRevenue: Math.round(cosmeticsRevenue),
        averageOrderValue: cosmeticsSoldTotal ? Math.round(cosmeticsRevenue / cosmeticsSoldTotal) : 0,
      },
      charts: { revenueTimeline, pilotGrowth, tierDistribution, categorySales, conversionFunnel },
      telemetry: {
        totalRegisteredPilots: totalRegistered,
        totalSystemsClaimed: 0,
        totalFacilitiesBuilt: 0,
        totalTonnageHauled: 0,
        journalEventsParsed: 0,
        supportTicketsOpen: 0,
        supportTicketsResolved: 0,
        apiTokensActive: 0,
        serverUptimePct: Math.round((process.uptime() / 3600) * 100) / 100, // hours of uptime of this node
        avgLatencyMs: latency,
        pendingPayments: pendingIntents,
        storageBackend: a.kind,
      } as ProjectBillingStats['telemetry'],
      recentTransactions: txs.slice(0, 15),
      topSpenders,
    };
  }
}

export interface PublicCosmeticItem {
  id: string;
  title: string;
  rarity: string;
  preview: Record<string, any>;
}
export interface PublicCosmetics {
  user_id: string;
  frame: PublicCosmeticItem | null;
  badge: PublicCosmeticItem | null;
  skin: PublicCosmeticItem | null;
  glow: PublicCosmeticItem | null;
  title: PublicCosmeticItem | null;
  tier: { id: string; label: string; color: string } | null;
}

function normalizePlan(p: BillingPlan): BillingPlan {
  return {
    ...p,
    perks: Array.isArray(p.perks) ? p.perks : [],
    price_rub: num(p.price_rub),
    price_credits: num(p.price_credits),
    period_days: num(p.period_days) || 30,
    display_order: num(p.display_order),
    discount_pct: num(p.discount_pct),
    is_active: p.is_active !== false,
  };
}

function normalizeItem(i: ShopItem): ShopItem {
  return {
    ...i,
    preview_data: i.preview_data || {},
    price_rub: num(i.price_rub),
    price_credits: num(i.price_credits),
    subscriber_discount_pct: num(i.subscriber_discount_pct),
    sales_count: num(i.sales_count),
    display_order: num(i.display_order),
    is_active: i.is_active !== false,
    is_featured: Boolean(i.is_featured),
  };
}

function normalizeTx(t: BillingTransaction): BillingTransaction {
  return { ...t, amount_rub: num(t.amount_rub), amount_credits: num(t.amount_credits), metadata: t.metadata || {} };
}

function stripJoins<T extends { plan?: any }>(s: T): Omit<T, 'plan'> {
  const { plan: _plan, ...rest } = s;
  return rest;
}

export function slugify(s: string): string {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  return s
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `item-${Date.now().toString(36)}`;
}

const globalForBilling = globalThis as unknown as { billingRepo?: BillingRepository };
export const billingRepo = globalForBilling.billingRepo || new BillingRepository();
globalForBilling.billingRepo = billingRepo;
