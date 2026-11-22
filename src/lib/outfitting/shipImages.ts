/**
 * Соответствие между типами кораблей из Frontier CAPI (shipType, например
 * `CobraMkIII`, `SideWinder`) и идентификаторами кораблей в справочнике
 * верши (`public/data/outfitting.json`, например `cobra_mk_iii`, `sidewinder`).
 *
 * CAPI приносит символы FDev в CamelCase. В outfitting.json id — snake_case.
 * Некоторые совпадения не тривиальные (Cobra Mk V → `cobramkv`, Caspian Explorer →
 * `explorer_nx`), поэтому сопоставление задано вручную.
 *
 * shipId должны точно совпадать с ключами в public/data/outfitting.json,
 * потому что картинки в bucket ship-images хранятся под именами ${shipId}.png.
 */

import { getPublicStorageUrl } from '@/lib/supabaseUrl';

export type CapiShipType = string;

/** CAPI shipType → outfitting ship id. */
export const CAPI_SHIP_TYPE_TO_OUTFITTING_ID: Record<CapiShipType, string> = {
  SideWinder: 'sidewinder',
  Adder: 'adder',
  Hauler: 'hauler',
  Keelback: 'keelback',
  CobraMkIII: 'cobra_mk_iii',
  CobraMkIV: 'cobra_mk_iv',
  CobraMkV: 'cobramkv',
  DiamondBack: 'diamondback',
  DiamondBackXL: 'diamondback_explorer',
  Dolphin: 'dolphin',
  Eagle: 'eagle',
  Anaconda: 'anaconda',
  AnacondaMkII: 'anaconda_mk_ii',
  AspExplorer: 'asp',
  AspScout: 'asp_scout',
  FederalDropship: 'federal_dropship',
  FederalGunship: 'federal_gunship',
  FederalAssaultShip: 'federal_assault_ship',
  FederalCorvette: 'federal_corvette',
  AllianceChieftain: 'alliance_chieftain',
  AllianceCrusader: 'alliance_crusader',
  AllianceChallenger: 'alliance_challenger',
  Vulture: 'vulture',
  Viper: 'viper',
  ViperMkIV: 'viper_mk_iv',
  Type6: 'type_6_transporter',
  Type7: 'type_7_transport',
  Type8: 'type_8_transport',
  Type9: 'type_9_heavy',
  Type10: 'type_10_defender',
  Type11: 'type_11_prospector',
  Orca: 'orca',
  FederalDropshipMkII: 'federal_dropship',
  ImperialCourier: 'imperial_courier',
  ImperialCutter: 'imperial_cutter',
  ImperialClipper: 'imperial_clipper',
  ImperialCorsair: 'imperial_corsair',
  ImperialEagle: 'imperial_eagle',
  FerDeLance: 'fer_de_lance',
  Mamba: 'mamba',
  KraitMkII: 'krait_mkii',
  KraitPhantom: 'krait_phantom',
  Python: 'python',
  PythonMkII: 'python_nx',
  LynxHighliner: 'lynx_highliner',
  ExplorerNX: 'explorer_nx',
  BelugaLiner: 'beluga',
  Kestrel: 'kestrel',
  Mandalay: 'mandalay',
};

/** Превратить CAPI shipType в outfitting ship id. Если не найдено — вернуть как есть
 * (попытка поиска по имени в верши всё равно может сработать). */
export function capiShipTypeToOutfittingId(shipType: string | null): string | null {
  if (!shipType) return null;
  const direct = CAPI_SHIP_TYPE_TO_OUTFITTING_ID[shipType];
  if (direct) return direct;

  // Fallback 1: CamelCase → snake_case (CobraMkIII → cobra_mk_iii).
  const snake = shipType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

  // Fallback 2: тот же snake_case, но без подчёркиваний (panther_mk_ii → panthermkii),
  // чтобы совпадало с shipId вроде panthermkii, krait_mkii.
  const noUnderscore = snake.replace(/_/g, '');

  return noUnderscore;
}

/** URL картинки корабля из Supabase Storage bucket `ship-images`.
 * Если bucket ещё не развёрнут, возвращается пустая строка — компонент
 * покажет плейсхолдер с цветом по типу корабля.
 *
 * Относительный URL (без origin) — браузер сам подставит текущий origin,
 * поэтому это всегда работает, независимо от настроек сервера.
 */
export function shipImageUrlFromStorage(shipId: string | null): string {
  if (!shipId) return '';
  return `/api/supabase/storage/v1/object/public/ship-images/${shipId}.png`;
}
