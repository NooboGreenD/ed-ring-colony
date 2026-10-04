'use client';

/**
 * Сводка сборки корабля (EDSY / Coriolis style HUD), разложенная по вкладкам:
 *
 *  - «Сводка» — прыжок, ходовые, защита, энергия, трюм и деньги;
 *  - «Атака» — DPS, расход WEP, нагрев, урон по типам, таблица орудий;
 *  - «Защита» — щит и броня с разбором по источникам и сопротивлениям;
 *  - «Графики» — дальность от загрузки, скорость от пипок, деньги и энергия.
 *
 * Над вкладками живёт блок «Управление кораблём» (аналог SHIP CONTROL на
 * coriolis.io): пипки, форсаж, развёрнутые орудия, ползунки груза и
 * топлива. Все цифры во вкладках считаются ровно для этого состояния —
 * иначе сводка описывает корабль, которым никто не летает.
 */

import React, { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  pipAdjustedSpeed,
  sysDamageResistance,
  type BuildStats,
} from '@/lib/outfitting/calc';
import {
  DAMAGE_TYPES,
  cargoCurve,
  costBreakdown,
  defenceSummary,
  engPipCurve,
  fuelCurve,
  offenceSummary,
  powerBreakdown,
  profileAt,
  sysPipCurve,
  type DamageType,
} from '@/lib/outfitting/analysis';
import { mercCoinCost } from '@/lib/outfitting/merccoin';
import { moduleLabel } from '@/lib/outfitting/build';
import type { OutfittingData, PipState, ShipBuild } from '@/lib/outfitting/types';
import ShipControl, { type ShipControlState } from './ShipControl';
import { BarChart, ChartBlock, LineChart } from './Charts';
import {
  IconAlert,
  IconChart,
  IconCoins,
  IconCompass,
  IconCrosshair,
  IconDroplet,
  IconGauge,
  IconPackage,
  IconShield,
  IconShieldHalf,
  IconSparkles,
  IconStats,
  IconSword,
  IconWrench,
  IconZap,
} from '@/components/Icons';
import { LABEL, MONO, PANEL, button, formatters } from './styles';

type TabKey = 'summary' | 'offence' | 'defence' | 'charts';

