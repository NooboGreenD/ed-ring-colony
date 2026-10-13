'use client';

import { RangeNumberField } from './RangeNumberField';
import { SystemSearchInput } from './SystemSearchInput';
import { IconRefresh } from '@/components/Icons';

interface Props {
  centerSystem: string;
  onCenterChange: (value: string) => void;
  heightOffset: number;
  onHeightChange: (value: number) => void;
  tiltDegrees: number;
  onTiltChange: (value: number) => void;
  tiltAxisDegrees: number;
  onAxisChange: (value: number) => void;
  disabled?: boolean;
}

const PRESETS = [
  { label: 'Плоское', tilt: 0, axis: 0 },
  { label: 'Вдоль +30°', tilt: 30, axis: 0 },
  { label: 'Вдоль −30°', tilt: -30, axis: 0 },
  { label: 'Поперёк +30°', tilt: 30, axis: 90 },
  { label: 'Поперёк −30°', tilt: -30, axis: 90 },
  { label: 'Вертикальное', tilt: 90, axis: 0 },
];

export function RingGeometryControls({ centerSystem, onCenterChange, heightOffset, onHeightChange,
  tiltDegrees, onTiltChange, tiltAxisDegrees, onAxisChange, disabled }: Props) {
  const reset = () => {
    onCenterChange(''); onHeightChange(0); onTiltChange(0); onAxisChange(0);
  };
  return (
    <details className="atlas-advanced-fields atlas-ring-geometry" open>
      <summary>
        <span>Геометрия кольца</span>
        <span className="atlas-ring-geometry-meta">{tiltDegrees}° / ось {tiltAxisDegrees}°</span>
      </summary>
      <div className="atlas-advanced-body">
        <p className="atlas-muted">Знак наклона задаёт сторону, направление оси — поворот плоскости.
          Все изменения сразу видны на карте.</p>
        <div className="atlas-ring-presets" role="group" aria-label="Быстрые положения кольца">
          {PRESETS.map(preset => (
            <button type="button" key={preset.label} className="atlas-preset"
              aria-pressed={tiltDegrees === preset.tilt && tiltAxisDegrees === preset.axis}
              disabled={disabled} onClick={() => { onTiltChange(preset.tilt); onAxisChange(preset.axis); }}>
              {preset.label}
            </button>
          ))}
        </div>
        <RangeNumberField id="ring-tilt" label="Наклон плоскости" unit="°"
          min={-180} max={180} step={1} value={tiltDegrees} onChange={onTiltChange} disabled={disabled}
          hint="0° — плоское; ±90° — вертикальное; ±180° — перевёрнутое. Минус наклоняет в противоположную сторону." />
        <RangeNumberField id="ring-tilt-axis" label="Направление оси наклона" unit="°"
          min={0} max={359} step={1} value={tiltAxisDegrees} onChange={onAxisChange} disabled={disabled}
          hint="0° — ось от центра к старту; 90° — поперечная. Любой угол поворачивает ось вокруг центра кольца." />
        <div className="atlas-ring-geometry-actions">
          <button type="button" className="atlas-secondary-btn" disabled={disabled} onClick={() => onTiltChange(-tiltDegrees)}>
            Обратить наклон
          </button>
          <button type="button" className="atlas-secondary-btn" disabled={disabled} onClick={reset}>
            <IconRefresh size={12} /> Сбросить геометрию
          </button>
        </div>
        <SystemSearchInput label="Центр расчёта" value={centerSystem} onChange={onCenterChange}
          disabled={disabled} placeholder="Sagittarius A* (по умолчанию)" />
        <RangeNumberField id="ring-height" label="Смещение центра по высоте"
          min={-5000} max={5000} step={100} value={heightOffset} onChange={onHeightChange} disabled={disabled}
          hint="Относительно выбранной системы-центра. Поиск и превью одинаково ограничивают высоту с учётом толщины диска." />
      </div>
    </details>
  );
}
