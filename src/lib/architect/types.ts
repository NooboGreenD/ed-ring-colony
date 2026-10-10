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

import type { BodySignals } from '../bodySignals.ts';

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

/**
 * Материалы основного порта.
 *
 * Основной порт — первый порт системы, который строится с колониального
 * корабля: он не тратит очки системы, но требует больше материалов, чем
 * такой же порт в уже колонизированной системе. Какой именно порт станет
 * основным, игрок выбирает при размещении, поэтому у каждой портовой
 * постройки есть свой «основной» список грузов.
 */
export interface PrimaryPortCargo {
  /** Товар → тонны для основного порта (дороже обычного списка). */
  cargo: Record<string, number>;
  /**
   * Числа оценочные: посчитаны по коэффициенту подорожания, а не сняты
   * со стройплощадки. Интерфейс помечает такие списки «≈».
   */
  approximate?: boolean;
  /** Происхождение чисел — одна строка для подсказки в интерфейсе. */
  note: string;
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
  /**
   * Материалы, если постройка выбирается основным портом системы.
   * Есть только у портов (аванпосты и звёздные порты) — по отсутствию поля
   * движок понимает, что постройка основным портом быть не может.
   */
  primary?: PrimaryPortCargo;
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
  /**
   * Сигналы тела из журнала: биология, геология, следы людей, стражи,
   * таргоиды. Для архитектора это не украшение: биология на теле означает
   * штраф за застройку для экзобиологов, геология — материалы под боком,
   * человеческие сигналы — чужое присутствие рядом с будущей колонией.
   */
  signals: BodySignals;
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
  /**
   * Основной порт системы: строится с колониального корабля, не тратит
   * очки системы и требует «основного» списка материалов. В плане такой
   * порт может быть только один.
   */
  primary?: boolean;
  note?: string;
  /**
   * Id постройки в Raven Colonial, с которой эта запись связана. Связь ставится
   * один раз — при переносе факта или при создании проекта — и дальше по ней
   * узнаётся та же постройка при каждой синхронизации. Поэтому повторный
   * перенос не создаёт вторую запись, даже если название тела в источнике
   * поменялось.
   */
  ravenBuildId?: string;
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
  /**
   * Ручное число орбитальных слотов по именам тел. Поле хранится в плане,
   * потому что источники сканирования не сообщают, у каких планет и лун игра
   * разрешила орбитальную застройку.
   */
  orbitalSlots: Record<string, number>;
}

export type IssueLevel = 'error' | 'warning' | 'info';

/** Итоговая информация об основном порте плана. */
export interface PrimaryPortInfo {
  siteId: string;
  installationId: string;
  bodyName: string;
  /** Тоннаж по «основному» списку материалов (не обычному). */
  tons: number;
  /** Числа приблизительные — посчитаны по коэффициенту, а не со скана. */
  approximate: boolean;
  /** Экономика, которую основной порт задаёт системе. */
  economy: SystemEconomy;
}


/** Замечание по плану: привязано к записи или к системе в целом. */
export interface PlanIssue {
  level: IssueLevel;
  siteId?: string;
  bodyName?: string;
  message: string;
}

/**
 * Шаг стройки: то же, что одна строка порядка, но с состоянием бюджета
 * очков системы **после** этого шага. Нужен инфографике — по нему рисуется
 * график, где видно, в какой момент очков T2/T3 перестаёт хватать.
 */
export interface PlanStep {
  /** Порядковый номер, начиная с 1. */
  index: number;
  siteId: string;
  installationId: string;
  nameRu: string;
  bodyName: string;
  tier: ArchitectTier;
  status: PlannedSiteStatus;
  primary: boolean;
  /** Сколько очков тратит шаг (с учётом налога на порты). */
  cost: number;
  costTier: ArchitectTier;
  /** Сколько очков даёт после завершения. */
  gives: number;
  givesTier: ArchitectTier;
  /** Баланс очков после шага. */
  tier2After: number;
  tier3After: number;
  /** На этом шаге очков не хватило. */
  deficit: boolean;
  /** Тоннаж шага (у основного порта — по «основному» списку материалов). */
  tons: number;
  /** Накопленный тоннаж с начала стройки. */
  tonsCumulative: number;
}

/** Итог расчёта плана. */
export interface PlanEvaluation {
  /** Порядок стройки: id записей в последовательности, которой стоит придерживаться. */
  order: string[];
  /** Тот же порядок, но с бюджетом очков и тоннажом на каждом шаге. */
  timeline: PlanStep[];
  /** Свободные очки системы после всего плана. */
  tierPoints: { tier2: number; tier3: number };
  /** Сколько очков план суммарно тратит. */
  tierSpent: { tier2: number; tier3: number };
  /** Сколько очков план суммарно даёт. */
  tierGiven: { tier2: number; tier3: number };
  /** Стоимость каждого порта с учётом «налога» на дополнительные порты. */
  portCosts: { siteId: string; installationId: string; tier: ArchitectTier; cost: number; taxed: boolean }[];
  /** Основной порт плана: null — не отмечен (или в системе уже есть свой). */
  primaryPort: PrimaryPortInfo | null;
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
  /** Число занятых орбитальных слотов; null означает лимит без жёсткой границы. */
  orbitalUsage: Record<string, { used: number; limit: number | null }>;
}

/** Проверка «можно ли поставить эту постройку на это тело». */
export interface PlacementCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
