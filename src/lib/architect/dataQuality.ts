/**
 * Проверка загруженных данных системы: повторы и корректность.
 *
 * «Архитектор» собирает тела из трёх источников (собственная база сканов,
 * EDSM, Spansh) и застройку ещё из двух (Raven Colonial, EDSM). Любой из них
 * может прислать одно и то же тело дважды, тело без имени, посадочную планету
 * с нулевой гравитацией или расстояние `0` у половины системы. Раньше это
 * молча попадало в интерфейс: две одинаковые карточки, «0 K», «0 g» и слоты,
 * посчитанные по пустым полям.
 *
 * Модуль отвечает на два вопроса и ничего не чинит молча:
 *
 *   1. `auditBodyRows` — что не так с телами системы (повторы, пустые и
 *      подозрительные значения, покрытие полей, источники строк);
 *   2. `auditPlanData` — что не так со связью плана и данных (постройки на
 *      телах, которых нет в каталоге, дубли записей, потерянные привязки).
 *
 * Модуль чистый: ни сети, ни React — проверяется тестами
 * (`scripts/tests/architect-data-quality.test.mjs`).
 */

import { buildBodyIndex, normalizeBodyKey, resolveBodyName } from './bodyNames.ts';
import { getInstallation } from './planner.ts';
import type { ArchitectBody, ArchitectPlan } from './types.ts';

export type DataIssueLevel = 'error' | 'warning' | 'info';

export interface DataIssue {
  /** Машинный код проверки — по нему тесты и интерфейс отличают проверки. */
  code: string;
  level: DataIssueLevel;
  message: string;
  /** Тела, к которым относится замечание (до 12 имён — остальное числом). */
  bodies: string[];
  count: number;
}

export interface BodyDataReport {
  /** Сколько строк пришло от API. */
  rawCount: number;
  /** Сколько уникальных тел получилось после схлопывания. */
  total: number;
  /** Повторы: имя тела → сколько раз пришло. */
  duplicates: { name: string; count: number }[];
  /** Заполненность ключевых полей, доли 0..1. */
  coverage: {
    name: number;
    subType: number;
    distance: number;
    radius: number;
    gravity: number;
    temperature: number;
    signals: number;
  };
  /** Разбивка строк по полю `source` (helper, edsm, spansh…). */
  sources: Record<string, number>;
  /** Самая свежая запись среди строк. */
  updatedAt: string | null;
  issues: DataIssue[];
  /** Итоговая оценка качества данных, 0..100. */
  score: number;
}

