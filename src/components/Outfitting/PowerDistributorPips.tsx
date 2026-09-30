'use client';

/**
 * Интерактивный распределитель питания («Пипки» / Power Distributor Pips).
 *
 * Управляет распределением энергии силовой установки между тремя системами:
 *  - SYS (Системы): сопротивление входящему урону щита (до −58.5% урона / ×2.41 эффективной ёмкости)
 *    и скорость восстановления конденсатора систем;
 *  - ENG (Двигатели): текущая маршевая скорость (от 50% до 100% максимальной) и перезарядка буста;
 *  - WEP (Оружие): скорость подзарядки оружейного конденсатора и теплоотвод.
 *
 * Всего доступно 6 пипок (максимум по 4 на систему).
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
  compact?: boolean;
}

export default function PowerDistributorPips({
  stats,
  pips,
  onChange,
  compact = false,
}: PowerDistributorPipsProps) {
  const { t, locale } = useI18n();
  const { num } = formatters(locale);

  // Умное перераспределение: сумма пипок не превышает 6
  const setSystemPips = useCallback(
    (system: 'sys' | 'eng' | 'wep', targetVal: number) => {
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

  const applyPreset = useCallback(
    (sys: number, eng: number, wep: number) => {
      onChange({ sys, eng, wep });
    },
    [onChange],
  );

  // Живые вычисления влияния
  const currentSpeed = pipAdjustedSpeed(stats.speed, stats.pipSpeed, pips.eng);
  const sysResistancePct = sysDamageResistance(pips.sys) * 100;
  const effectiveShieldVal = pipEffectiveShield(stats.shield, pips.sys);
  const sysRate = pipRechargeRate(stats.distributor.sysRate, pips.sys);
  const engRate = pipRechargeRate(stats.distributor.engRate, pips.eng);
  const wepRate = pipRechargeRate(stats.distributor.wepRate, pips.wep);

  // Интервал между бустами
  const boostInterval =
    stats.boostEnergy > 0 && engRate > 0
      ? (stats.boostEnergy / engRate).toFixed(1)
      : null;

  const renderPipBar = (
    system: 'sys' | 'eng' | 'wep',
    label: string,
    value: number,
    color: string,
    glowColor: string,
    icon: React.ReactNode,
    subText: React.ReactNode,
  ) => {
    return (
      <div
        style={{
          background: 'rgba(15, 23, 42, 0.45)',
          border: `1px solid ${value > 0 ? color + '40' : 'var(--line)'}`,
          borderRadius: 4,
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color }}>{icon}</span>
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 11.5, color: '#e2e8f0', letterSpacing: 0.5 }}>
              {label}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <button
              type="button"
              onClick={() => setSystemPips(system, value - 0.5)}
              disabled={value <= 0}
              title="-0.5"
              style={{
                background: 'transparent',
                border: '1px solid var(--line)',
                color: value <= 0 ? 'var(--muted)' : 'var(--text)',
                borderRadius: 2,
                width: 18,
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: value <= 0 ? 'not-allowed' : 'pointer',
                padding: 0,
              }}
            >
              <IconMinus size={10} />
            </button>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
                color,
                minWidth: 26,
                textAlign: 'center',
              }}
            >
              {value.toFixed(1)}
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
                width: 18,
                height: 18,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: value >= 4 ? 'not-allowed' : 'pointer',
                padding: 0,
              }}
            >
              <IconPlus size={10} />
            </button>
          </div>
        </div>

        {/* 4 сегмента шкалы пипок (каждый сегмент делим на 2 половинки) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 3,
            margin: '2px 0',
          }}
        >
          {[1, 2, 3, 4].map((barIndex) => {
            const fillLevel = Math.max(0, Math.min(1, value - (barIndex - 1)));
            const isFull = fillLevel >= 1;
            const isHalf = fillLevel >= 0.5 && fillLevel < 1;

            return (
              <div
                key={barIndex}
                onClick={() => {
                  if (value === barIndex) {
                    setSystemPips(system, barIndex - 1);
                  } else {
                    setSystemPips(system, barIndex);
                  }
                }}
                style={{
                  height: 10,
                  background: isFull
                    ? color
                    : isHalf
                      ? `linear-gradient(to right, ${color} 50%, rgba(255,255,255,0.06) 50%)`
                      : 'rgba(255,255,255,0.06)',
                  border: `1px solid ${fillLevel > 0 ? color : 'var(--line)'}`,
                  borderRadius: 2,
                  cursor: 'pointer',
                  boxShadow: fillLevel > 0 ? `0 0 6px ${glowColor}` : 'none',
                  transition: 'all 0.15s ease',
                }}
                title={`${label}: ${barIndex}`}
              />
            );
          })}
        </div>

        {/* Текст влияния */}
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: MONO, lineHeight: 1.3 }}>
          {subText}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 4,
        padding: compact ? '8px 10px' : '10px 12px',
        marginBottom: 10,
      }}
    >
      {/* Шапка распределителя */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <IconSliders size={14} color="var(--orange)" />
          <span
            style={{
              fontFamily: MONO,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1,
              color: 'var(--orange)',
              textTransform: 'uppercase',
            }}
          >
            {t('outfitting.pips.title')}
          </span>
        </div>

        {/* Быстрые пресеты */}
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => applyPreset(2, 2, 2)}
            title={t('outfitting.pips.preset.balanced')}
            style={{
              background: pips.sys === 2 && pips.eng === 2 && pips.wep === 2 ? 'rgba(230,126,34,0.18)' : 'transparent',
              border: `1px solid ${pips.sys === 2 && pips.eng === 2 && pips.wep === 2 ? 'var(--orange)' : 'var(--line)'}`,
              color: 'var(--text)',
              fontSize: 9.5,
              fontFamily: MONO,
              padding: '2px 5px',
              borderRadius: 2,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            <IconRefreshCw size={9} /> 2/2/2
          </button>
          <button
            type="button"
            onClick={() => applyPreset(4, 2, 0)}
            title={t('outfitting.pips.preset.defend')}
            style={{
              background: pips.sys === 4 && pips.eng === 2 && pips.wep === 0 ? 'rgba(56,189,248,0.18)' : 'transparent',
              border: `1px solid ${pips.sys === 4 && pips.eng === 2 && pips.wep === 0 ? '#38bdf8' : 'var(--line)'}`,
              color: 'var(--text)',
              fontSize: 9.5,
              fontFamily: MONO,
              padding: '2px 5px',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            4/2/0
          </button>
          <button
            type="button"
            onClick={() => applyPreset(4, 0, 2)}
            title={t('outfitting.pips.preset.combat')}
            style={{
              background: pips.sys === 4 && pips.eng === 0 && pips.wep === 2 ? 'rgba(56,189,248,0.18)' : 'transparent',
              border: `1px solid ${pips.sys === 4 && pips.eng === 0 && pips.wep === 2 ? '#38bdf8' : 'var(--line)'}`,
              color: 'var(--text)',
              fontSize: 9.5,
              fontFamily: MONO,
              padding: '2px 5px',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            4/0/2
          </button>
          <button
            type="button"
            onClick={() => applyPreset(0, 4, 2)}
            title={t('outfitting.pips.preset.escape')}
            style={{
              background: pips.sys === 0 && pips.eng === 4 && pips.wep === 2 ? 'rgba(245,158,11,0.18)' : 'transparent',
              border: `1px solid ${pips.sys === 0 && pips.eng === 4 && pips.wep === 2 ? '#f59e0b' : 'var(--line)'}`,
              color: 'var(--text)',
              fontSize: 9.5,
              fontFamily: MONO,
              padding: '2px 5px',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            0/4/2
          </button>
          <button
            type="button"
            onClick={() => applyPreset(2, 4, 0)}
            title={t('outfitting.pips.preset.agile')}
            style={{
              background: pips.sys === 2 && pips.eng === 4 && pips.wep === 0 ? 'rgba(245,158,11,0.18)' : 'transparent',
              border: `1px solid ${pips.sys === 2 && pips.eng === 4 && pips.wep === 0 ? '#f59e0b' : 'var(--line)'}`,
              color: 'var(--text)',
              fontSize: 9.5,
              fontFamily: MONO,
              padding: '2px 5px',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            2/4/0
          </button>
          <button
            type="button"
            onClick={() => applyPreset(0, 2, 4)}
            title={t('outfitting.pips.preset.attack')}
            style={{
              background: pips.sys === 0 && pips.eng === 2 && pips.wep === 4 ? 'rgba(244,63,94,0.18)' : 'transparent',
              border: `1px solid ${pips.sys === 0 && pips.eng === 2 && pips.wep === 4 ? '#f43f5e' : 'var(--line)'}`,
              color: 'var(--text)',
              fontSize: 9.5,
              fontFamily: MONO,
              padding: '2px 5px',
              borderRadius: 2,
              cursor: 'pointer',
            }}
          >
            0/2/4
          </button>
        </div>
      </div>

      {/* 3 Колонки подсистем */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
          gap: 6,
        }}
      >
        {/* SYS */}
        {renderPipBar(
          'sys',
          t('outfitting.pips.sys'),
          pips.sys,
          '#38bdf8',
          'rgba(56,189,248,0.4)',
          <IconShield size={13} color="#38bdf8" />,
          <>
            <div>
              {t('outfitting.pips.resistance')}:{' '}
              <span style={{ color: pips.sys > 0 ? '#38bdf8' : 'var(--text)', fontWeight: 700 }}>
                +{sysResistancePct.toFixed(1)}%
              </span>
            </div>
            {stats.shield > 0 && (
              <div>
                {t('outfitting.pips.effShield')}:{' '}
                <span style={{ color: '#38bdf8', fontWeight: 700 }}>
                  {num(effectiveShieldVal, 0)} {t('outfitting.unit.mj', { value: '' }).trim()}
                </span>
              </div>
            )}
            <div>
              {t('outfitting.pips.recharge')}: +{sysRate.toFixed(2)} MW/s
            </div>
          </>,
        )}

        {/* ENG */}
        {renderPipBar(
          'eng',
          t('outfitting.pips.eng'),
          pips.eng,
          '#f59e0b',
          'rgba(245,158,11,0.4)',
          <IconGauge size={13} color="#f59e0b" />,
          <>
            <div>
              {t('outfitting.pips.effSpeed')}:{' '}
              <span style={{ color: '#f59e0b', fontWeight: 700 }}>
                {num(currentSpeed, 0)} {t('outfitting.unit.ms', { value: '' }).trim()}
              </span>
            </div>
            {boostInterval && (
              <div>
                {t('outfitting.pips.boostInterval')}: ~{boostInterval}s
              </div>
            )}
            <div>
              {t('outfitting.pips.recharge')}: +{engRate.toFixed(2)} MW/s
            </div>
          </>,
        )}

        {/* WEP */}
        {renderPipBar(
          'wep',
          t('outfitting.pips.wep'),
          pips.wep,
          '#f43f5e',
          'rgba(244,63,94,0.4)',
          <IconZap size={13} color="#f43f5e" />,
          <>
            <div>
              {t('outfitting.stats.distributor')}: {num(stats.distributor.wep, 1)} MJ
            </div>
            <div>
              {t('outfitting.pips.recharge')}:{' '}
              <span style={{ color: pips.wep > 0 ? '#f43f5e' : 'var(--text)', fontWeight: 700 }}>
                +{wepRate.toFixed(2)} MW/s
              </span>
            </div>
          </>,
        )}
      </div>
    </div>
  );
}
