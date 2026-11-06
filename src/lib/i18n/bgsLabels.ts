'use client';

/**
 * Подписи BGS для интерфейса: экономика, безопасность, настроение и форматы,
 * которые зависят от локали.
 *
 * Справочники (`lib/bgs`) держат канонический ключ → подпись по-русски: их
 * читают сервер, CSV и тесты, поэтому значения там не меняются. Здесь только
 * карты «канонический ключ → ключ перевода» и локалезависимые форматтеры.
 */

import { gameLabel, type TFn } from './gameLabels';

export const ECONOMY_KEYS: Record<string, string> = {
  Agriculture: 'bgs.econAgriculture',
  Extraction: 'bgs.econExtraction',
  HighTech: 'bgs.econHighTech',
  Industrial: 'bgs.econIndustrial',
  Military: 'bgs.econMilitary',
  Refinery: 'bgs.econRefinery',
  Service: 'bgs.econService',
  Terraforming: 'bgs.econTerraforming',
  Tourism: 'bgs.econTourism',
  Colony: 'bgs.econColony',
  Prison: 'bgs.econPrison',
  Damaged: 'bgs.econDamaged',
  Rescue: 'bgs.econRescue',
  Repair: 'bgs.econRepair',
  PrivateEnterprise: 'bgs.econPrivateEnterprise',
  Engineering: 'bgs.econEngineering',
  None: 'bgs.econNone',
};

export const SECURITY_KEYS: Record<string, string> = {
  High: 'bgs.secHigh',
  Medium: 'bgs.secMedium',
  Low: 'bgs.secLow',
  Anarchy: 'bgs.secAnarchy',
  Lawless: 'bgs.secLawless',
  None: 'bgs.secNone',
};

export const HAPPINESS_KEYS: Record<string, string> = {
  Elated: 'bgs.happyElated',
  Happy: 'bgs.happyHappy',
  Discontented: 'bgs.happyDiscontented',
  Unhappy: 'bgs.happyUnhappy',
  Despondent: 'bgs.happyDespondent',
};

/** Источники BGS: дамп EDSM, Helper, журнал на сайте, EDDN. */
export const BGS_SOURCE_KEYS: Record<string, string> = {
  edsm: 'bgs.source.edsm',
  helper: 'bgs.source.helper',
  web: 'bgs.source.web',
  eddn: 'bgs.source.eddn',
};

/** «Сельское хозяйство» → перевод; неизвестное значение — подпись справочника. */
export const bgsEconomyText = (t: TFn, value: string | null | undefined, fallback: string) =>
  gameLabel(t, ECONOMY_KEYS, value, fallback);

export const bgsSecurityText = (t: TFn, value: string | null | undefined, fallback: string) =>
  gameLabel(t, SECURITY_KEYS, value, fallback);

export const bgsHappinessText = (t: TFn, value: string | null | undefined, fallback: string) =>
  gameLabel(t, HAPPINESS_KEYS, value, fallback);

export const bgsSourceText = (t: TFn, value: string | null | undefined, fallback: string) =>
  gameLabel(t, BGS_SOURCE_KEYS, value, fallback);

/** «22,8 млрд» / «22.8 bn» — единицы из словаря, разделители по локали. */
export function formatPopulationText(t: TFn, locale: string, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  const units: Array<[number, string]> = [
    [1e9, t('card.popBillion')],
    [1e6, t('card.popMillion')],
    [1e3, t('card.popThousand')],
  ];
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled.toLocaleString(locale, { maximumFractionDigits: scaled >= 100 ? 0 : 1 })} ${unit}`;
    }
  }
  return Math.round(value).toLocaleString(locale);
}

/** «сегодня», «вчера», «5 дн. назад» — возраст наблюдения. */
export function bgsAgeText(t: TFn, observedAt: number | string | null | undefined, now = Date.now()): string {
  const ms = typeof observedAt === 'string' ? Date.parse(observedAt) : observedAt;
  if (ms == null || !Number.isFinite(ms)) return t('card.dateUnknown');
  const days = Math.floor(Math.max(0, now - ms) / 86_400_000);
  if (days === 0) return t('card.ageToday');
  if (days === 1) return t('card.ageYesterday');
  return t('card.ageDays', { count: days });
}