export interface PlanDataReport {
  /** Записи плана на телах, которых нет в загруженном каталоге. */
  unknownBodies: { bodyName: string; siteIds: string[] }[];
  /** Записи без указанного тела. */
  orphanSiteIds: string[];
  /** Дубли: одна и та же постройка на одном теле несколько раз. */
  duplicates: { bodyName: string; installationId: string; siteIds: string[] }[];
  /** Записи с неизвестным каталогу типом постройки. */
  unknownInstallations: { installationId: string; siteIds: string[] }[];
  issues: DataIssue[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function issue(
  code: string,
  level: DataIssueLevel,
  message: string,
  bodies: string[],
): DataIssue {
  return { code, level, message, bodies: bodies.slice(0, 12), count: bodies.length };
}

/** Штраф за замечание в итоговой оценке качества. */
const PENALTY: Record<DataIssueLevel, number> = { error: 12, warning: 6, info: 2 };

/**
 * Проверка строк тел, как они пришли из `/api/atlas/system-bodies`.
 *
 * Работает по сырым строкам (а не по `ArchitectBody`) специально: именно в них
 * видно, сколько записей пришло на самом деле и из какого источника — после
 * схлопывания в `fromScanRecords` эта информация теряется.
 */
export function auditBodyRows(rows: unknown, options: { system?: string } = {}): BodyDataReport {
  const list = Array.isArray(rows) ? rows.map(asRecord).filter(Boolean) as Record<string, unknown>[] : [];
  const system = options.system ?? '';

  const nameCounts = new Map<string, { name: string; count: number }>();
  const idNames = new Map<number, Set<string>>();
  const sources: Record<string, number> = {};
  const unnamed: string[] = [];
  const noSubType: string[] = [];
  const noDistance: string[] = [];
  const landableNoGravity: string[] = [];
  const landableNoRadius: string[] = [];
  const zeroTemperature: string[] = [];
  const impossibleGravity: string[] = [];
  const impossibleTemperature: string[] = [];
  const impossibleRadius: string[] = [];
  const idConflicts: string[] = [];

  let updatedAt: string | null = null;
  const filled = { name: 0, subType: 0, distance: 0, radius: 0, gravity: 0, temperature: 0, signals: 0 };

  list.forEach((row, position) => {
    const name = text(row.body_name ?? row.name ?? row.bodyName);
    const label = name || `строка ${position + 1}`;
    const key = normalizeBodyKey(name);
    if (name) {
      filled.name += 1;
      const known = nameCounts.get(key);
      if (known) known.count += 1;
      else nameCounts.set(key, { name, count: 1 });
    } else {
      unnamed.push(label);
    }

    const source = text(row.source) || 'неизвестно';
    sources[source] = (sources[source] ?? 0) + 1;

    const stamp = text(row.updated_at ?? row.updatedAt);
    if (stamp && (!updatedAt || stamp > updatedAt)) updatedAt = stamp;

    const bodyId = row.body_id ?? row.bodyId;
    if (typeof bodyId === 'number' && Number.isFinite(bodyId) && name) {
      const names = idNames.get(bodyId) ?? new Set<string>();
      names.add(key);
      idNames.set(bodyId, names);
    }

    const isStar = text(row.body_type ?? row.type).toLowerCase() === 'star';
    const subType = text(row.sub_type ?? row.subType ?? row.planet_class ?? row.star_type);
    if (subType) filled.subType += 1;
    else noSubType.push(label);

    const distance = num(row.distance_ls ?? row.distanceLs ?? row.distanceToArrival);
    if (distance > 0) filled.distance += 1;
    else if (!isStar) noDistance.push(label);

    const radiusM = num(row.radius_m ?? row.radiusM);
    const radiusKm = radiusM > 0 ? radiusM / 1000 : num(row.radius);
    if (radiusKm > 0) filled.radius += 1;

    const gravity = num(row.gravity);
    if (gravity > 0) filled.gravity += 1;

    const temperature = num(row.surface_temp_k ?? row.surfaceTemperature ?? row.temp_k);
    if (temperature > 0) filled.temperature += 1;
    else if (!isStar) zeroTemperature.push(label);

    const landable = Boolean(row.is_landable ?? row.landable ?? row.isLandable);
    if (landable && gravity <= 0) landableNoGravity.push(label);
    if (landable && radiusKm <= 0) landableNoRadius.push(label);

    // Физически невозможные значения: такие данные ломают расчёт слотов.
    if (gravity > 20) impossibleGravity.push(`${label} (${gravity} g)`);
    if (!isStar && temperature > 5000) impossibleTemperature.push(`${label} (${Math.round(temperature)} K)`);
    if (!isStar && radiusKm > 200_000) impossibleRadius.push(`${label} (${Math.round(radiusKm)} км)`);

    const signals = ['bio_signals_count', 'geo_signals_count', 'human_signals_count',
      'thargoid_signals_count', 'guardian_signals_count', 'other_signals_count']
      .reduce((sum, field) => sum + num(row[field]), 0);
    if (signals > 0) filled.signals += 1;
  });

  for (const [bodyId, names] of idNames) {
    if (names.size > 1) idConflicts.push(`id ${bodyId}: ${[...names].join(' / ')}`);
  }

  const duplicates = [...nameCounts.values()]
    .filter((entry) => entry.count > 1)
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'ru'));

