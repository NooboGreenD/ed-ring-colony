/**
 * Локализация данных об инженерах.
 *
 * Русский текст лежит прямо в `data.ts` — это исходник, с которым сверяют
 * правки. Переводы вынесены в `locales/*`: по файлу на язык, ключ — тот же
 * идентификатор инженера. Нет перевода поля (или всего языка) — показываем
 * русский оригинал, а не пустоту.
 *
 * Умения инженеров Одиссеи — это названия модификаций скафандров и оружия из
 * игры, их всего 25 штук на весь раздел, поэтому переводим их словарём по
 * русской строке, а не переписываем списки в каждом языке.
 */

import { en } from './locales/en';
import { de } from './locales/de';
import { it } from './locales/it';
import { ko } from './locales/ko';
import { zh } from './locales/zh';
import { ja } from './locales/ja';
import type { Engineer } from './data';

/** Поля инженера, которые переводятся. */
export type EngineerTextField = 'discovery' | 'meeting' | 'unlock' | 'referral' | 'focus';

export type EngineerTexts = Record<string, Partial<Record<EngineerTextField, string>>>;

const TEXTS: Record<string, EngineerTexts> = { en, de, it, ko, zh, ja };

/**
 * Названия модификаций Одиссеи: русская строка из `data.ts` → перевод.
 * Английские названия — ровно как в игре, остальные языки повторяют их смысл.
 */
