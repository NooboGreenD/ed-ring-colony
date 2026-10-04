'use client';

/**
 * «Управление кораблём» — аналог блока SHIP CONTROL на coriolis.io.
 *
 * Сводка считается не для абстрактного корабля, а для того состояния, в
 * котором он сейчас летит: сколько в трюме груза, сколько осталось топлива,
 * выпущены ли орудия и нажат ли форсаж. Пипки живут здесь же — форсаж без
 * них не имеет смысла, потому что заряд на него берётся из ENG.
 *
 * Состояние поднято в `OutfittingWorkspace`: от него зависят и правая
 * сводка, и графики, поэтому хранить его внутри виджета нельзя.
 */

import React from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { BuildStats } from '@/lib/outfitting/calc';
import type { PipState } from '@/lib/outfitting/types';
import PowerDistributorPips from './PowerDistributorPips';
import { IconCrosshair, IconDroplet, IconPackage, IconRefreshCw, IconRocket } from '@/components/Icons';
import { MONO, button, formatters } from './styles';

export interface ShipControlState {
  /** Нажат форсаж: скорость и расход ENG считаются по нему. */
  boost: boolean;
  /** Орудия выпущены: потребление энергии считается по развёрнутому. */
  deployed: boolean;
  /** Груз в трюме, т. */
  cargo: number;
  /** Остаток топлива, т. */
  fuel: number;
}

/** Корабль как он сходит со стапеля: пустой трюм, полный бак, орудия убраны. */
export function defaultShipControl(stats: BuildStats): ShipControlState {
  return { boost: false, deployed: false, cargo: 0, fuel: stats.fuel };
}

/** Хватает ли заряда распределителя на форсаж. */
export function canBoost(stats: BuildStats): boolean {
  return stats.boostEnergy > 0 && stats.distributor.eng >= stats.boostEnergy;
}

function Slider({
  icon,
  label,
  value,
  max,
  unit,
  onChange,
  format,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  max: number;
  unit: string;
  onChange: (next: number) => void;
  format: (value: number) => string;
}) {
  if (max <= 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 10.5,
          color: 'var(--muted)',
          marginBottom: 2,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {icon}
          {label}
        </span>
        <span style={{ fontFamily: MONO, color: 'var(--text)' }}>
          {format(value)} / {format(max)} {unit}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={max}
        step={max > 20 ? 1 : 0.5}
        value={Math.min(value, max)}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={label}
        style={{ width: '100%', margin: 0, accentColor: 'var(--orange)' }}
      />
    </div>
  );
}

interface ShipControlProps {
  stats: BuildStats;
  pips: PipState;
  onPipsChange: (next: PipState) => void;
  control: ShipControlState;
  onControlChange: (next: ShipControlState) => void;
}

export default function ShipControl({
  stats,
  pips,
  onPipsChange,
  control,
  onControlChange,
}: ShipControlProps) {
  const { t, locale } = useI18n();
  const { num } = formatters(locale);
  const boostAvailable = canBoost(stats);
  const tons = t('outfitting.unit.t', { value: '' }).trim();

  return (
    <div>
      <PowerDistributorPips stats={stats} pips={pips} onChange={onPipsChange} compact />

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
        <button
          type="button"
          disabled={!boostAvailable}
          aria-pressed={control.boost}
          onClick={() => onControlChange({ ...control, boost: !control.boost })}
          title={boostAvailable ? undefined : t('outfitting.control.noBoost')}
          style={{
            ...button(control.boost, '#f59e0b'),
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            opacity: boostAvailable ? 1 : 0.4,
            cursor: boostAvailable ? 'pointer' : 'not-allowed',
          }}
        >
          <IconRocket size={12} color={control.boost ? '#f59e0b' : 'var(--muted)'} />
          {t('outfitting.control.boost')}
        </button>

        <button
          type="button"
          aria-pressed={control.deployed}
          onClick={() => onControlChange({ ...control, deployed: !control.deployed })}
          style={{
            ...button(control.deployed, '#f43f5e'),
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
          }}
        >
          <IconCrosshair size={12} color={control.deployed ? '#f43f5e' : 'var(--muted)'} />
          {t('outfitting.control.deployed')}
        </button>

        <button
          type="button"
          onClick={() => onControlChange({ boost: false, deployed: false, cargo: 0, fuel: stats.fuel })}
          style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}
        >
          <IconRefreshCw size={11} />
          {t('outfitting.control.reset')}
        </button>
      </div>

      <Slider
        icon={<IconPackage size={11} />}
        label={t('outfitting.control.cargo')}
        value={control.cargo}
        max={stats.cargo}
        unit={tons}
        onChange={(next) => onControlChange({ ...control, cargo: next })}
        format={(value) => num(value, 0)}
      />
      <Slider
        icon={<IconDroplet size={11} />}
        label={t('outfitting.control.fuel')}
        value={control.fuel}
        max={stats.fuel}
        unit={tons}
        onChange={(next) => onControlChange({ ...control, fuel: next })}
        format={(value) => num(value, 1)}
      />
    </div>
  );
}
