/**
 * Подписи служб и правил стыковки авианосца.
 *
 * Файл отдельный от `fleetCarriers.ts` намеренно: там серверный учёт с
 * `node:crypto`, а подписи нужны браузеру — карточке носителя, списку
 * носителей в карточке системы и слою карты (`carrierCard.ts`,
 * `carrierMapView.ts`). Тянуть ради строки «Рынок товаров» криптографию в
 * клиентский бандл незачем, поэтому таблица живёт здесь, а `fleetCarriers.ts`
 * её реэкспортирует — старые импорты продолжают работать.
 *
 * Роли приходят из журнала (`CarrierCrewServices`), из списка служб станции
 * (`Docked`) и из реестра EDDN — всегда в нижнем регистре. Неизвестная роль
 * показывается как есть: лучше «autofit», чем пустое место.
 */

export const CARRIER_SERVICE_LABELS: Record<string, string> = {
  captain: 'Капитан',
  refuel: 'Заправка',
  repair: 'Ремонт',
  rearm: 'Перевооружение',
  commodities: 'Рынок товаров',
  blackmarket: 'Чёрный рынок',
  voucherredemption: 'Обмен ваучеров',
  exploration: 'Universal Cartographics',
  shipyard: 'Верфь',
  outfitting: 'Снаряжение',
  carrierfuel: 'Склад тритиума',
  vistagenomics: 'Vista Genomics',
  pioneersupplies: 'Pioneer Supplies',
  bartender: 'Бар',
  squadronbank: 'Банк эскадрильи',
  // Службы, которые приходят в списке станции (`Docked`) и в EDDN.
  autofit: 'Автоснаряжение',
  crewlounge: 'Комната экипажа',
  carriercommand: 'Управление носителем',
  contacts: 'Контакты',
  missions: 'Миссии',
  news: 'Новости',
  gallery: 'Галерея',
  social: 'Соцсеть',
  stationmenu: 'Меню станции',
  dock: 'Стыковка',
  livery: 'Окраска',
  storage: 'Хранилище',
  workshop: 'Мастерская',
  tuning: 'Тюнинг',
  engineer: 'Инженер',
};

/** Подпись службы носителя по роли. */
export function serviceLabel(role: string): string {
  return CARRIER_SERVICE_LABELS[role.toLowerCase()] ?? role;
}

/** Кого пускают на стыковку — как это пишет `CarrierDockingPermission`. */
export const DOCKING_LABELS: Record<string, string> = {
  all: 'все пилоты',
  none: 'никто',
  friends: 'только друзья',
  squadron: 'только эскадрилья',
  squadronfriends: 'эскадрилья и друзья',
};

export function dockingLabel(access: string | null | undefined): string | null {
  if (!access) return null;
  return DOCKING_LABELS[access.toLowerCase()] ?? access;
}

/**
 * Работает ли служба: у учёта сайта — `activated` и `enabled`, у EDDN — сам факт.
 *
 * Как в `CarrierCard`: служба не установлена (`activated: false`) — её нет,
 * установлена и выключена (`enabled: false`) — она на паузе. Работает только
 * когда включена и установлена. Отсутствующий флаг не мешает: старые записи
 * реестра знают лишь роль.
 */
export function carrierServiceActive(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (entry.activated === false || entry.enabled === false) return false;
  return entry.activated === true || entry.enabled === true;
}

/** Роль службы из строки любого источника: строка или объект с `role`. */
export function carrierServiceRole(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  const role = (value as Record<string, unknown>).role;
  return typeof role === 'string' ? role.trim() : '';
}
