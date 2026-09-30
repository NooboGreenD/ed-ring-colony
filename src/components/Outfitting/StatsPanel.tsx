'use client';

/**
 * Сводка сборки корабля (EDSY-style HUD):
 *
 *  - Интерактивный распределитель питания («Пипки»);
 *  - Прыжковые характеристики (дальность на полном баке, макс., с грузом, запас хода);
 *  - Ходовые характеристики (скорость с учётом пипок ENG, буст, интервал перезарядки);
 *  - Защитные характеристики (сырой щит, эффективный щит с учётом пипок SYS, сопротивления, броня);
 *  - Энергетический баланс (реактор, развёрнутые/сложенные орудия, конденсаторы);
 *  - Трюм и финансы.
 */

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  pipAdjustedSpeed,
  pipEffectiveShield,
  sysDamageResistance,
  type BuildStats,
  type BuildWarning,
} from '@/lib/outfitting/calc';
import type { PipState } from '@/lib/outfitting/types';
import PowerDistributorPips from './PowerDistributorPips';
import {
  IconAlert,
  IconCoins,
  IconCompass,
  IconCrosshair,
  IconDroplet,
  IconGauge,
  IconLayers,
  IconPackage,
  IconRocket,
  IconShield,
  IconShieldHalf,
  IconSparkles,
  IconWrench,
  IconZap,
} from '@/components/Icons';
import { LABEL, MONO, PANEL, formatters } from './styles';

interface StatsPanelProps {
  stats: BuildStats;
  shipName: string;
  pips: PipState;
  onPipsChange: (next: PipState) => void;
}

function Row({
  icon,
  label,
  value,
  hint,
  accent,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint?: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 6,
        padding: '3px 0',
      }}
    >
      <span
        style={{
          fontSize: 11.5,
          color: 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        {icon && <span style={{ opacity: 0.8 }}>{icon}</span>}
        {label}
      </span>
      <span
        style={{
          fontSize: 12,
          color: accent ?? 'var(--text)',
          fontFamily: MONO,
          textAlign: 'right',
          fontWeight: accent ? 700 : 400,
        }}
      >
        {value}
        {hint ? <span style={{ color: 'var(--muted)', fontSize: 10, fontWeight: 400 }}> {hint}</span> : null}
      </span>
    </div>
  );
}

function Block({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 7, marginTop: 7 }}>
      <div
        style={{
          ...LABEL,
          fontSize: 10.5,
          marginBottom: 4,
          color: 'var(--orange)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
        }}
      >
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