export const SKILL_NAMES: Record<string, Record<string, string>> = {
  en: {
    'Скорость перезарядки': 'Reload Speed',
    'Ёмкость магазина': 'Magazine Size',
    'Дополнительный боезапас': 'Extra Ammo Capacity',
    'Сопротивление урону': 'Damage Resistance',
    'Урон в ближнем бою': 'Added Melee Damage',
    'Точность от бедра': 'Hip Fire Accuracy',
    'Глушитель': 'Noise Suppressor',
    'Дольше спринт': 'Increased Sprint Duration',
    'Скорость в бою': 'Combat Movement Speed',
    'Больше запаса воздуха': 'Increased Air Reserves',
    'Стабильность': 'Stability',
    'Прицел': 'Scope',
    'Улучшенное наведение': 'Enhanced Tracking',
    'Ёмкость батареи': 'Extra Battery Capacity',
    'Ночное зрение': 'Night Vision',
    'Быстрое обращение': 'Faster Handling',
    'Улучшенный прыжковый ускоритель': 'Improved Jump Assist',
    'Увеличенная дальность': 'Greater Range',
    'Экономия батареи инструмента': 'Reduced Tool Battery Consumption',
    'Больше места в рюкзаке': 'Extra Backpack Capacity',
    'Перезарядка в кобуре': 'Stowed Reloading',
    'Урон в голову': 'Headshot Damage',
    'Быстрое восстановление щита': 'Faster Shield Regen',
    'Маскировка звука': 'Audio Masking',
    'Тихие шаги': 'Quieter Footsteps',
  },
  de: {
    'Скорость перезарядки': 'Nachladegeschwindigkeit',
    'Ёмкость магазина': 'Magazingröße',
    'Дополнительный боезапас': 'Zusätzliche Munition',
    'Сопротивление урону': 'Schadensresistenz',
    'Урон в ближнем бою': 'Nahkampfschaden',
    'Точность от бедра': 'Treffsicherheit aus der Hüfte',
    'Глушитель': 'Schalldämpfer',
    'Дольше спринт': 'Längerer Sprint',
    'Скорость в бою': 'Bewegungstempo im Kampf',
    'Больше запаса воздуха': 'Größerer Luftvorrat',
    'Стабильность': 'Stabilität',
    'Прицел': 'Zielfernrohr',
    'Улучшенное наведение': 'Verbesserte Zielerfassung',
    'Ёмкость батареи': 'Größere Batteriekapazität',
    'Ночное зрение': 'Nachtsicht',
    'Быстрое обращение': 'Schnelleres Handling',
    'Улучшенный прыжковый ускоритель': 'Verbesserte Sprunghilfe',
    'Увеличенная дальность': 'Größere Reichweite',
    'Экономия батареи инструмента': 'Geringerer Werkzeug-Batterieverbrauch',
    'Больше места в рюкзаке': 'Größerer Rucksack',
    'Перезарядка в кобуре': 'Nachladen im Holster',
    'Урон в голову': 'Kopfschussschaden',
    'Быстрое восстановление щита': 'Schnellere Schildregeneration',
    'Маскировка звука': 'Geräuschmaskierung',
    'Тихие шаги': 'Leisere Schritte',
  },
  it: {
    'Скорость перезарядки': 'Velocità di ricarica',
    'Ёмкость магазина': 'Capienza del caricatore',
    'Дополнительный боезапас': 'Munizioni aggiuntive',
    'Сопротивление урону': 'Resistenza ai danni',
    'Урон в ближнем бою': 'Danno in mischia',
    'Точность от бедра': 'Precisione a fuoco libero',
    'Глушитель': 'Silenziatore',
    'Дольше спринт': 'Scatto più lungo',
    'Скорость в бою': 'Velocità di movimento in combattimento',
    'Больше запаса воздуха': 'Maggiore riserva d’aria',
    'Стабильность': 'Stabilità',
    'Прицел': 'Mirino',
    'Улучшенное наведение': 'Tracciamento migliorato',
    'Ёмкость батареи': 'Maggiore capacità della batteria',
    'Ночное зрение': 'Visione notturna',
    'Быстрое обращение': 'Maneggevolezza migliorata',
    'Улучшенный прыжковый ускоритель': 'Assistenza al salto migliorata',
    'Увеличенная дальность': 'Gittata maggiore',
    'Экономия батареи инструмента': 'Minor consumo della batteria degli strumenti',
    'Больше места в рюкзаке': 'Maggiore capienza dello zaino',
    'Перезарядка в кобуре': 'Ricarica con arma riposta',
    'Урон в голову': 'Danno ai colpi alla testa',
    'Быстрое восстановление щита': 'Rigenerazione più rapida dello scudo',
    'Маскировка звука': 'Mascheramento acustico',
    'Тихие шаги': 'Passi silenziosi',
  },
  ko: {
    'Скорость перезарядки': '재장전 속도',
    'Ёмкость магазина': '탄창 용량',
    'Дополнительный боезапас': '추가 탄약',
    'Сопротивление урону': '피해 저항',
    'Урон в ближнем бою': '근접 공격 피해',
    'Точность от бедра': '비조준 사격 정확도',
    'Глушитель': '소음기',
    'Дольше спринт': '전력 질주 지속 시간 증가',
    'Скорость в бою': '전투 이동 속도',
    'Больше запаса воздуха': '산소 보유량 증가',
    'Стабильность': '안정성',
    'Прицел': '조준경',
    'Улучшенное наведение': '추적 성능 향상',
    'Ёмкость батареи': '배터리 용량 증가',
    'Ночное зрение': '야간 투시',
    'Быстрое обращение': '빠른 조작',
    'Улучшенный прыжковый ускоритель': '점프 보조 장치 개선',
    'Увеличенная дальность': '사거리 증가',
    'Экономия батареи инструмента': '도구 배터리 소모 감소',
    'Больше места в рюкзаке': '배낭 용량 증가',
    'Перезарядка в кобуре': '수납 중 재장전',
    'Урон в голову': '헤드샷 피해',
    'Быстрое восстановление щита': '실드 회복 속도 증가',
    'Маскировка звука': '소리 은폐',
    'Тихие шаги': '조용한 발걸음',
  },
  zh: {
    'Скорость перезарядки': '装填速度',
    'Ёмкость магазина': '弹匣容量',
    'Дополнительный боезапас': '额外弹药',
    'Сопротивление урону': '伤害抗性',
    'Урон в ближнем бою': '近战伤害',
    'Точность от бедра': '腰射精度',
    'Глушитель': '消音器',
    'Дольше спринт': '冲刺时间延长',
    'Скорость в бою': '战斗移动速度',
    'Больше запаса воздуха': '氧气储量增加',
    'Стабильность': '稳定性',
    'Прицел': '瞄准镜',
    'Улучшенное наведение': '追踪性能提升',
    'Ёмкость батареи': '电池容量增加',
    'Ночное зрение': '夜视',
    'Быстрое обращение': '操作更迅速',
    'Улучшенный прыжковый ускоритель': '跳跃辅助增强',
    'Увеличенная дальность': '射程增加',
    'Экономия батареи инструмента': '工具耗电降低',
    'Больше места в рюкзаке': '背包容量增加',
    'Перезарядка в кобуре': '收枪装填',
    'Урон в голову': '爆头伤害',
    'Быстрое восстановление щита': '护盾恢复加快',
    'Маскировка звука': '声音掩蔽',
    'Тихие шаги': '脚步更轻',
  },
  ja: {
    'Скорость перезарядки': 'リロード速度',
    'Ёмкость магазина': 'マガジン容量',
    'Дополнительный боезапас': '追加弾薬',
    'Сопротивление урону': 'ダメージ耐性',
    'Урон в ближнем бою': '近接ダメージ',
    'Точность от бедра': '腰だめ射撃の精度',
    'Глушитель': 'サプレッサー',
    'Дольше спринт': 'スプリント時間延長',
    'Скорость в бою': '戦闘時の移動速度',
    'Больше запаса воздуха': '酸素残量の増加',
    'Стабильность': '安定性',
    'Прицел': 'スコープ',
    'Улучшенное наведение': 'トラッキング強化',
    'Ёмкость батареи': 'バッテリー容量の増加',
    'Ночное зрение': 'ナイトビジョン',
    'Быстрое обращение': 'ハンドリング向上',
    'Улучшенный прыжковый ускоритель': 'ジャンプアシスト強化',
    'Увеличенная дальность': '射程延長',
    'Экономия батареи инструмента': 'ツールのバッテリー消費軽減',
    'Больше места в рюкзаке': 'バックパック容量の増加',
    'Перезарядка в кобуре': '収納中のリロード',
    'Урон в голову': 'ヘッドショットダメージ',
    'Быстрое восстановление щита': 'シールド回復の高速化',
    'Маскировка звука': 'サウンドマスキング',
    'Тихие шаги': '静かな足音',
  },
};

/** Текст поля инженера на языке интерфейса; нет перевода — русский оригинал. */
export function engineerText(locale: string, engineer: Engineer, field: EngineerTextField): string {
  const translated = TEXTS[locale]?.[engineer.id]?.[field];
  return translated ?? engineer[field] ?? '';
}

/** Умения инженера Одиссеи на языке интерфейса. */
export function engineerSkills(locale: string, engineer: Engineer): string[] | undefined {
  if (!engineer.skills) return undefined;
  const dictionary = SKILL_NAMES[locale];
  if (!dictionary) return engineer.skills;
  return engineer.skills.map((skill) => dictionary[skill] ?? skill);
}

/** Строка для поиска: ищем и по переводу, и по русскому оригиналу. */
export function engineerSearchText(locale: string, engineer: Engineer): string {
  return [
    engineer.name,
    engineer.system,
    engineer.station,
    engineer.focus,
    engineer.discovery,
    engineerText(locale, engineer, 'focus'),
    engineerText(locale, engineer, 'discovery'),
    ...(engineerSkills(locale, engineer) ?? []),
  ].join(' ');
}
