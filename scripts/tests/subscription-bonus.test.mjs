/**
 * Бонусы от активной подписки — реальный функционал, а не только описание
 * в `perks`. Покрывает:
 *
 *  1. `getPlanBonus` — извлечение бонусов из тарифного плана (включая
 *     отсутствующие/старые поля → значения бесплатного уровня).
 *  2. `DEFAULT_BONUS` — бесплатный уровень: базовые лимиты, нулевые бонусы.
 *  3. `computeTopupBonus` — бонусные кредиты при пополнении баланса.
 *  4. `computeDeliveryTonnageBonus` — бонусный тонаж при сдаче груза.
 *  5. Набор бонусов по тарифам: Пионер / Элита / Флотоводец.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BONUS,
  getPlanBonus,
  computeTopupBonus,
  computeDeliveryTonnageBonus,
} from '../../src/lib/billing/subscriptionBonus.ts';
import { INITIAL_PLANS } from '../../src/lib/billing/catalogSeed.ts';

const pioneer = INITIAL_PLANS.find((p) => p.id === 'pioneer');
const elite = INITIAL_PLANS.find((p) => p.id === 'elite');
const admiral = INITIAL_PLANS.find((p) => p.id === 'admiral');

test('DEFAULT_BONUS — бесплатный уровень: базовые лимиты, нулевые бонусы', () => {
  assert.equal(DEFAULT_BONUS.planId, 'free');
  assert.equal(DEFAULT_BONUS.planName, 'Без подписки');
  assert.equal(DEFAULT_BONUS.atlasFavoritesLimit, 25);
  assert.equal(DEFAULT_BONUS.squadronMemberLimitBonus, 0);
  assert.equal(DEFAULT_BONUS.topupCreditBonusPct, 0);
  assert.equal(DEFAULT_BONUS.deliveryTonnageBonusPct, 0);
  assert.equal(DEFAULT_BONUS.shopDiscountPct, 0);
});

test('getPlanBonus(null) → DEFAULT_BONUS', () => {
  assert.deepEqual(getPlanBonus(null), DEFAULT_BONUS);
  assert.deepEqual(getPlanBonus(undefined), DEFAULT_BONUS);
});

test('Пионер: favorites 50, squadron +25, topup 5%, tonnage 5%, discount 25%', () => {
  assert.ok(pioneer, 'план pioneer есть в каталоге');
  const b = getPlanBonus(pioneer);
  assert.equal(b.planId, 'pioneer');
  assert.equal(b.planName, 'Пионер Кольца');
  assert.equal(b.atlasFavoritesLimit, 50);
  assert.equal(b.squadronMemberLimitBonus, 25);
  assert.equal(b.topupCreditBonusPct, 5);
  assert.equal(b.deliveryTonnageBonusPct, 5);
  assert.equal(b.shopDiscountPct, 25);
});

test('Элита: favorites 150, squadron +75, topup 10%, tonnage 10%, discount 50%', () => {
  assert.ok(elite, 'план elite есть в каталоге');
  const b = getPlanBonus(elite);
  assert.equal(b.planId, 'elite');
  assert.equal(b.atlasFavoritesLimit, 150);
  assert.equal(b.squadronMemberLimitBonus, 75);
  assert.equal(b.topupCreditBonusPct, 10);
  assert.equal(b.deliveryTonnageBonusPct, 10);
  assert.equal(b.shopDiscountPct, 50);
});

test('Флотоводец: favorites null (без限), squadron +200, topup 20%, tonnage 20%, discount 75%', () => {
  assert.ok(admiral, 'план admiral есть в каталоге');
  const b = getPlanBonus(admiral);
  assert.equal(b.planId, 'admiral');
  assert.equal(b.atlasFavoritesLimit, null);
  assert.equal(b.squadronMemberLimitBonus, 200);
  assert.equal(b.topupCreditBonusPct, 20);
  assert.equal(b.deliveryTonnageBonusPct, 20);
  assert.equal(b.shopDiscountPct, 75);
});

test('Старый план без бонусных полей → значения бесплатного уровня', () => {
  const oldPlan = {
    id: 'legacy',
    name: 'Старый тариф',
    color: '#999999',
    discount_pct: 10,
    // нет atlas_favorites_limit, squadron_member_limit_bonus и т.д.
  };
  const b = getPlanBonus(oldPlan);
  assert.equal(b.planId, 'legacy');
  assert.equal(b.atlasFavoritesLimit, null);
  assert.equal(b.squadronMemberLimitBonus, 0);
  assert.equal(b.topupCreditBonusPct, 0);
  assert.equal(b.deliveryTonnageBonusPct, 0);
  assert.equal(b.shopDiscountPct, 10);
});

test('computeTopupBonus — Пионер: +5% к 1000 кредитов = 50 бонус, итого 1050', () => {
  const b = getPlanBonus(pioneer);
  const r = computeTopupBonus(b, 1000);
  assert.equal(r.bonusCredits, 50);
  assert.equal(r.totalCredits, 1050);
});

test('computeTopupBonus — Флотоводец: +20% к 1000 кредитов = 200 бонус, итого 1200', () => {
  const b = getPlanBonus(admiral);
  const r = computeTopupBonus(b, 1000);
  assert.equal(r.bonusCredits, 200);
  assert.equal(r.totalCredits, 1200);
});

test('computeTopupBonus — бесплатный уровень: без бонуса', () => {
  const r = computeTopupBonus(DEFAULT_BONUS, 1000);
  assert.equal(r.bonusCredits, 0);
  assert.equal(r.totalCredits, 1000);
});

test('computeTopupBonus — ноль и отрицательные суммы', () => {
  const b = getPlanBonus(elite);
  assert.deepEqual(computeTopupBonus(b, 0), { bonusCredits: 0, totalCredits: 0 });
  assert.deepEqual(computeTopupBonus(b, -100), { bonusCredits: 0, totalCredits: 0 });
});

test('computeDeliveryTonnageBonus — Элита: +10% к 100 т = 10 т бонус, итого 110 т', () => {
  const b = getPlanBonus(elite);
  const r = computeDeliveryTonnageBonus(b, 100);
  assert.equal(r.bonusTons, 10);
  assert.equal(r.totalTons, 110);
});

test('computeDeliveryTonnageBonus — Флотоводец: +20% к 100 т = 20 т бонус, итого 120 т', () => {
  const b = getPlanBonus(admiral);
  const r = computeDeliveryTonnageBonus(b, 100);
  assert.equal(r.bonusTons, 20);
  assert.equal(r.totalTons, 120);
});

test('computeDeliveryTonnageBonus — бесплатный уровень: без бонуса', () => {
  const r = computeDeliveryTonnageBonus(DEFAULT_BONUS, 100);
  assert.equal(r.bonusTons, 0);
  assert.equal(r.totalTons, 100);
});