  const issues: DataIssue[] = [];
  if (duplicates.length > 0) {
    issues.push(issue(
      'duplicate-bodies',
      'warning',
      `Повторы тел в ответе источников: ${duplicates.reduce((sum, entry) => sum + entry.count - 1, 0)} лишних строк — в каталог взята самая полная версия каждого тела`,
      duplicates.map((entry) => `${entry.name} ×${entry.count}`),
    ));
  }
  if (idConflicts.length > 0) {
    issues.push(issue('body-id-conflict', 'warning',
      'Один номер тела (bodyId) у разных имён — источники расходятся в нумерации', idConflicts));
  }
  if (unnamed.length > 0) {
    issues.push(issue('unnamed-body', 'warning',
      'Тела без имени: сопоставить их с площадками и планом невозможно', unnamed));
  }
  if (landableNoGravity.length > 0) {
    issues.push(issue('landable-no-gravity', 'error',
      'Посадочные тела без гравитации — расчёт наземных слотов по ним неточен', landableNoGravity));
  }
  if (landableNoRadius.length > 0) {
    issues.push(issue('landable-no-radius', 'error',
      'Посадочные тела без радиуса — базовое число наземных слотов считается по радиусу', landableNoRadius));
  }
  if (impossibleGravity.length > 0) {
    issues.push(issue('impossible-gravity', 'error',
      'Невозможная гравитация: похоже на ошибку источника', impossibleGravity));
  }
  if (impossibleTemperature.length > 0) {
    issues.push(issue('impossible-temperature', 'warning',
      'Подозрительная температура поверхности', impossibleTemperature));
  }
  if (impossibleRadius.length > 0) {
    issues.push(issue('impossible-radius', 'warning',
      'Подозрительный радиус тела', impossibleRadius));
  }
  if (noSubType.length > 0) {
    issues.push(issue('no-subtype', 'warning',
      'Тела без класса: экономика и бонусы слотов по ним не считаются', noSubType));
  }
  if (zeroTemperature.length > 0) {
    issues.push(issue('no-temperature', 'info',
      'Нет температуры поверхности — проверка «слишком горячо» для этих тел не сработает', zeroTemperature));
  }
  if (noDistance.length > 0) {
    issues.push(issue('no-distance', 'info',
      'Нет расстояния от точки входа — сортировка по расстоянию для этих тел условна', noDistance));
  }
  if (list.length === 0) {
    issues.push(issue('no-bodies', 'error',
      `Тел не найдено${system ? ` для системы «${system}»` : ''}: проверьте название или загрузите сканы`, []));
  }

  const total = nameCounts.size + unnamed.length;
  const denominator = Math.max(1, list.length);
  const coverage = {
    name: filled.name / denominator,
    subType: filled.subType / denominator,
    distance: filled.distance / denominator,
    radius: filled.radius / denominator,
    gravity: filled.gravity / denominator,
    temperature: filled.temperature / denominator,
    signals: filled.signals / denominator,
  };

  const penalty = issues.reduce((sum, entry) => sum + PENALTY[entry.level], 0);
  const coverageScore = list.length === 0
    ? 0
    : Math.round(((coverage.name + coverage.subType + coverage.radius + coverage.gravity) / 4) * 100);
  const score = Math.max(0, Math.min(100, coverageScore - penalty));

  return {
    rawCount: list.length,
    total,
    duplicates,
    coverage,
    sources,
    updatedAt,
    issues,
    score,
  };
}

/**
 * Проверка связи плана и загруженных данных.
 *
 * Именно здесь ловится случай, из-за которого «применение факта» выглядело
 * как «ничего не произошло»: постройка попадала в план на тело, которого нет
 * в каталоге, и ни одна карточка тела её не показывала.
 */
