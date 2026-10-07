'use client';

/**
 * Распределитель питания — один компактный блок вместо трёх плиток.
 *
 * В игре это шесть пипок, разложенных по трём подсистемам: SYS (щит и
 * восстановление систем), ENG (скорость и перезарядка буста), WEP (заряд
 * орудий). Здесь три строки в одной рамке: слева название и шкала на четыре
 * деления (каждое делится на половину), справа — что именно даёт текущее
 * распределение. Никакая цифра не потеряна: сопротивление SYS и эффективный
 * щит, скорость по ENG с интервалом буста, ёмкость и перезарядка WEP.
 *
 * Всего доступно 6 пипок (максимум по 4 на подсистему), пресеты — те же
 * шесть раскладов, что и раньше.
 */

import React, { useCallback } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  pipAdjustedSpeed,
  pipEffectiveShield,
  pipRechargeRate,
  sysDamageResistance,
} from '@/lib/outfitting/calc';
import type { BuildStats } from '@/lib/outfitting/calc';
import type { PipState } from '@/lib/outfitting/types';
import {
  IconGauge,
  IconMinus,
  IconPlus,
  IconRefreshCw,
  IconShield,
  IconSliders,
  IconZap,
} from '@/components/Icons';
import { MONO, formatters } from './styles';

interface PowerDistributorPipsProps {
  stats: BuildStats;
  pips: PipState;
  onChange: (next: PipState) => void;
  /** Старый флаг: размеры блока в правой сводке. */
  compact?: boolean;
}

type PipKey = 'sys' | 'eng' | 'wep';

const COLORS: Record<PipKey, string> = {
  sys: '#38bdf8',
  eng: '#f59e0b',
  wep: '#f43f5e',
};

const PRESETS: { sys: number; eng: number; wep: number; key: string }[] = [
  { sys: 2, eng: 2, wep: 2, key: 'balanced' },
  { sys: 4, eng: 2, wep: 0, key: 'defend' },
  { sys: 4, eng: 0, wep: 2, key: 'combat' },
  { sys: 0, eng: 4, wep: 2, key: 'escape' },
  { sys: 2, eng: 4, wep: 0, key: 'agile' },
  { sys: 0, eng: 2, wep: 4, key: 'attack' },
];

