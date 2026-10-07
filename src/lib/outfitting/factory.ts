/**
 * Заводская настройка модуля: что именно стоит на нём с завода.
 *
 * В справочнике такие модули помечены блоком `preEngineered`: чертёж (или
 * несколько), уровень, разрешён ли экспериментальный эффект и — у части
 * наборов — уже наложенные заводские эффекты. Интерфейсу нужно показать это
 * одним блоком: вкладка инженерии для таких модулей бессмысленна, потому что
 * чертёж менять нельзя, а экспериментальный эффект — можно (если разрешено).
 *
 * Числа у части модулей собраны по официальному описанию обновления, а не
 * выгружены из игры: `approx` честно говорит об этом интерфейсу.
 */

import { blueprintLabel } from './build';
import type { OutfittingData, OutfittingModule, PreEngineered } from './types';

export interface FactoryBlueprint {
  id: string;
  /** «FSD · дальнобойный» на языке интерфейса. */
  label: string;
  grade: number;
}

export interface FactoryInfo {
  /** Есть заводская настройка. */
  factory: true;
  /** Модуль нельзя переделать у инженера. */
  reengineerable: boolean;
  /** Чертежи, с которыми модуль вышел с завода. */
  blueprints: FactoryBlueprint[];
  /** Заводские экспериментальные эффекты (id из `data.specials`). */
  specials: string[];
  /** Разрешён ли экспериментальный эффект поверх заводской настройки. */
  canEngineerSpecial: boolean;
  /** Числа — оценка по описанию обновления, а не данные игры. */
  approx: boolean;
  /** Описание из набора данных (английское, как в игре). */
  description?: string;
  /** Идентификатор рецепта Frontier, если он известен. */
  recipe?: string;
}

export function factoryInfo(data: OutfittingData, module: OutfittingModule | null): FactoryInfo | null {
  const pre = module?.preEngineered;
  if (!module || !pre) return null;
  const grade = pre.grade ?? 1;
  const blueprints = (pre.blueprints ?? []).map((id) => ({
    id,
    label: blueprintLabel(id, 'en'),
    grade,
  }));
  const specials = (pre.experimentalEffects ?? []).filter(Boolean);
  return {
    factory: true,
    reengineerable: pre.reengineerable !== false,
    blueprints,
    specials,
    canEngineerSpecial: pre.canApplyExperimental === true,
    approx: pre.approx === true,
    description: pre.description,
    recipe: pre.recipe,
  };
}

/** Есть ли у модуля заводская настройка (без сборки полной карточки). */
export function isFactoryModule(module: OutfittingModule | null | undefined): boolean {
  return Boolean(module?.preEngineered);
}

/** Разрешён ли пользователю экспериментальный эффект поверх заводского. */
export function canApplyExperimental(module: OutfittingModule | null | undefined): boolean {
  const pre = module?.preEngineered as PreEngineered | undefined;
  return !pre || pre.canApplyExperimental !== false;
}