export default function StatsPanel({
  stats,
  shipName,
  pips,
  onPipsChange,
}: StatsPanelProps) {
  const { t, locale } = useI18n();
  const { num, credits } = formatters(locale);

  const powerRatio = stats.powerCapacity > 0 ? stats.powerDeployed / stats.powerCapacity : 0;
  const powerColor = powerRatio > 1 ? 'var(--red)' : powerRatio > 0.9 ? '#f0b37e' : 'var(--green)';

  const ly = (value: number, digits = 2) => `${num(value, digits)} св.л`;
  const ms = (value: number) => `${num(value, 0)} м/с`;
  const tons = (value: number, digits = 1) => `${num(value, digits)} т`;
  const mw = (value: number) => `${num(value, 2)} МВт`;

  // Расчётные величины под пипки
  const curSpeed = pipAdjustedSpeed(stats.speed, stats.pipSpeed, pips.eng);
  const curLadenSpeed = pipAdjustedSpeed(stats.ladenSpeed, stats.pipSpeed, pips.eng);
  const effShield = pipEffectiveShield(stats.shield, pips.sys);
  const sysResPct = sysDamageResistance(pips.sys) * 100;

  return (
    <div style={{ ...PANEL, position: 'sticky', top: 12, padding: '12px 14px' }}>
      {/* Шапка корабля */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, letterSpacing: 0.5, color: '#f8fafc' }}>
          {shipName}
        </div>
        <div style={{ display: 'flex', gap: 6, fontSize: 11, fontFamily: MONO }}>
          {stats.engineered > 0 && (
            <span
              style={{
                color: 'var(--green)',
                background: 'rgba(46,204,113,0.12)',
                border: '1px solid rgba(46,204,113,0.3)',
                borderRadius: 2,
                padding: '1px 5px',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
              title={t('outfitting.stats.engineered')}
            >
              <IconWrench size={10} color="var(--green)" /> {stats.engineered}
            </span>
          )}
          {stats.experimental > 0 && (
            <span
              style={{
                color: '#c9a0ff',
                background: 'rgba(201,160,255,0.12)',
                border: '1px solid rgba(201,160,255,0.3)',
                borderRadius: 2,
                padding: '1px 5px',
                display: 'flex',
                alignItems: 'center',
                gap: 3,
              }}
              title="Экспериментальные эффекты"
            >
              <IconSparkles size={10} color="#c9a0ff" /> {stats.experimental}
            </span>
          )}
        </div>
      </div>

      {/* Предупреждения сборки */}
      {stats.warnings.map((warning) => (
        <div
          key={warning.code}
          style={{
            fontSize: 10.5,
            color: '#f0b37e',
            border: '1px solid rgba(240,179,126,0.4)',
            background: 'rgba(240,179,126,0.08)',
            borderRadius: 3,
            padding: '4px 7px',
            marginBottom: 6,
            lineHeight: 1.35,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <IconAlert size={12} color="#f0b37e" />
          <span>{t(`outfitting.warn.${warning.code}`, { value: warning.value ?? '' })}</span>
        </div>
      ))}

      {/* ── ИНТЕРАКТИВНЫЙ РАСПРЕДЕЛИТЕЛЬ ПИТАНИЯ (ПИПКИ) ── */}
      <PowerDistributorPips stats={stats} pips={pips} onChange={onPipsChange} compact />

      {/* ── ПРЫЖОК ── */}
      <Block icon={<IconCompass size={12} color="var(--orange)" />} title={t('outfitting.stats.jump')}>
        <Row
          label={t('outfitting.stats.jump.full')}
          value={ly(stats.jumpRange)}
          accent="var(--orange)"
        />
        <Row label={t('outfitting.stats.jump.max')} value={ly(stats.maxJumpRange)} />
        <Row label={t('outfitting.stats.jump.laden')} value={ly(stats.ladenJumpRange)} />
        <Row label={t('outfitting.stats.jump.total')} value={ly(stats.totalRange, 1)} />
      </Block>

      {/* ── ХОДОВЫЕ (СКОРОСТЬ И ДВИГАТЕЛИ) ── */}
      <Block icon={<IconGauge size={12} color="var(--orange)" />} title={t('outfitting.stats.drive')}>
        <Row
          label={t('outfitting.stats.speed')}
          value={ms(curSpeed)}
          hint={pips.eng < 4 ? `(4 ENG: ${num(stats.speed, 0)})` : undefined}
          accent="#f59e0b"
        />
        <Row
          label="Буст (Boost)"
          value={ms(stats.boost)}
          hint={stats.boostEnergy > 0 ? `(${stats.boostEnergy} МДж)` : undefined}
          accent="#f59e0b"
        />
        {stats.cargo > 0 && (
          <Row
            label={t('outfitting.stats.ladenSpeed')}
            value={ms(curLadenSpeed)}
            hint={pips.eng < 4 ? `(4 ENG: ${num(stats.ladenSpeed, 0)})` : undefined}
          />
        )}
        <Row
          label={t('outfitting.stats.mass')}
          value={tons(stats.unladenMass)}
          hint={t('outfitting.stats.ladenMassHint', { value: num(stats.ladenMass, 1) })}
        />
        <Row label={t('outfitting.stats.masslock')} value={String(stats.masslock)} />
      </Block>

      {/* ── ЗАЩИТА (ЩИТЫ И БРОНЯ) ── */}
      <Block icon={<IconShield size={12} color="var(--cyan)" />} title={t('outfitting.stats.defence')}>
        <Row
          label={t('outfitting.stats.shield')}
          value={`${num(stats.shield, 0)} МДж`}
          accent={stats.shield > 0 ? 'var(--cyan)' : 'var(--muted)'}
        />
        {stats.shield > 0 && pips.sys > 0 && (
          <Row
            label={`Эфф. щит (${pips.sys.toFixed(1)} SYS)`}
            value={`${num(effShield, 0)} МДж`}
            hint={`(+${sysResPct.toFixed(0)}% сопр)`}
            accent="#38bdf8"
          />
        )}
        <Row
          label={t('outfitting.stats.shieldRes')}
          value={`${num(stats.shieldResistances.kinetic * 100, 0)}% / ${num(stats.shieldResistances.thermal * 100, 0)}% / ${num(stats.shieldResistances.explosive * 100, 0)}%`}
          hint="кин/терм/взр"
        />
        <Row
          label={t('outfitting.stats.armour')}
          value={`${num(stats.armour, 0)}`}
          accent="var(--text)"
        />
        <Row
          label={t('outfitting.stats.armourRes')}
          value={`${num(stats.armourResistances.kinetic * 100, 0)}% / ${num(stats.armourResistances.thermal * 100, 0)}% / ${num(stats.armourResistances.explosive * 100, 0)}%`}
          hint="кин/терм/взр"
        />
      </Block>

      {/* ── ЭНЕРГИЯ И РАСПРЕДЕЛИТЕЛЬ ── */}
      <Block icon={<IconZap size={12} color="var(--orange)" />} title={t('outfitting.stats.power')}>
        <Row label={t('outfitting.stats.powerPlant')} value={mw(stats.powerCapacity)} />
        <Row label={t('outfitting.stats.powerRetracted')} value={mw(stats.powerRetracted)} />
        <Row
          label={t('outfitting.stats.powerDeployed')}
          value={mw(stats.powerDeployed)}
          accent={powerColor}
        />
        <div style={{ height: 5, background: 'var(--line)', borderRadius: 2, overflow: 'hidden', margin: '3px 0 5px' }}>
          <div style={{ width: `${Math.min(100, powerRatio * 100)}%`, height: '100%', background: powerColor }} />
        </div>
        <Row
          label={t('outfitting.stats.distributor')}
          value={`${num(stats.distributor.sys, 1)} / ${num(stats.distributor.eng, 1)} / ${num(stats.distributor.wep, 1)}`}
          hint="SYS/ENG/WEP (MJ)"
        />
      </Block>

      {/* ── ТРЮМ И ДЕНЬГИ ── */}
      <Block icon={<IconCoins size={12} color="var(--orange)" />} title={t('outfitting.stats.cargoMoney')}>
        <Row
          icon={<IconPackage size={11} />}
          label={t('outfitting.stats.cargo')}
          value={`${stats.cargo} т`}
        />
        <Row
          icon={<IconDroplet size={11} />}
          label={t('outfitting.stats.fuel')}
          value={tons(stats.fuel, 0)}
        />
        {stats.passengers > 0 && (
          <Row label={t('outfitting.stats.passengers')} value={`${stats.passengers}`} />
        )}
        <Row
          label={t('outfitting.stats.cost')}
          value={credits(stats.cost)}
          accent="var(--orange)"
        />
      </Block>
    </div>
  );
}
