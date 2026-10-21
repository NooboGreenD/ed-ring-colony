/** Shared, side-effect-free catalogue editing rules (API, admin UI and tests). */
import type { Bulkhead, OutfittingData, OutfittingModule, OutfittingShip } from './types';
import { MODULE_SPECS } from './specs';

export type CatalogKind = 'module' | 'group' | 'bulkhead' | 'ship';
export type CatalogGroup = OutfittingData['groups'][string];
export type CatalogValue = OutfittingModule | CatalogGroup | Bulkhead | OutfittingShip;
export type CatalogAction = 'create' | 'update' | 'delete' | 'restore' | 'reset';

export interface CatalogChange {
  kind: CatalogKind;
  key: string;
  value: CatalogValue;
  deleted: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface CatalogHistoryEntry {
  action: CatalogAction;
  kind: CatalogKind;
  key: string;
  label: string;
  at: string;
  actor: string;
}

export interface CatalogState {
  revision: number;
  changes: Record<string, CatalogChange>;
  history: CatalogHistoryEntry[];
  updatedAt: string | null;
}

export interface CatalogSnapshot {
  data: OutfittingData;
  revision: number;
  changes: (CatalogChange & { fromSource: boolean })[];
  history: CatalogHistoryEntry[];
  updatedAt: string | null;
  storage: 'supabase' | 'local' | 'source';
}

export interface CatalogCommand {
  action: CatalogAction;
  kind: CatalogKind;
  key: string;
  value?: CatalogValue;
}

export const CATALOG_CATEGORIES = {
  core: 'Основные модули',
  internal: 'Внутренние модули',
  hardpoint: 'Вооружение',
  utility: 'Вспомогательные',
} as const;

/**
 * Крепление орудия в админке: буквы — как в игровых символах модулей
 * (`Hpt_…_Fixed_…` / `_Gimbal_` / `_Turret_`, см. `fdnames.ts`). Таблица и
 * редактор берут подписи только отсюда; подписи публичной верфи на всех языках —
 * `MOUNT_NAMES` (`i18n.ts`), тест `outfitting-catalog` сверяет обе таблицы.
 */
export const CATALOG_MOUNTS = {
  F: { title: 'фиксированное', short: 'Фикс.' },
  G: { title: 'наводящееся', short: 'Навод.' },
  T: { title: 'турель', short: 'Турель' },
} as const;
export type CatalogMount = keyof typeof CATALOG_MOUNTS;

// These groups are tied to fixed core/planetary slots by the calculator.
export const PROTECTED_GROUPS = ['pp', 't', 'fsd', 'ls', 'pd', 's', 'ft', 'pas'];
export const EMPTY_CATALOG_STATE: CatalogState = { revision: 0, changes: {}, history: [], updatedAt: null };
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_GROUP = /^[a-z][a-z0-9_-]{0,31}$/;
const SAFE_SHIP = /^[a-z][a-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NUMBER_FIELDS = new Set([...MODULE_SPECS.map((spec) => spec.key),
  'passive', 'coins', 'minmulspeed', 'minmulrotation', 'minmulacceleration',
  'maxmulspeed', 'maxmulrotation', 'maxmulacceleration', 'eps', 'hps']);

export class CatalogError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = 'CatalogError';
  }
}

