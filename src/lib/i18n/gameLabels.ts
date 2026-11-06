'use client';

/**
 * Подписи игровых справочников для интерфейса.
 *
 * Справочники (`lib/bgs`) держат канонический ключ → подпись по-русски: их
 * импортируют и сервер (CSV, API), и тесты, поэтому менять их значения нельзя.
 * Интерфейс переводит подпись через словарь: здесь лежит только карта
 * «канонический ключ → ключ перевода». Неизвестное значение (новая
 * принадлежность из свежего дампа) остаётся подписью из справочника.
 */

export type TFn = (key: string, params?: Record<string, string | number>) => string;

export const ALLEGIANCE_KEYS: Record<string, string> = {
  Federation: 'bgs.allegianceFederation',
  Empire: 'bgs.allegianceEmpire',
  Alliance: 'bgs.allegianceAlliance',
  Independent: 'bgs.allegianceIndependent',
  Thargoid: 'bgs.allegianceThargoid',
  Guardian: 'bgs.allegianceGuardian',
  PilotsFederation: 'bgs.allegiancePilotsFederation',
  None: 'bgs.allegianceNone',
};

export const GOVERNMENT_KEYS: Record<string, string> = {
  Anarchy: 'bgs.govAnarchy',
  Communism: 'bgs.govCommunism',
  Confederacy: 'bgs.govConfederacy',
  Cooperative: 'bgs.govCooperative',
  Corporate: 'bgs.govCorporate',
  Democracy: 'bgs.govDemocracy',
  Dictatorship: 'bgs.govDictatorship',
  Feudal: 'bgs.govFeudal',
  Patronage: 'bgs.govPatronage',
  PrisonColony: 'bgs.govPrisonColony',
  Theocracy: 'bgs.govTheocracy',
  Engineer: 'bgs.govEngineer',
  Prison: 'bgs.govPrison',
  PrivateOwnership: 'bgs.govPrivateOwnership',
  None: 'bgs.govNone',
};

export const STATE_KEYS: Record<string, string> = {
  None: 'bgs.stateNone',
  Boom: 'bgs.stateBoom',
  Bust: 'bgs.stateBust',
  CivilUnrest: 'bgs.stateCivilUnrest',
  CivilWar: 'bgs.stateCivilWar',
  Election: 'bgs.stateElection',
  Expansion: 'bgs.stateExpansion',
  Famine: 'bgs.stateFamine',
  Investment: 'bgs.stateInvestment',
  Lockdown: 'bgs.stateLockdown',
  Outbreak: 'bgs.stateOutbreak',
  Retreat: 'bgs.stateRetreat',
  War: 'bgs.stateWar',
  CivilLiberty: 'bgs.stateCivilLiberty',
  PirateAttack: 'bgs.statePirateAttack',
  PublicHoliday: 'bgs.statePublicHoliday',
  Terrorism: 'bgs.stateTerrorism',
  NaturalDisaster: 'bgs.stateNaturalDisaster',
  InfrastructureFailure: 'bgs.stateInfrastructureFailure',
  Blight: 'bgs.stateBlight',
  Drought: 'bgs.stateDrought',
  ColdWar: 'bgs.stateColdWar',
  TradeWar: 'bgs.stateTradeWar',
  Revolution: 'bgs.stateRevolution',
};

/** Подпись по каноническому ключу; неизвестное значение — как в справочнике. */
export function gameLabel(
  t: TFn,
  map: Record<string, string>,
  value: string | null | undefined,
  fallback: string,
): string {
  const key = value ? map[value] : undefined;
  return key ? t(key) : fallback;
}