export function auditPlanData(plan: ArchitectPlan, bodies: ArchitectBody[]): PlanDataReport {
  // Имя тела ищем индексом, а не строгим сравнением: источники называют тела
  // по-своему («A 1» вместо «Sol A 1»), и такие записи — не «неизвестное
  // тело», а нормально опознанные.
  const index = buildBodyIndex(bodies, plan.system);
  const resolve = (name: string): string => (
    bodies.length > 0 ? resolveBodyName(name, index).name : ''
  );
  const unknownMap = new Map<string, string[]>();
  const orphanSiteIds: string[] = [];
  const duplicateMap = new Map<string, { bodyName: string; installationId: string; siteIds: string[] }>();
  const unknownInstallationMap = new Map<string, string[]>();

  for (const site of plan.sites) {
    const rawKey = normalizeBodyKey(site.bodyName);
    const resolved = rawKey ? resolve(site.bodyName) : '';
    // Ключ дубля — каноническое имя тела, иначе два написания одного тела
    // считались бы разными местами.
    const key = resolved ? normalizeBodyKey(resolved) : rawKey;
    if (!rawKey) {
      orphanSiteIds.push(site.id);
    } else if (bodies.length > 0 && !resolved) {
      const list = unknownMap.get(site.bodyName) ?? [];
      list.push(site.id);
      unknownMap.set(site.bodyName, list);
    }

    if (!getInstallation(site.installationId)) {
      const list = unknownInstallationMap.get(site.installationId) ?? [];
      list.push(site.id);
      unknownInstallationMap.set(site.installationId, list);
    }

    const dupeKey = `${key}|${site.installationId}`;
    const dupe = duplicateMap.get(dupeKey)
      ?? { bodyName: site.bodyName, installationId: site.installationId, siteIds: [] };
    dupe.siteIds.push(site.id);
    duplicateMap.set(dupeKey, dupe);
  }

  const unknownBodies = [...unknownMap.entries()].map(([bodyName, siteIds]) => ({ bodyName, siteIds }));
  const duplicates = [...duplicateMap.values()].filter((entry) => entry.siteIds.length > 1);
  const unknownInstallations = [...unknownInstallationMap.entries()]
    .map(([installationId, siteIds]) => ({ installationId, siteIds }));

  const issues: DataIssue[] = [];
  if (unknownBodies.length > 0) {
    issues.push(issue('plan-unknown-body', 'warning',
      'В плане есть постройки на телах, которых нет в загруженных данных — они показаны отдельным блоком «вне каталога тел»',
      unknownBodies.map((entry) => entry.bodyName)));
  }
  if (orphanSiteIds.length > 0) {
    // В замечании называем постройку, а не внутренний id записи: по id
    // пользователь всё равно ничего не найдёт.
    const labels = orphanSiteIds.map((siteId) => {
      const site = plan.sites.find((entry) => entry.id === siteId);
      return getInstallation(site?.installationId ?? '')?.nameRu ?? site?.installationId ?? siteId;
    });
    issues.push(issue('plan-orphan-site', 'warning',
      'Постройки без указанного тела: задайте тело, иначе слоты и экономика по ним не считаются',
      labels));
  }
  if (duplicates.length > 0) {
    issues.push(issue('plan-duplicate-site', 'info',
      'Одинаковые постройки на одном теле: проверьте, что это не повторный перенос факта',
      duplicates.map((entry) => `${getInstallation(entry.installationId)?.nameRu ?? entry.installationId} — ${entry.bodyName} ×${entry.siteIds.length}`)));
  }
  if (unknownInstallations.length > 0) {
    issues.push(issue('plan-unknown-installation', 'error',
      'Записи с неизвестным каталогу типом постройки — обновите каталог или удалите запись',
      unknownInstallations.map((entry) => entry.installationId)));
  }

  return { unknownBodies, orphanSiteIds, duplicates, unknownInstallations, issues };
}