interface StatsPanelProps {
  data: OutfittingData;
  build: ShipBuild;
  stats: BuildStats;
  shipName: string;
  pips: PipState;
  onPipsChange: (next: PipState) => void;
  control: ShipControlState;
  onControlChange: (next: ShipControlState) => void;
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

const DAMAGE_COLORS: Record<DamageType, string> = {
  absolute: '#e2e8f0',
  kinetic: '#fbbf24',
  thermal: '#f43f5e',
  explosive: '#f97316',
};

const PART_COLORS: Record<string, string> = {
  hull: '#94a3b8',
  core: '#38bdf8',
  hardpoints: '#f43f5e',
  utility: '#c9a0ff',
  internal: '#34d399',
};

export default function StatsPanel({
  data,
  build,
  stats,
  shipName,
  pips,
  onPipsChange,
  control,
  onControlChange,
}: StatsPanelProps) {
  const { t, locale } = useI18n();
  const { num, credits } = formatters(locale);
  const [tab, setTab] = useState<TabKey>('summary');

  const ly = (value: number, digits = 2) => `${num(value, digits)} ${t('outfitting.unit.ly', { value: '' }).trim() || 'ly'}`;
  const ms = (value: number) => `${num(value, 0)} ${t('outfitting.unit.ms', { value: '' }).trim()}`;
  const tons = (value: number, digits = 1) => `${num(value, digits)} ${t('outfitting.unit.t', { value: '' }).trim()}`;
  const mw = (value: number) => `${num(value, 2)} ${t('outfitting.unit.mw', { value: '' }).trim()}`;
  const mj = (value: number, digits = 0) => `${num(value, digits)} ${t('outfitting.unit.mj', { value: '' }).trim()}`;
  const seconds = (value: number, digits = 1) => (Number.isFinite(value) ? `${num(value, digits)} s` : '∞');

  const profile = useMemo(
    () => profileAt(data, build, stats, control.cargo, control.fuel),
    [data, build, stats, control.cargo, control.fuel],
  );
  const offence = useMemo(() => offenceSummary(data, build, stats, pips), [data, build, stats, pips]);
  const defence = useMemo(() => defenceSummary(data, build, stats, pips), [data, build, stats, pips]);
  const mercTotal = useMemo(
    () => mercCoinCost([...build.standard, ...build.hardpoints, ...build.internal]),
    [build],
  );

  const powerUsed = control.deployed ? stats.powerDeployed : stats.powerRetracted;
  const powerRatio = stats.powerCapacity > 0 ? powerUsed / stats.powerCapacity : 0;
  const powerColor = powerRatio > 1 ? 'var(--red)' : powerRatio > 0.9 ? '#f0b37e' : 'var(--green)';

  const speedNow = pipAdjustedSpeed(
    control.boost ? profile.boost : profile.speed,
    stats.pipSpeed,
    pips.eng,
  );
  const sysResPct = sysDamageResistance(pips.sys) * 100;

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'summary', label: t('outfitting.tab.summary'), icon: <IconStats size={11} /> },
    { key: 'offence', label: t('outfitting.tab.offence'), icon: <IconSword size={11} /> },
    { key: 'defence', label: t('outfitting.tab.defence'), icon: <IconShield size={11} /> },
    { key: 'charts', label: t('outfitting.tab.charts'), icon: <IconChart size={11} /> },
  ];

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
              title={t('outfitting.stats.experimental')}
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

      {/* ── УПРАВЛЕНИЕ КОРАБЛЁМ: ПИПКИ, ФОРСАЖ, ЗАГРУЗКА ── */}
      <ShipControl
        stats={stats}
        pips={pips}
        onPipsChange={onPipsChange}
        control={control}
        onControlChange={onControlChange}
      />

      {/* ── ВКЛАДКИ ── */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          marginTop: 10,
          borderBottom: '1px solid var(--line)',
          paddingBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            aria-pressed={tab === entry.key}
            style={{
              ...button(tab === entry.key),
              padding: '3px 7px',
              fontSize: 10,
              letterSpacing: 0.5,
              display: 'flex',
              alignItems: 'center',
              gap: 3,
            }}
          >
            {entry.icon}
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'summary' && (
        <>
          <Block icon={<IconCompass size={12} color="var(--orange)" />} title={t('outfitting.stats.jump')}>
            <Row
              label={t('outfitting.stats.jump.full')}
              value={ly(profile.jumpRange)}
              hint={control.cargo > 0 || control.fuel < stats.fuel ? t('outfitting.control.title').toLowerCase() : undefined}
              accent="var(--orange)"
            />
            <Row label={t('outfitting.stats.jump.max')} value={ly(stats.maxJumpRange)} />
            <Row label={t('outfitting.stats.jump.laden')} value={ly(stats.ladenJumpRange)} />
            <Row label={t('outfitting.stats.jump.total')} value={ly(stats.totalRange, 1)} />
          </Block>

          <Block icon={<IconGauge size={12} color="var(--orange)" />} title={t('outfitting.stats.drive')}>
            <Row
              label={control.boost ? t('outfitting.control.boost') : t('outfitting.stats.speed')}
              value={ms(speedNow)}
              hint={pips.eng < 4 ? `4 ENG: ${num(control.boost ? profile.boost : profile.speed, 0)}` : undefined}
              accent="#f59e0b"
            />
            <Row
              label={control.boost ? t('outfitting.stats.speed') : t('outfitting.control.boost')}
              value={ms(
                control.boost
                  ? pipAdjustedSpeed(profile.speed, stats.pipSpeed, pips.eng)
                  : profile.boost,
              )}
              hint={stats.boostEnergy > 0 ? mj(stats.boostEnergy) : undefined}
            />
            <Row
              label={t('outfitting.stats.mass')}
              value={tons(profile.mass)}
              hint={t('outfitting.stats.ladenMassHint', { value: num(stats.ladenMass, 1) })}
            />
            <Row label={t('outfitting.stats.masslock')} value={String(stats.masslock)} />
          </Block>

          <Block icon={<IconShield size={12} color="var(--cyan)" />} title={t('outfitting.stats.defence')}>
            <Row
              label={t('outfitting.stats.shield')}
              value={mj(defence.shield.total)}
              accent={defence.shield.total > 0 ? 'var(--cyan)' : 'var(--muted)'}
            />
            {defence.shield.total > 0 && (
              <Row
                label={t('outfitting.def.effective')}
                value={mj(defence.shield.effective.base)}
                hint={t('outfitting.def.withPips', { pips: pips.sys.toFixed(1) })}
                accent="#38bdf8"
              />
            )}
            <Row
              label={t('outfitting.stats.shieldRes')}
              value={`${num(stats.shieldResistances.kinetic * 100, 0)} / ${num(stats.shieldResistances.thermal * 100, 0)} / ${num(stats.shieldResistances.explosive * 100, 0)} %`}
              hint={`+${sysResPct.toFixed(0)} % SYS`}
            />
            <Row label={t('outfitting.stats.armour')} value={num(stats.armour, 0)} />
            <Row
              label={t('outfitting.stats.armourRes')}
              value={`${num(stats.armourResistances.kinetic * 100, 0)} / ${num(stats.armourResistances.thermal * 100, 0)} / ${num(stats.armourResistances.explosive * 100, 0)} %`}
            />
          </Block>

          <Block icon={<IconZap size={12} color="var(--orange)" />} title={t('outfitting.stats.power')}>
            <Row label={t('outfitting.stats.powerPlant')} value={mw(stats.powerCapacity)} />
            <Row label={t('outfitting.stats.powerRetracted')} value={mw(stats.powerRetracted)} />
            <Row
              label={t('outfitting.stats.powerDeployed')}
              value={mw(stats.powerDeployed)}
              accent={control.deployed ? powerColor : undefined}
            />
            <div style={{ height: 5, background: 'var(--line)', borderRadius: 2, overflow: 'hidden', margin: '3px 0 5px' }}>
              <div style={{ width: `${Math.min(100, powerRatio * 100)}%`, height: '100%', background: powerColor }} />
            </div>
            <Row
              label={t('outfitting.stats.distributor')}
              value={`${num(stats.distributor.sys, 1)} / ${num(stats.distributor.eng, 1)} / ${num(stats.distributor.wep, 1)}`}
              hint="SYS/ENG/WEP"
            />
          </Block>

          <Block icon={<IconCoins size={12} color="var(--orange)" />} title={t('outfitting.stats.cargoMoney')}>
            <Row
              icon={<IconPackage size={11} />}
              label={t('outfitting.stats.cargo')}
              value={tons(stats.cargo, 0)}
              hint={control.cargo > 0 ? `${num(control.cargo, 0)} ↑` : undefined}
            />
            <Row
              icon={<IconDroplet size={11} />}
              label={t('outfitting.stats.fuel')}
              value={tons(stats.fuel, 0)}
              hint={control.fuel < stats.fuel ? `${num(control.fuel, 1)} ↓` : undefined}
            />
            {stats.passengers > 0 && (
              <Row label={t('outfitting.stats.passengers')} value={String(stats.passengers)} />
            )}
            <Row label={t('outfitting.stats.cost')} value={credits(stats.cost)} accent="var(--orange)" />
            {mercTotal > 0 && (
              <Row
                icon={<IconCoins size={11} />}
                label={t('outfitting.merc.total')}
                value={t('outfitting.merc.coins', { value: num(mercTotal, 0) })}
                accent="#fbbf24"
              />
            )}
          </Block>
        </>
      )}

      {tab === 'offence' && (
        <>
          {offence.weapons.length === 0 ? (
            <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 10 }}>{t('outfitting.off.none')}</p>
          ) : (
            <>
              <Block icon={<IconSword size={12} color="var(--orange)" />} title={t('outfitting.tab.offence')}>
                <Row label={t('outfitting.off.dps')} value={num(offence.dps, 1)} accent="#f43f5e" />
                <Row label={t('outfitting.off.sdps')} value={num(offence.sdps, 1)} />
                <Row label={t('outfitting.off.eps')} value={`${num(offence.eps, 2)} MJ/s`} />
                <Row label={t('outfitting.off.hps')} value={num(offence.hps, 2)} />
                <Row label={t('outfitting.off.dpe')} value={num(offence.dpe, 2)} />
                <Row label={t('outfitting.off.piercing')} value={num(offence.piercing, 0)} />
                <Row
                  label={t('outfitting.off.range')}
                  value={`${num(offence.minRange, 0)} – ${num(offence.maxRange, 0)} m`}
                />
              </Block>

              <Block icon={<IconZap size={12} color="var(--orange)" />} title={t('outfitting.off.wepCap')}>
                <Row label={t('outfitting.off.wepCap')} value={mj(offence.wepCapacity, 1)} />
                <Row
                  label={t('outfitting.off.wepRate')}
                  value={`${num(offence.wepRecharge, 2)} MW`}
                  hint={`${pips.wep.toFixed(1)} WEP`}
                />
                <Row
                  label={t('outfitting.off.sustain')}
                  value={Number.isFinite(offence.sustainTime) ? seconds(offence.sustainTime) : t('outfitting.off.sustainInf')}
                  accent={Number.isFinite(offence.sustainTime) ? '#f0b37e' : 'var(--green)'}
                />
                {Number.isFinite(offence.burstDamage) && (
                  <Row label={t('outfitting.off.burst')} value={num(offence.burstDamage, 0)} />
                )}
              </Block>

              <Block icon={<IconCrosshair size={12} color="var(--orange)" />} title={t('outfitting.off.byType')}>
                <BarChart
                  items={DAMAGE_TYPES.filter((type) => offence.dpsByType[type] > 0).map((type) => ({
                    key: type,
                    label: t(`outfitting.dmg.${type}`),
                    value: offence.dpsByType[type],
                    color: DAMAGE_COLORS[type],
                  }))}
                  format={(value) => num(value, 1)}
                />
              </Block>

              <Block icon={<IconCrosshair size={12} color="var(--orange)" />} title={t('outfitting.off.weapons')}>
                {offence.weapons.map((entry) => (
                  <div
                    key={entry.slot.key}
                    style={{
                      borderBottom: '1px solid var(--line)',
                      padding: '4px 0',
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 8,
                      alignItems: 'baseline',
                    }}
                  >
                    <span style={{ fontSize: 11, color: 'var(--text)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {moduleLabel(data, entry.module, locale)}
                    </span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: '#f43f5e', whiteSpace: 'nowrap' }}>
                      {num(entry.metrics.dps, 1)}
                      <span style={{ color: 'var(--muted)' }}> · {num(entry.metrics.eps, 2)} MJ/s</span>
                    </span>
                  </div>
                ))}
              </Block>
            </>
          )}
        </>
      )}

      {tab === 'defence' && (
        <>
          <Block icon={<IconShield size={12} color="var(--cyan)" />} title={t('outfitting.def.shieldTotal')}>
            {defence.shield.total <= 0 ? (
              <p style={{ fontSize: 11.5, color: 'var(--muted)' }}>{t('outfitting.def.noShield')}</p>
            ) : (
              <>
                <Row label={t('outfitting.def.generator')} value={mj(defence.shield.generator)} />
                {defence.shield.boosters > 0 && (
                  <Row label={t('outfitting.def.boosters')} value={`+${mj(defence.shield.boosters)}`} />
                )}
                {defence.shield.addition > 0 && (
                  <Row label={t('outfitting.def.addition')} value={`+${mj(defence.shield.addition)}`} />
                )}
                <Row label={t('outfitting.def.shieldTotal')} value={mj(defence.shield.total)} accent="var(--cyan)" />
                {defence.shield.cells > 0 && (
                  <Row label={t('outfitting.def.cells')} value={mj(defence.shield.cells)} accent="#38bdf8" />
                )}
                <Row
                  label={t('outfitting.def.effective')}
                  value={mj(defence.shield.effective.base)}
                  hint={t('outfitting.def.withPips', { pips: pips.sys.toFixed(1) })}
                  accent="#38bdf8"
                />
                <Row label={t('outfitting.def.recover')} value={seconds(defence.shield.recoverTime, 0)} />
                <Row label={t('outfitting.def.recharge')} value={seconds(defence.shield.rechargeTime, 0)} />
              </>
            )}
          </Block>

          {defence.shield.total > 0 && (
            <Block icon={<IconShieldHalf size={12} color="var(--cyan)" />} title={t('outfitting.stats.shieldRes')}>
              {(['kinetic', 'thermal', 'explosive', 'caustic'] as const).map((type) => (
                <Row
                  key={type}
                  label={t(`outfitting.dmg.${type}`)}
                  value={`${num(defence.shield.withPips[type] * 100, 1)} %`}
                  hint={mj(defence.shield.effective[type])}
                />
              ))}
            </Block>
          )}

          <Block icon={<IconShieldHalf size={12} color="var(--orange)" />} title={t('outfitting.def.armourTotal')}>
            <Row label={t('outfitting.def.armourTotal')} value={num(defence.armour.total, 0)} accent="var(--orange)" />
            {(['kinetic', 'thermal', 'explosive', 'caustic'] as const).map((type) => (
              <Row
                key={type}
                label={t(`outfitting.dmg.${type}`)}
                value={`${num(defence.armour.resistances[type] * 100, 1)} %`}
                hint={num(defence.armour.effective[type], 0)}
              />
            ))}
            {defence.armour.moduleArmour > 0 && (
              <Row label={t('outfitting.def.moduleArmour')} value={num(defence.armour.moduleArmour, 0)} />
            )}
            {defence.armour.moduleProtection > 0 && (
              <Row
                label={t('outfitting.def.moduleProtection')}
                value={`${num(defence.armour.moduleProtection * 100, 1)} %`}
              />
            )}
          </Block>

          <Block icon={<IconStats size={12} color="var(--orange)" />} title={t('outfitting.def.total')}>
            <Row
              label={t('outfitting.def.total')}
              value={num(defence.totalEffective, 0)}
              accent="var(--green)"
            />
          </Block>
        </>
      )}

      {tab === 'charts' && (
        <ChartsTab
          data={data}
          build={build}
          stats={stats}
          pips={pips}
          control={control}
          num={num}
          credits={credits}
          t={t}
          shieldBase={defence.shield.total}
          shieldResistance={defence.shield.resistances.kinetic}
        />
      )}
    </div>
  );
}

