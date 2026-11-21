/**
 * Соответствие между типами кораблей из Frontier CAPI (shipType, например
 * `CobraMkIII`, `SideWinder`) и идентификаторами кораблей в справочнике
 * верфи (`public/data/outfitting.json`, например `cobra_mk_iii`, `sidewinder`).
 *
 * CAPI приносит символы FDev в CamelCase. В outfitting.json id — snake_case.
 * Некоторые совпадения не тривиальные (Cobra Mk V → `cobramkv`, Caspian Explorer →
 * `explorer_nx`), поэтому сопоставление задано вручную.
 */

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
  Type6: 'type6',
  Type7: 'type7',
  Type9: 'type9',
  Type10: 'type10',
  Orca: 'orca',
  FederalDropshipMkII: 'federal_dropship',
  ImperialCourier: 'imperial_courier',
  ImperialCutter: 'imperial_cutter',
  ImperialClipper: 'imperial_clipper',
  EmpireFighter: 'empire_fighter',
  EmpireFighterMkII: 'empire_fighter_mk_ii',
  EmpireFighterMkIII: 'empire_fighter_mk_iii',
  FerDeLance: 'fer_de_lance',
  Mamba: 'mamba',
  KraitMkII: 'krait_mk_ii',
  KraitPhantom: 'krait_phantom',
  Mantis: 'mantis',
  Azimuth: 'azimuth',
  Python: 'python',
  PythonMkII: 'python_mk_ii',
  Stingray: 'stingray',
  Tug: 'tug',
  Lynx: 'lynx',
  LynxHighliner: 'lynx_highliner',
  ExplorerNX: 'explorer_nx',
  BelugaLiner: 'beluga',
};

/** Превратить CAPI shipType в outfitting ship id. Если не найдено — вернуть как есть
 * (попытка поиска по имени в верфи всё равно может сработать). */
export function capiShipTypeToOutfittingId(shipType: string | null): string | null {
  if (!shipType) return null;
  const direct = CAPI_SHIP_TYPE_TO_OUTFITTING_ID[shipType];
  if (direct) return direct;

  // Fallback: CamelCase → snake_case (CobraMkIII → cobra_mk_iii).
  const snake = shipType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return snake;
}

/** URL картинки корабля из Supabase Storage bucket `ship-images`.
 * Если bucket ещё не развёрнут, возвращается пустая строка — компонент
 * покажет плейсхолдер с цветом по типу корабля.
 */
export function shipImageUrlFromStorage(shipId: string | null): string {
  if (!shipId) return '';
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return '';
  // Публичный объект Storage: /storage/v1/object/public/{bucket}/{object}
  return `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/ship-images/${shipId}.png`;
}
