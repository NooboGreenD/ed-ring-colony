/**
 * Типы «Архитектора системы» — планировщика застройки под колонизацию.
 *
 * Модель повторяет то, как это устроено в игре (Elite Dangerous: Trailblazers /
 * Operations) и в планировщике Raven Colonial: система → тела → площадки
 * (слоты) → запланированные постройки, а поверх — правила очков тиров,
 * предшественники, товары и оценка системы.
 *
 * Модуль намеренно без React и без сети: его можно прогнать в тестах
 * (`scripts/tests/system-architect.test.mjs`) и переиспользовать в API.
 */

/** Где стоит постройка. */
export type ArchitectLocation = 'orbital' | 'surface';

/** Класс постройки: от спутника до звёздного порта. */
export type ArchitectBuildClass =
  | 'starport'
  | 'outpost'
  | 'installation'
  | 'settlement'
  | 'hub'
  | 'unknown';

/** Размер самой большой посадочной площадки. */
export type ArchitectPadSize = 'none' | 'small' | 'medium' | 'large';

/** Тир постройки (0 — «не тир», используется для needs/gives без стоимости). */
export type ArchitectTier = 0 | 1 | 2 | 3;

/** Экономика, которую постройка привносит в систему. */
export type SystemEconomy =
  | 'agriculture'
  | 'colony'
  | 'contraband'
  | 'extraction'
  | 'hightech'
  | 'industrial'
  | 'military'
  | 'refinery'
  | 'service'
  | 'tourism'
  | 'none';

/** Эффекты постройки на характеристики системы. */
export type SystemEffectKey = 'pop' | 'mpop' | 'sec' | 'wealth' | 'tech' | 'sol' | 'dev';

export type SystemEffects = Record<SystemEffectKey, number>;

/** Цепочка предшественников: без такой постройки в системе новую не поставить. */
export type ArchitectPreReq =
  | 'satellite'
  | 'comms'
  | 'relay'
  | 'installationAgr'
  | 'installationMil'
  | 'outpostMining'
  | 'settlementAgr'
  | 'settlementBio'
  | 'settlementTourist'
  | 'settlementMilitary'
  | 'settlementExtraction';

/** Стоимость/выдача очков системы. */
export interface TierCost {
  tier: ArchitectTier;
  count: number;
}

/** Одна постройка из каталога. */
export interface ArchitectInstallation {
  /** Игровой buildType: `no_truss`, `consus`, `tartarus`… */
  id: string;
  nameRu: string;
  nameEn: string;
  /** Группа из игрового меню постройки. */
  group: string;
  buildClass: ArchitectBuildClass;
  tier: ArchitectTier;
  location: ArchitectLocation;
  pad: ArchitectPadSize;
  /** Сколько очков системы нужно, чтобы начать стройку. */
  needs: TierCost;
  /** Сколько очков система получит после завершения. */
  gives: TierCost;
  preReq?: ArchitectPreReq;
  /** Вклад в оценку системы (system score). */
  score: number;
  /** Основная экономика постройки. */
  influence: SystemEconomy;
  effects: SystemEffects;
  /** Суммарный тоннаж товаров — оценка объёма перевозок. */
  haulTons: number;
  /** Товар → тонны. */
  cargo: Record<string, number>;
}

export type ArchitectBodyKind = 'star' | 'planet' | 'moon';

/** Тело системы в терминах планировщика. */
export interface ArchitectBody {
  name: string;
  bodyId: number | null;
  kind: ArchitectBodyKind;
  subType: string;
  distanceLs: number;
  /** Радиус в километрах (0 — неизвестен). */
  radiusKm: number;
  /** Гравитация в g. */
  gravity: number;
  /** Температура поверхности, K. */
  tempK: number;
  landable: boolean;
  terraformable: boolean;
  hasAtmosphere: boolean;
  volcanism: boolean;
  /** Есть кольца/пояс астероидов — нужен для астероидной базы. */
  hasRings: boolean;
  /** Признаки, которые влияют на число наземных слотов. */
  features: string[];
}

/** Статус запланированной постройки. */
export type PlannedSiteStatus = 'plan' | 'building' | 'complete';

/** Одна запись плана. */
export interface PlannedSite {
  /** Локальный id записи (не buildId из игры). */
  id: string;
  bodyName: string;
  installationId: string;
  status: PlannedSiteStatus;
  note?: string;
}

/** План застройки системы. */
export interface ArchitectPlan {
  /** Версия формата: загрузчик отклоняет чужие/старые файлы честно. */
  version: number;
  system: string;
  architect: string;
  createdAt: string;
  updatedAt: string;
  notes: string;
  sites: PlannedSite[];
}

export type IssueLevel = 'error' | 'warning' | 'info';

/** Замечание по плану: привязано к записи или к системе в целом. */
export interface PlanIssue {
  level: IssueLevel;
  siteId?: string;
  bodyName?: string;
  message: string;
}

/** Итог расчёта плана. */
export interface PlanEvaluation {
  /** Порядок стройки: id записей в последовательности, которой стоит придерживаться. */
  order: string[];
  /** Свободные очки системы после всего плана. */
  tierPoints: { tier2: number; tier3: number };
  /** Сколько очков план суммарно тратит. */
  tierSpent: { tier2: number; tier3: number };
  /** Сколько очков план суммарно даёт. */
  tierGiven: { tier2: number; tier3: number };
  /** Стоимость каждого порта с учётом «налога» на дополнительные порты. */
  portCosts: { siteId: string; installationId: string; tier: ArchitectTier; cost: number; taxed: boolean }[];
  /** Товар → тонны по всему плану. */
  cargo: Record<string, number>;
  /** Суммарный тоннаж перевозок. */
  haulTons: number;
  /** Оценка системы (system score) по завершении. */
  score: number;
  /** Сумма эффектов по всем постройкам. */
  effects: SystemEffects;
  /** Экономика → число построек. */
  economies: Partial<Record<SystemEconomy, number>>;
  /** Что система открывает после постройки нужных объектов. */
  unlocks: { id: string; label: string; satisfied: boolean }[];
  /** Замечания: ошибки мешают строить, предупреждения — поводы подумать. */
  issues: PlanIssue[];
  /** Число занятых наземных слотов по телам. */
  surfaceUsage: Record<string, { used: number; limit: number }>;
}

/** Проверка «можно ли поставить эту постройку на это тело». */
export interface PlacementCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
