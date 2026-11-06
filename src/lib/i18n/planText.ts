/**
 * Тексты проверок планировщика.
 *
 * `src/lib/architect/planner.ts` — чистый модуль без доступа к React и к
 * каталогу: он отдаёт сообщение русским (`text`, `message`) и ключом перевода.
 * Здесь ключи превращаются в строки на языке пилота; нет ключа или перевода —
 * показываем русский оригинал, а не пустоту.
 */

import type { PlacementCheck, PlacementNote, PlanIssue } from '@/lib/architect/types';
import type { EconomyBodyFit } from '@/lib/architect/economy';
import { BODY_TRAIT_LABELS_RU, type BodyTrait } from '@/lib/architect/economy.ts';

export type PlanTranslate = (key: string, params?: Record<string, string | number>) => string;

function resolve(key: string | undefined, params: Record<string, string | number> | undefined, fallback: string, t: PlanTranslate): string {
  if (!key) return fallback;
  const value = t(key, params);
  return value === key ? fallback : value;
}

/** Сообщение плана (ошибка или предупреждение). */
export function issueText(issue: PlanIssue, t: PlanTranslate): string {
  return resolve(issue.key, issue.params, issue.message, t);
}

/** Одно сообщение проверки размещения. */
export function placementNoteText(note: PlacementNote, t: PlanTranslate): string {
  return resolve(note.key, note.params, note.text, t);
}

/** Проверка размещения целиком — те же списки, но на языке пилота. */
export function placementCheckTexts(check: PlacementCheck, t: PlanTranslate): { errors: string[]; warnings: string[] } {
  if (!check.notes) return { errors: check.errors, warnings: check.warnings };
  return {
    errors: check.notes.errors.map((note) => placementNoteText(note, t)),
    warnings: check.notes.warnings.map((note) => placementNoteText(note, t)),
  };
}

/** Пояснение «тело ↔ экономика». */
export function economyFitText(fit: EconomyBodyFit, t: PlanTranslate): string {
  return resolve(fit.key, fit.params, fit.reason, t);
}

/** Признак тела словами интерфейса: «кольца / пояс», «водный мир»… */
export function bodyTraitLabel(trait: BodyTrait, t: PlanTranslate): string {
  const fallback = BODY_TRAIT_LABELS_RU[trait] ?? trait;
  return resolve(`ebf.trait.${trait}`, undefined, fallback, t);
}
