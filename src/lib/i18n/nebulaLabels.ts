'use client';

/**
 * Типы туманностей: в справочнике `lib/galaxyNebulae` подписи русские (его
 * читают сервер и тесты), интерфейс переводит их по карте ключей.
 *
 * Названия самих туманностей остаются данными справочника: для русской локали
 * берётся поле `ru`, для остальных — международное имя объекта.
 */

export const NEBULA_KIND_KEYS: Record<string, string> = {
  emission: 'nebula.kindEmission',
  reflection: 'nebula.kindReflection',
  cluster: 'nebula.kindCluster',
  dark: 'nebula.kindDark',
  planetary: 'nebula.kindPlanetary',
  remnant: 'nebula.kindRemnant',
};
