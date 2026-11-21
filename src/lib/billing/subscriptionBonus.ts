/**
 * Бонусы от активной подписки — реальный функционал, а не только описание в
 * `perks`. Каждый активный тариф накладывает набор бонусов на пилота:
 *
 *   • лимит избранных систем в Атласе (`atlas_favorites_limit`)
 *   • добавка к лимиту участников эскадрильи (`squadron_member_limit_bonus`)
 *   • бонусный процент кредитов при пополнении баланса (`topup_credit_bonus_pct`)
 *   • бонусный процент тонажа при сдаче груза (`delivery_tonnage_bonus_pct`)
 *   • скидка в магазине (`discount_pct`, уже есть в BillingPlan)
 *
 * Бесплатный уровень (без подписки) — минимальные лимиты, без бонусов.
 */

import type { BillingPlan } from '@/types/billing';

export interface SubscriptionBonus {
  /** Идентификатор тарифа (или 'free' для бесплатного уровня). */
  planId: string;
  /** Название тарифа для отображения. */
  planName: string;
  /** Цвет тарифа (для UI). */
  color: string;
  /** Лимит избранных систем в Атласе. `null` — без ограничений. */
  atlasFavoritesLimit: number | null;
  /** Добавка к лимиту участников эскадрильи для эскадрилий, которые ведёт пилот. */
  squadronMemberLimitBonus: number;
  /** Бонусный процент кредитов при пополнении баланса (0..100). */
  topupCreditBonusPct: number;
  /** Бонусный процент тонажа при сдаче груза (0..100). */
  deliveryTonnageBonusPct: number;
  /** Скидка в Премиум-магазине (0..100). */
  shopDiscountPct: number;
}

/** Бесплатный уровень — базовые лимиты, без бонусов. */
export const DEFAULT_BONUS: SubscriptionBonus = {
  planId: 'free',
  planName: 'Без подписки',
  color: '#64748b',
  atlasFavoritesLimit: 25,
  squadronMemberLimitBonus: 0,
  topupCreditBonusPct: 0,
  deliveryTonnageBonusPct: 0,
  shopDiscountPct: 0,
};

/**
 * Собрать бонусный набор из тарифного плана. Поля Plans, отсутствующие в
 * БД (старые записи без бонусов), подменяются значениями бесплатного уровня.
 */
export function getPlanBonus(plan: BillingPlan | null | undefined): SubscriptionBonus {
  if (!plan) return DEFAULT_BONUS;
  return {
    planId: plan.id,
    planName: plan.name,
    color: plan.color || '#64748b',
    atlasFavoritesLimit: plan.atlas_favorites_limit ?? null,
    squadronMemberLimitBonus: Math.max(0, Math.round(Number(plan.squadron_member_limit_bonus) || 0)),
    topupCreditBonusPct: Math.min(100, Math.max(0, Math.round(Number(plan.topup_credit_bonus_pct) || 0))),
    deliveryTonnageBonusPct: Math.min(100, Math.max(0, Math.round(Number(plan.delivery_tonnage_bonus_pct) || 0))),
    shopDiscountPct: Math.min(100, Math.max(0, Math.round(Number(plan.discount_pct) || 0))),
  };
}

/**
 * Получить бонусы для пользователя по его активной подписке.
 * Возвращает `DEFAULT_BONUS`, если активной подписки нет.
 */
export async function getUserSubscriptionBonus(userId: string | null | undefined): Promise<SubscriptionBonus> {
  if (!userId) return DEFAULT_BONUS;
  const { billingRepo } = await import('@/lib/billingData');
  const sub = await billingRepo.getUserSubscription(userId);
  return getPlanBonus(sub?.plan ?? null);
}

/**
 * Эффективный лимит избранных систем в Атласе для пользователя.
 * `null` — без ограничений.
 */
export async function getAtlasFavoritesLimit(userId: string | null | undefined): Promise<number | null> {
  return (await getUserSubscriptionBonus(userId)).atlasFavoritesLimit;
}

/**
 * Эффективный лимит участников эскадрильи для пользователя (базовый лимит +
 * бонус от подписки).
 */
export async function getSquadronMemberLimit(userId: string | null | undefined): Promise<number> {
  const { SQUADRON_MEMBER_LIMIT } = await import('@/lib/squadronConstants');
  const bonus = await getUserSubscriptionBonus(userId);
  return SQUADRON_MEMBER_LIMIT + bonus.squadronMemberLimitBonus;
}

/**
 * Проверить, есть ли у пользователя перк «Фото Галерея кораблей»
 * (активная подписка с соответствующим perk в описании тарифа).
 */
export function hasShipPhotoGalleryPerk(bonus: SubscriptionBonus): boolean {
  return bonus.planId !== 'free';
}

/** Проверить перк для конкретного пользователя. */
export async function userHasShipPhotoGallery(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const bonus = await getUserSubscriptionBonus(userId);
  return hasShipPhotoGalleryPerk(bonus);
}

/**
 * Начислить бонусные кредиты к сумме пополнения.
 * Возвращает { bonusCredits, totalCredits }.
 */
export function computeTopupBonus(bonus: SubscriptionBonus, amountCredits: number): {
  bonusCredits: number;
  totalCredits: number;
} {
  const base = Math.max(0, Math.round(amountCredits));
  const bonusCredits = Math.round(base * (bonus.topupCreditBonusPct / 100));
  return { bonusCredits, totalCredits: base + bonusCredits };
}

/**
 * Начислить бонусный тонаж к сдаче груза.
 * Возвращает { bonusTons, totalTons }.
 */
export function computeDeliveryTonnageBonus(bonus: SubscriptionBonus, tons: number): {
  bonusTons: number;
  totalTons: number;
} {
  const base = Math.max(0, Math.round(tons));
  const bonusTons = Math.round(base * (bonus.deliveryTonnageBonusPct / 100));
  return { bonusTons, totalTons: base + bonusTons };
}