function check(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new CatalogError(message, status);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reject prototype pollution, non-finite numbers and unbounded nested JSON. */
function validateJson(value: unknown, depth = 0): void {
  check(depth <= 8, 'Слишком большая вложенность параметров');
  if (typeof value === 'number') check(Number.isFinite(value), 'Числа должны быть конечными');
  else if (typeof value === 'string') check(value.length <= 4000, 'Текст параметра длиннее 4000 символов');
  else if (Array.isArray(value)) {
    check(value.length <= 100, 'Слишком много элементов параметра');
    value.forEach((entry) => validateJson(entry, depth + 1));
  } else if (isRecord(value)) {
    check(Object.keys(value).length <= 200, 'Слишком много полей');
    for (const [key, entry] of Object.entries(value)) {
      check(!FORBIDDEN_KEYS.has(key), `Недопустимое имя поля: ${key}`);
      check(key.length <= 64, 'Имя поля длиннее 64 символов');
      validateJson(entry, depth + 1);
    }
  } else check(value === null || typeof value === 'boolean', 'Недопустимый тип параметра');
}

function text(value: unknown, label: string, max: number, required = true): string {
  check(typeof value === 'string', `${label}: ожидается текст`);
  const trimmed = value.trim();
  check((!required || trimmed.length > 0) && trimmed.length <= max, `${label}: от 1 до ${max} символов`);
  return trimmed;
}

function number(value: unknown, label: string, nonnegative = false): void {
  check(typeof value === 'number' && Number.isFinite(value), `${label}: ожидается число`);
  if (nonnegative) check(value >= 0, `${label}: значение не может быть отрицательным`);
}

function numericMap(value: unknown, label: string): void {
  check(isRecord(value), `${label}: ожидается объект с числовыми значениями`);
  Object.values(value).forEach((entry) => number(entry, label));
}

/** Key order is not significant in JSON (notably for the armour copied into a ship edit). */
function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((entry, index) => sameJson(entry, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    return isRecord(left) && isRecord(right) && Object.keys(left).length === Object.keys(right).length
      && Object.entries(left).every(([key, entry]) => Object.hasOwn(right, key) && sameJson(entry, right[key]));
  }
  return left === right;
}

/** Hull shape is used by both the stock builder and saved build links. */
function validateShip(key: string, value: Record<string, unknown>, data: OutfittingData): OutfittingShip {
  check(SAFE_SHIP.test(key) && !FORBIDDEN_KEYS.has(key), 'ID корабля: строчные латинские буквы, цифры, _ или -');
  check(value.id === key, 'ID корабля нельзя менять: он используется в сохранённых сборках');
  delete value.archived; // Only delete/restore commands control availability.

  const props = value.properties;
  check(isRecord(props), 'Характеристики корабля: ожидается объект');
  props.name = text(props.name, 'Название корабля', 160);
  props.manufacturer = text(props.manufacturer, 'Производитель', 120);
  check(Number.isInteger(props.class) && Number(props.class) >= 1 && Number(props.class) <= 3, 'Размер корабля: 1, 2 или 3');
  for (const field of ['hullCost', 'speed', 'boost', 'boostEnergy', 'baseShieldStrength', 'baseArmour',
    'hardness', 'hullMass', 'reserveFuelCapacity']) {
    number(props[field], field, true);
  }
  for (const field of ['heatCapacity', 'masslock', 'pipSpeed']) {
    if (props[field] !== null) number(props[field], field, true);
  }
  check(Number(props.hullMass) > 0 && (props.pipSpeed === null || Number(props.pipSpeed) > 0), 'Масса корпуса и скорость распределителя должны быть больше нуля');
  check(Number.isInteger(props.crew) && Number(props.crew) >= 1 && Number(props.crew) <= 16, 'Экипаж: целое число от 1 до 16');
  for (const field of ['minthrust', 'boostInt', 'pitch', 'roll', 'yaw']) {
    if (props[field] !== undefined) number(props[field], field, true);
  }
  for (const field of ['fighterHangars', 'luxuryCabins']) {
    if (props[field] !== undefined) check(typeof props[field] === 'boolean', `${field}: ожидается переключатель`);
  }
  number(value.retailCost, 'Стоимость покупки', true);

  check(isRecord(value.slots) && isRecord(value.defaults), 'Укажите слоты и заводскую комплектацию');
  const slots = value.slots, defaults = value.defaults;
  for (const section of ['standard', 'hardpoints', 'internal'] as const) {
    const list = slots[section], stock = defaults[section];
    check(Array.isArray(list) && Array.isArray(stock), `${section}: ожидаются списки слотов и заводских модулей`);
    check(list.length <= (section === 'standard' ? 7 : 64) && (section !== 'standard' || list.length === 7),
      'Основных слотов должно быть 7, остальных — не более 64');
    // Upstream has a few ships with missing trailing defaults (and one with
    // unused extras). Keep existing data editable, but don't permit new extras.
    const existingStockLength = data.ships[key]?.defaults[section]?.length ?? 0;
    check(section === 'standard' ? stock.length === 7 : stock.length <= Math.max(list.length, existingStockLength),
      `${section}: число заводских модулей превышает число слотов`);
    list.forEach((slot, index) => {
      const label = `${section}[${index}]`;
      check(section !== 'standard' || typeof slot === 'number', `${label}: основной слот должен быть числом`);
      const size = isRecord(slot) ? slot.class : slot;
      check(Number.isInteger(size) && Number(size) >= (section === 'hardpoints' ? 0 : 1)
        && Number(size) <= (section === 'hardpoints' ? 4 : 8), `${label}: недопустимый размер слота`);
      if (isRecord(slot)) {
        if (slot.archived !== undefined) {
          check(typeof slot.archived === 'boolean', `${label}: archived должен быть переключателем`);
          if (!slot.archived) delete slot.archived;
        }
        if (slot.name !== undefined) slot.name = text(slot.name, `${label}: назначение`, 80);
        if (slot.eligible !== undefined) {
          check(isRecord(slot.eligible) && Object.keys(slot.eligible).length > 0, `${label}: укажите допустимые группы`);
          for (const [group, allowed] of Object.entries(slot.eligible)) {
            check(SAFE_GROUP.test(group) && !!data.groups[group], `${label}: группа ${group} не найдена`);
            const category = data.groups[group].category;
            check(section === 'hardpoints' ? category === 'hardpoint' || category === 'utility'
              : category === 'internal' || group === 'ft', `${label}: группа ${group} не подходит для этого слота`);
            number(allowed, `${label}: ${group}`, true);
            check(Number(allowed) > 0, `${label}: разрешение группы должно быть больше нуля`);
          }
        }
      }
    });
    stock.forEach((entry, index) => {
      check((typeof entry === 'string' && entry.length <= 64 && !/[\x00-\x1f]/.test(entry))
        || (Number.isSafeInteger(entry) && Number(entry) >= 0), `${section}[${index}]: укажите ID модуля, класс+рейтинг или пустое значение`);
    });
  }

  check(Array.isArray(value.bulkheads) && value.bulkheads.length > 0, 'У корабля должна быть базовая броня');
  const ids = new Set<string>();
  value.bulkheads.forEach((entry, index) => {
    check(isRecord(entry) && typeof entry.id === 'string' && SAFE_ID.test(entry.id) && !ids.has(entry.id), 'Повторяющийся или некорректный ID брони');
    ids.add(entry.id);
    check(entry.grp === 'bh', 'Группа брони должна быть bh');
    entry.name = text(entry.name, 'Название брони', 160);
    for (const field of ['mass', 'cost', 'hullboost', 'kinres', 'thermres', 'explres']) {
      number(entry[field], field, field === 'mass' || field === 'cost');
    }
    if (entry.causres !== undefined) number(entry.causres, 'causres');
    if (entry.archived !== undefined) check(typeof entry.archived === 'boolean', 'archived: ожидается переключатель');
    if (index === 0) check(entry.archived !== true, 'Базовую броню корабля нельзя архивировать');
  });
  return value as unknown as OutfittingShip;
}

export function changeId(kind: CatalogKind, key: string): string {
  return `${kind}/${key}`;
}

function splitKey(key: string): [string, string] {
  const parts = key.split(':');
  check(parts.length === 2 && SAFE_GROUP.test(parts[0]) && !FORBIDDEN_KEYS.has(parts[0]) && SAFE_ID.test(parts[1]), 'Некорректный ключ записи');
  return [parts[0], parts[1]];
}

export function sourceValue(base: OutfittingData, kind: CatalogKind, key: string): CatalogValue | undefined {
  if (kind === 'group') return Object.hasOwn(base.groups, key) ? base.groups[key] : undefined;
  if (kind === 'ship') return Object.hasOwn(base.ships, key) ? base.ships[key] : undefined;
  const [owner, id] = splitKey(key);
  if (kind === 'module') return base.modules[owner]?.find((module) => module.id === id);
  return base.ships[owner]?.bulkheads.find((bulkhead) => bulkhead.id === id);
}

export function catalogValue(data: OutfittingData, kind: CatalogKind, key: string): CatalogValue | undefined {
  return sourceValue(data, kind, key);
}

/** Base data is never mutated. Tombstones survive upstream catalogue rebuilds. */
export function mergeCatalog(base: OutfittingData, state: CatalogState): OutfittingData {
  const data = structuredClone(base);
  for (const change of Object.values(state.changes).filter((entry) => entry.kind === 'group')) {
    if (change.deleted) {
      delete data.groups[change.key];
      delete data.modules[change.key];
    } else {
      const group = change.value as CatalogGroup;
      data.groups[change.key] = { ...group, customName: group.name !== base.groups[change.key]?.name };
      data.modules[change.key] ??= [];
    }
  }
  for (const change of Object.values(state.changes).filter((entry) => entry.kind === 'module')) {
    const [group, id] = splitKey(change.key);
    if (!data.groups[group]) continue;
    const modules = data.modules[group] ??= [];
    const index = modules.findIndex((module) => module.id === id);
    if (change.deleted) {
      if (index >= 0) modules.splice(index, 1);
    } else if (index >= 0) modules[index] = structuredClone(change.value as OutfittingModule);
    else modules.push(structuredClone(change.value as OutfittingModule));
  }
  for (const change of Object.values(state.changes).filter((entry) => entry.kind === 'ship')) {
    // Keep archived ships addressable by saved builds; the selector hides them.
    const ship = structuredClone(change.value as OutfittingShip);
    // Ship edits never freeze source armour or absorb independent armour edits.
    // They are applied below, after the hull, so reset/restore work separately.
    if (Object.hasOwn(base.ships, change.key)) ship.bulkheads = structuredClone(base.ships[change.key].bulkheads);
    delete ship.archived;
    if (change.deleted) ship.archived = true;
    data.ships[change.key] = ship;
  }
  for (const change of Object.values(state.changes).filter((entry) => entry.kind === 'bulkhead')) {
    const [ship, id] = splitKey(change.key);
    const bulkheads = data.ships[ship]?.bulkheads;
    if (!bulkheads) continue;
    const index = bulkheads.findIndex((bulkhead) => bulkhead.id === id);
    // Builds store the armour's ARRAY INDEX. Never splice/reorder it, even when
    // archiving custom armour: old build links must keep their original armour.
    const value = { ...(change.value as Bulkhead), archived: change.deleted };
    if (index >= 0) bulkheads[index] = value;
    else bulkheads.push(value);
  }
  data.catalogRevision = state.revision;
  return data;
}

export function validateCatalogValue(kind: CatalogKind, key: string, input: unknown, data: OutfittingData): CatalogValue {
  check(isRecord(input), 'Не переданы данные записи');
  validateJson(input);
  const value = structuredClone(input);
  if (kind === 'group') {
    check(SAFE_GROUP.test(key) && key !== 'bh' && !FORBIDDEN_KEYS.has(key), 'Код группы: латинские буквы, цифры, _ или -');
    value.name = text(value.name, 'Название группы', 120);
    if (value.short !== undefined) value.short = text(value.short, 'Короткое название', 40, false);
    check(typeof value.category === 'string' && Object.hasOwn(CATALOG_CATEGORIES, value.category), 'Неизвестная категория');
    // customName is derived by the server, not trusted from the request.
    return { name: value.name, category: value.category, ...(value.short ? { short: value.short } : {}) } as CatalogGroup;
  }
  if (kind === 'ship') return validateShip(key, value, data);
  const [owner, id] = splitKey(key);
  check(value.id === id, 'ID записи нельзя менять: он используется в сохранённых сборках');
  if (kind === 'bulkhead') {
    check(data.ships[owner], 'Корабль не найден', 404);
    check(value.grp === 'bh', 'Группа брони должна быть bh');
    value.name = text(value.name, 'Название брони', 160);
    for (const field of ['mass', 'cost', 'hullboost', 'kinres', 'thermres', 'explres']) {
      number(value[field], field, field === 'mass' || field === 'cost');
    }
    if (value.causres !== undefined) number(value.causres, 'causres');
    delete value.archived;
    return value as unknown as Bulkhead;
  }
  check(data.groups[owner], 'Группа не найдена', 404);
  check(value.grp === owner, 'Группу существующего модуля нельзя менять: создайте копию');
  check(Number.isInteger(value.class) && Number(value.class) >= 0 && Number(value.class) <= 8, 'Класс должен быть целым числом от 0 до 8');
  check(typeof value.rating === 'string' && /^[A-Z]$/.test(value.rating), 'Рейтинг: одна заглавная латинская буква');
  if (value.name !== undefined) value.name = text(value.name, 'Название модуля', 160, false);
  if (value.mount !== undefined) check(Object.hasOwn(CATALOG_MOUNTS, String(value.mount)), 'Крепление: F, G или T');
  if (value.ships !== undefined) {
    check(Array.isArray(value.ships) && value.ships.length > 0 && value.ships.every((ship) => typeof ship === 'string'), 'ships: ожидается непустой список ID кораблей');
    check(new Set(value.ships).size === value.ships.length, 'ships: повторяющийся ID корабля');
    check(value.ships.every((ship) => SAFE_SHIP.test(ship) && Object.hasOwn(data.ships, ship)), 'ships: неизвестный ID корабля');
  }
  for (const [field, entry] of Object.entries(value)) {
    if (NUMBER_FIELDS.has(field)) number(entry, field, ['mass', 'cost', 'power', 'integrity', 'coins'].includes(field));
  }
  if (value.fireint !== undefined) check(Number(value.fireint) > 0, 'Интервал выстрела должен быть больше нуля');
  for (const field of ['merc', 'experimental']) {
    if (value[field] !== undefined) check(typeof value[field] === 'boolean', `${field}: ожидается переключатель`);
  }
  for (const field of ['info', 'pp', 'sourceName', 'ship', 'type', 'special', 'restriction', 'missile', 'factoryNote', 'powerplay', 'rechargerating']) {
    if (value[field] !== undefined) check(typeof value[field] === 'string', `${field}: ожидается текст`);
  }
  if (value.damagedist !== undefined) numericMap(value.damagedist, 'damagedist');
  if (value.requirements !== undefined) {
    check(isRecord(value.requirements), 'requirements: ожидается объект');
    check(Object.values(value.requirements).every((entry) => typeof entry === 'number' || typeof entry === 'boolean'), 'requirements: ожидаются числа или переключатели');
  }
  if (value.preEngineered !== undefined) {
    const factory = value.preEngineered;
    check(isRecord(factory), 'Заводская настройка: ожидается объект');
    for (const field of ['reengineerable', 'gradeChangeable', 'canApplyExperimental', 'approx']) {
      if (factory[field] !== undefined) check(typeof factory[field] === 'boolean', `preEngineered.${field}: ожидается переключатель`);
    }
    if (factory.grade !== undefined) check(Number.isInteger(factory.grade) && Number(factory.grade) >= 1 && Number(factory.grade) <= 5, 'Уровень заводской настройки: от 1 до 5');
    for (const field of ['blueprints', 'experimentalEffects']) {
      if (factory[field] === undefined) continue;
      const entries = factory[field];
      check(Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'), `${field}: ожидается список кодов`);
      const index = field === 'blueprints' ? data.blueprints : data.specials;
      check(entries.every((entry) => Object.hasOwn(index, entry)), `${field}: неизвестный чертёж или эффект`);
    }
    if (factory.features !== undefined) numericMap(factory.features, 'Заводские модификаторы');
    for (const field of ['description', 'availability', 'recipe']) {
      if (factory[field] !== undefined) check(typeof factory[field] === 'string', `preEngineered.${field}: ожидается текст`);
    }
  }
  return value as unknown as OutfittingModule;
}

export function parseCatalogCommands(input: unknown): { revision: number; commands: CatalogCommand[] } {
  check(isRecord(input), 'Некорректный запрос');
  check(Number.isSafeInteger(input.revision) && Number(input.revision) >= 0, 'Не указана версия каталога. Обновите страницу');
  check(Array.isArray(input.commands) && input.commands.length > 0 && input.commands.length <= 100, 'Допускается от 1 до 100 операций за запрос');
  const commands = input.commands.map((command) => {
    check(isRecord(command), 'Некорректная операция');
    check(['module', 'group', 'bulkhead', 'ship'].includes(String(command.kind)), 'Неизвестный вид записи');
    check(['create', 'update', 'delete', 'restore', 'reset'].includes(String(command.action)), 'Неизвестная операция');
    check(typeof command.key === 'string' && command.key.length <= 100, 'Не указан ключ записи');
    if (command.kind === 'group') check(SAFE_GROUP.test(command.key) && !FORBIDDEN_KEYS.has(command.key) && command.key !== 'bh', 'Некорректный код группы');
    else if (command.kind === 'ship') check(SAFE_SHIP.test(command.key) && !FORBIDDEN_KEYS.has(command.key), 'Некорректный ID корабля');
    else splitKey(command.key);
    return { action: command.action, kind: command.kind, key: command.key, value: command.value } as CatalogCommand;
  });
  return { revision: Number(input.revision), commands };
}

export function groupDeletionReason(data: OutfittingData, key: string): string | null {
  if (PROTECTED_GROUPS.includes(key)) return 'Группа связана с обязательными слотами кораблей';
  if (data.modules[key]?.length) return 'Сначала удалите все модули этой группы';
  if (data.moduleBlueprints[key]) return 'Группа связана с инженерными чертежами';
  if (Object.values(data.ships).some((ship) => [...ship.slots.hardpoints, ...ship.slots.internal]
    .some((slot) => isRecord(slot) && isRecord(slot.eligible) && Object.hasOwn(slot.eligible, key)))) {
    return 'Группа используется особыми слотами кораблей';
  }
  return null;
}

/** Apply a whole batch to a private copy; any invalid operation aborts it all. */
export function applyCatalogCommands(
  base: OutfittingData,
  current: CatalogState,
  commands: CatalogCommand[],
  actor: string,
  at = new Date().toISOString(),
): CatalogState {
  const state = structuredClone(current);
  for (const command of commands) {
    const { kind, key, action } = command;
    const id = changeId(kind, key);
    const data = mergeCatalog(base, state);
    const previous = state.changes[id];
    const original = sourceValue(base, kind, key);
    const existing = catalogValue(data, kind, key);
    const active = existing && !previous?.deleted;
    let value: CatalogValue;
    if (action === 'create' || action === 'update') {
      check(action === 'create' ? !existing && !previous && !original : active, action === 'create' ? 'Такой ID уже существует, в том числе в архиве' : 'Запись не найдена', action === 'create' ? 409 : 404);
      value = validateCatalogValue(kind, key, command.value, data);
      if (kind === 'ship' && action === 'update') {
        const ship = existing as OutfittingShip;
        const edited = value as OutfittingShip;
        check(sameJson(edited.bulkheads, ship.bulkheads), 'Броню изменяйте в разделе «Броня». Сначала обновите каталог', 409);
        for (const section of ['standard', 'hardpoints', 'internal'] as const) {
          check(edited.slots[section].length >= ship.slots[section].length,
            'Для удаления сохранённого слота используйте архивирование: его индекс нужен старым сборкам', 409);
          if (section === 'standard') continue;
          ship.slots[section].forEach((slot, index) => {
            const next = edited.slots[section][index];
            if (typeof next !== 'number' && next.archived) {
              // The original size/restrictions still describe modules in old build links.
              const preserved = typeof slot === 'number' ? { class: slot, archived: true } : { ...slot, archived: true };
              check(sameJson(next, preserved), `${section}[${index}]: удалённый слот нельзя менять — сначала восстановите его`, 409);
            }
          });
        }
        edited.bulkheads = structuredClone((previous?.value as OutfittingShip | undefined)?.bulkheads
          ?? (original as OutfittingShip | undefined)?.bulkheads ?? ship.bulkheads);
      }
      if (kind === 'group') {
        const group = value as CatalogGroup;
        if (action === 'create') check(group.category !== 'core', 'Новые группы доступны для внутренних отсеков, вооружения и вспомогательных слотов');
        else if ((existing as CatalogGroup).category !== group.category) {
          check(!original && !(data.modules[key]?.length), 'Категорию встроенной или непустой группы нельзя менять', 409);
        }
      }
      state.changes[id] = { kind, key, value, deleted: false, updatedAt: at, updatedBy: actor };
    } else if (action === 'delete') {
      check(active, 'Запись уже удалена или не найдена', 404);
      if (kind === 'group') {
        const reason = groupDeletionReason(data, key);
        check(!reason, reason ?? '', 409);
      }
      if (kind === 'bulkhead') {
        const [ship, bulkheadId] = splitKey(key);
        check(data.ships[ship].bulkheads[0]?.id !== bulkheadId, 'Базовую броню корабля удалять нельзя', 409);
      }
      if (kind === 'ship') {
        check(Object.values(data.ships).some((ship) => ship.id !== key && !ship.archived),
          'Нельзя удалить последний доступный корабль', 409);
      }
      value = existing;
      if (kind === 'ship') {
        value = { ...(existing as OutfittingShip), bulkheads: structuredClone(
          (previous?.value as OutfittingShip | undefined)?.bulkheads
          ?? (original as OutfittingShip | undefined)?.bulkheads ?? (existing as OutfittingShip).bulkheads,
        ) };
      }
      state.changes[id] = { kind, key, value, deleted: true, updatedAt: at, updatedBy: actor };
    } else if (action === 'restore') {
      check(previous?.deleted, 'Запись не находится в архиве', 409);
      // A group may have been archived afterwards. Restore it first.
      value = validateCatalogValue(kind, key, previous.value, data);
      state.changes[id] = { ...previous, value, deleted: false, updatedAt: at, updatedBy: actor };
    } else {
      check(original && previous, 'Исходная запись или изменения не найдены', 404);
      value = original;
      if (kind === 'module') check(data.groups[splitKey(key)[0]], 'Сначала восстановите группу', 409);
      delete state.changes[id];
    }
    const record = value as unknown as Record<string, unknown>;
    state.history.unshift({ action, kind, key, label: kind === 'ship' ? (value as OutfittingShip).properties.name : String(record.name || key), at, actor });
  }
  state.history = state.history.slice(0, 100);
  state.revision += 1;
  state.updatedAt = at;
  check(JSON.stringify(state).length <= 4_000_000, 'Каталог изменений превышает 4 МБ', 413);
  return state;
}

export function catalogSnapshot(base: OutfittingData, state: CatalogState, storage: CatalogSnapshot['storage']): CatalogSnapshot {
  return {
    data: mergeCatalog(base, state), revision: state.revision, history: state.history,
    updatedAt: state.updatedAt, storage,
    changes: Object.values(state.changes).map((change) => ({ ...change, fromSource: !!sourceValue(base, change.kind, change.key) })),
  };
}