export default function PowerDistributorPips({
  stats,
  pips,
  onChange,
  compact = false,
}: PowerDistributorPipsProps) {
  const { t, locale } = useI18n();
  const { num } = formatters(locale);

  // Умное перераспределение: сумма пипок не превышает 6.
  const setSystemPips = useCallback(
    (system: PipKey, targetVal: number) => {
      const val = Math.max(0, Math.min(4, Math.round(targetVal * 2) / 2));
      const others = (['sys', 'eng', 'wep'] as const).filter((k) => k !== system);
      let remaining = 6 - val;

      const currOther1 = pips[others[0]];
      const currOther2 = pips[others[1]];
      const sumOthers = currOther1 + currOther2;

      let nextOther1 = currOther1;
      let nextOther2 = currOther2;

      if (sumOthers > remaining) {
        const excess = sumOthers - remaining;
        if (currOther1 >= currOther2) {
          const take1 = Math.min(currOther1, excess);
          nextOther1 -= take1;
          const leftOver = excess - take1;
          nextOther2 = Math.max(0, nextOther2 - leftOver);
        } else {
          const take2 = Math.min(currOther2, excess);
          nextOther2 -= take2;
          const leftOver = excess - take2;
          nextOther1 = Math.max(0, nextOther1 - leftOver);
        }
      }

      onChange({
        sys: system === 'sys' ? val : others[0] === 'sys' ? nextOther1 : nextOther2,
        eng: system === 'eng' ? val : others[0] === 'eng' ? nextOther1 : nextOther2,
        wep: system === 'wep' ? val : others[0] === 'wep' ? nextOther1 : nextOther2,
      });
    },
    [pips, onChange],
  );

  const sysResistancePct = sysDamageResistance(pips.sys) * 100;
  const effectiveShieldVal = pipEffectiveShield(stats.shield, pips.sys);
  const sysRate = pipRechargeRate(stats.distributor.sysRate, pips.sys);
  const engRate = pipRechargeRate(stats.distributor.engRate, pips.eng);
  const wepRate = pipRechargeRate(stats.distributor.wepRate, pips.wep);
  const currentSpeed = pipAdjustedSpeed(stats.speed, stats.pipSpeed, pips.eng);
  const boostInterval =
    stats.boostEnergy > 0 && engRate > 0 ? `${(stats.boostEnergy / engRate).toFixed(1)}` : null;

  const mj = t('outfitting.unit.mj', { value: '' }).trim();
  const ms = t('outfitting.unit.ms', { value: '' }).trim();

  /** Одна строка подсистемы: подпись, шкала, значение и влияние. */
  const row = (
    system: PipKey,
    label: string,
    icon: React.ReactNode,
    effects: React.ReactNode,
  ) => {
    const value = pips[system];
    const color = COLORS[system];
    return (
      <div
        key={system}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: compact ? 6 : 8,
          padding: '3px 0',
          flexWrap: 'wrap',
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            minWidth: 46,
            color,
            fontFamily: MONO,
            fontWeight: 700,
            fontSize: 11,
            letterSpacing: 0.5,
          }}
          title={label}
        >
          {icon}
          {label}
        </span>

        <span style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setSystemPips(system, value - 0.5)}
            disabled={value <= 0}
            title="−0.5"
            style={{
              background: 'transparent',
              border: '1px solid var(--line)',
              color: value <= 0 ? 'var(--muted)' : 'var(--text)',
              borderRadius: 2,
              width: 16,
              height: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: value <= 0 ? 'not-allowed' : 'pointer',
              padding: 0,
            }}
          >
            <IconMinus size={9} />
          </button>

          <span style={{ display: 'flex', gap: 2, width: 84 }}>
            {[1, 2, 3, 4].map((barIndex) => {
              const fillLevel = Math.max(0, Math.min(1, value - (barIndex - 1)));
              const isFull = fillLevel >= 1;
              const isHalf = fillLevel >= 0.5 && fillLevel < 1;
              return (
                <span
                  key={barIndex}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSystemPips(system, value === barIndex ? barIndex - 1 : barIndex)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSystemPips(system, value === barIndex ? barIndex - 1 : barIndex);
                    }
                  }}
                  title={`${label}: ${barIndex}`}
                  style={{
                    flex: 1,
                    height: 9,
                    background: isFull
                      ? color
                      : isHalf
                        ? `linear-gradient(to right, ${color} 50%, rgba(255,255,255,0.06) 50%)`
                        : 'rgba(255,255,255,0.06)',
                    border: `1px solid ${fillLevel > 0 ? color : 'var(--line)'}`,
                    borderRadius: 2,
                    cursor: 'pointer',
                    boxShadow: fillLevel > 0 ? `0 0 6px ${color}66` : 'none',
                  }}
                />
              );
            })}
          </span>

          <button
            type="button"
            onClick={() => setSystemPips(system, value + 0.5)}
            disabled={value >= 4}
            title="+0.5"
            style={{
              background: 'transparent',
              border: '1px solid var(--line)',
              color: value >= 4 ? 'var(--muted)' : 'var(--text)',
              borderRadius: 2,
              width: 16,
              height: 16,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: value >= 4 ? 'not-allowed' : 'pointer',
              padding: 0,
            }}
          >
            <IconPlus size={9} />
          </button>

          <span
            style={{
              fontFamily: MONO,
              fontSize: 11.5,
              fontWeight: 700,
              color,
              minWidth: 24,
              textAlign: 'right',
            }}
          >
            {value.toFixed(1)}
          </span>
        </span>

        <span
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: compact ? 6 : 10,
            fontSize: 10,
            color: 'var(--muted)',
            fontFamily: MONO,
            lineHeight: 1.4,
            flex: '1 1 140px',
            minWidth: 0,
          }}
        >
          {effects}
        </span>
      </div>
    );
  };

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 4,
        padding: compact ? '7px 9px' : '9px 11px',
        marginBottom: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          flexWrap: 'wrap',
          marginBottom: 4,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconSliders size={13} color="var(--orange)" />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 1,
              color: 'var(--orange)',
              textTransform: 'uppercase',
            }}
          >
            {t('outfitting.pips.title')}
          </span>
        </span>

        <span style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {PRESETS.map((preset) => {
            const active = pips.sys === preset.sys && pips.eng === preset.eng && pips.wep === preset.wep;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => onChange({ sys: preset.sys, eng: preset.eng, wep: preset.wep })}
                title={t(`outfitting.pips.preset.${preset.key}`)}
                style={{
                  background: active ? 'rgba(230,126,34,0.18)' : 'transparent',
                  border: `1px solid ${active ? 'var(--orange)' : 'var(--line)'}`,
                  color: active ? 'var(--orange)' : 'var(--text)',
                  fontSize: 9.5,
                  fontFamily: MONO,
                  padding: '1px 5px',
                  borderRadius: 2,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                {preset.key === 'balanced' && <IconRefreshCw size={9} />}
                {preset.sys}/{preset.eng}/{preset.wep}
              </button>
            );
          })}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--line)', paddingTop: 3 }}>
        {row(
          'sys',
          t('outfitting.pips.sys'),
          <IconShield size={12} color={COLORS.sys} />,
          <>
            <span>
              {t('outfitting.pips.resistance')}:{' '}
              <b style={{ color: pips.sys > 0 ? COLORS.sys : 'var(--text)' }}>+{sysResistancePct.toFixed(1)}%</b>
            </span>
            {stats.shield > 0 && (
              <span>
                {t('outfitting.pips.effShield')}:{' '}
                <b style={{ color: COLORS.sys }}>{num(effectiveShieldVal, 0)} {mj}</b>
              </span>
            )}
            <span>
              {t('outfitting.pips.recharge')}: <b style={{ color: COLORS.sys }}>+{sysRate.toFixed(2)} MW/s</b>
            </span>
          </>,
        )}

        {row(
          'eng',
          t('outfitting.pips.eng'),
          <IconGauge size={12} color={COLORS.eng} />,
          <>
            <span>
              {t('outfitting.pips.effSpeed')}:{' '}
              <b style={{ color: COLORS.eng }}>{num(currentSpeed, 0)} {ms}</b>
            </span>
            {boostInterval && (
              <span>
                {t('outfitting.pips.boostInterval')}: <b style={{ color: COLORS.eng }}>~{boostInterval}s</b>
              </span>
            )}
            <span>
              {t('outfitting.pips.recharge')}: <b style={{ color: COLORS.eng }}>+{engRate.toFixed(2)} MW/s</b>
            </span>
          </>,
        )}

        {row(
          'wep',
          t('outfitting.pips.wep'),
          <IconZap size={12} color={COLORS.wep} />,
          <>
            <span>
              {t('outfitting.stats.distributor')}:{' '}
              <b style={{ color: 'var(--text)' }}>{num(stats.distributor.wep, 1)} {mj}</b>
            </span>
            <span>
              {t('outfitting.pips.recharge')}:{' '}
              <b style={{ color: pips.wep > 0 ? COLORS.wep : 'var(--text)' }}>+{wepRate.toFixed(2)} MW/s</b>
            </span>
          </>,
        )}
      </div>
    </div>
  );
}