/** Вкладка графиков вынесена отдельно: расчёты нужны только когда она открыта. */
function ChartsTab({
  data,
  build,
  stats,
  pips,
  control,
  num,
  credits,
  t,
  shieldBase,
  shieldResistance,
}: {
  data: OutfittingData;
  build: ShipBuild;
  stats: BuildStats;
  pips: PipState;
  control: ShipControlState;
  num: (value: number, digits?: number) => string;
  credits: (value: number) => string;
  t: (key: string, params?: Record<string, string | number>) => string;
  shieldBase: number;
  shieldResistance: number;
}) {
  const cargo = useMemo(() => cargoCurve(data, build, stats), [data, build, stats]);
  const fuel = useMemo(() => fuelCurve(data, build, stats), [data, build, stats]);
  const engPips = useMemo(() => engPipCurve(stats), [stats]);
  const sysPips = useMemo(() => sysPipCurve(shieldBase, shieldResistance), [shieldBase, shieldResistance]);
  const cost = useMemo(() => costBreakdown(data, build), [data, build]);
  const power = useMemo(() => powerBreakdown(data, build), [data, build]);

  const tonUnit = t('outfitting.unit.t', { value: '' }).trim();

  return (
    <div>
      {stats.cargo > 0 && (
        <ChartBlock title={t('outfitting.chart.cargo')}>
          <LineChart
            series={[{
              key: 'jump',
              label: t('outfitting.chart.cargo'),
              color: 'var(--orange)',
              points: cargo.map((point) => ({ x: point.cargo, y: point.jumpRange })),
            }]}
            xUnit={tonUnit}
            formatX={(value) => num(value, 0)}
            formatY={(value) => num(value, 1)}
            marker={{ x: control.cargo }}
          />
        </ChartBlock>
      )}

      <ChartBlock title={t('outfitting.chart.fuel')}>
        <LineChart
          series={[{
            key: 'jump',
            label: t('outfitting.chart.fuel'),
            color: '#38bdf8',
            points: fuel.map((point) => ({ x: point.fuel, y: point.jumpRange })),
          }]}
          xUnit={tonUnit}
          formatX={(value) => num(value, 0)}
          formatY={(value) => num(value, 1)}
          marker={{ x: control.fuel }}
        />
      </ChartBlock>

      <ChartBlock
        title={t('outfitting.chart.engPips')}
        legend={[
          { label: t('outfitting.chart.speedLine'), color: '#f59e0b' },
          { label: t('outfitting.chart.boostLine'), color: '#f43f5e' },
        ]}
      >
        <LineChart
          series={[
            {
              key: 'speed',
              label: t('outfitting.chart.speedLine'),
              color: '#f59e0b',
              points: engPips.map((point) => ({ x: point.pips, y: point.speed })),
            },
            {
              key: 'boost',
              label: t('outfitting.chart.boostLine'),
              color: '#f43f5e',
              points: engPips.map((point) => ({ x: point.pips, y: point.boost })),
            },
          ]}
          formatX={(value) => num(value, 0)}
          formatY={(value) => num(value, 0)}
          marker={{ x: pips.eng }}
        />
      </ChartBlock>

      {shieldBase > 0 && (
        <ChartBlock title={t('outfitting.chart.sysPips')}>
          <LineChart
            series={[{
              key: 'shield',
              label: t('outfitting.chart.sysPips'),
              color: 'var(--cyan)',
              points: sysPips.map((point) => ({ x: point.pips, y: point.value })),
            }]}
            formatX={(value) => num(value, 0)}
            formatY={(value) => num(value, 0)}
            marker={{ x: pips.sys }}
          />
        </ChartBlock>
      )}

      <ChartBlock title={t('outfitting.chart.cost')}>
        <BarChart
          items={cost.map((entry) => ({
            key: entry.key,
            label: t(`outfitting.part.${entry.key}`),
            value: entry.value,
            color: PART_COLORS[entry.key] ?? 'var(--orange)',
          }))}
          format={credits}
        />
      </ChartBlock>

      {power.length > 0 && (
        <ChartBlock title={t('outfitting.chart.power')}>
          <BarChart
            items={power.map((entry) => ({
              key: entry.key,
              label: t(`outfitting.part.${entry.key}`),
              value: entry.value,
              color: PART_COLORS[entry.key] ?? 'var(--orange)',
            }))}
            format={(value) => `${num(value, 2)} MW`}
          />
        </ChartBlock>
      )}
    </div>
  );
}
