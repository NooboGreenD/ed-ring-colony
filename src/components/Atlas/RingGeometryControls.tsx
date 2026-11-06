'use client';

import { RangeNumberField } from './RangeNumberField';
import { SystemSearchInput } from './SystemSearchInput';
import { IconRefresh } from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';

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
  { labelKey: 'atlas.ui.ringFlat', tilt: 0, axis: 0 },
  { labelKey: 'atlas.ui.ringAlongPlus', tilt: 30, axis: 0 },
  { labelKey: 'atlas.ui.ringAlongMinus', tilt: -30, axis: 0 },
  { labelKey: 'atlas.ui.ringAcrossPlus', tilt: 30, axis: 90 },
  { labelKey: 'atlas.ui.ringAcrossMinus', tilt: -30, axis: 90 },
  { labelKey: 'atlas.ui.ringVertical', tilt: 90, axis: 0 },
];

export function RingGeometryControls({ centerSystem, onCenterChange, heightOffset, onHeightChange,
  tiltDegrees, onTiltChange, tiltAxisDegrees, onAxisChange, disabled }: Props) {
  const { t } = useI18n();
  const reset = () => {
    onCenterChange(''); onHeightChange(0); onTiltChange(0); onAxisChange(0);
  };
  return (
    <details className="atlas-advanced-fields atlas-ring-geometry" open>
      <summary>
        <span>{t('atlas.ui.ringGeometry')}</span>
        <span className="atlas-ring-geometry-meta">{t('atlas.ui.ringGeometryMeta', { tilt: tiltDegrees, axis: tiltAxisDegrees })}</span>
      </summary>
      <div className="atlas-advanced-body">
        <p className="atlas-muted">{t('atlas.ui.ringGeometryHint')}</p>
        <div className="atlas-ring-presets" role="group" aria-label={t('atlas.ui.ringPresetsAria')}>
          {PRESETS.map(preset => (
            <button type="button" key={preset.labelKey} className="atlas-preset"
              aria-pressed={tiltDegrees === preset.tilt && tiltAxisDegrees === preset.axis}
              disabled={disabled} onClick={() => { onTiltChange(preset.tilt); onAxisChange(preset.axis); }}>
              {t(preset.labelKey)}
            </button>
          ))}
        </div>
        <RangeNumberField id="ring-tilt" label={t('atlas.ui.tiltLabel')} unit="°"
          min={-180} max={180} step={1} value={tiltDegrees} onChange={onTiltChange} disabled={disabled}
          hint={t('atlas.ui.tiltHint')} />
        <RangeNumberField id="ring-tilt-axis" label={t('atlas.ui.tiltAxisLabel')} unit="°"
          min={0} max={359} step={1} value={tiltAxisDegrees} onChange={onAxisChange} disabled={disabled}
          hint={t('atlas.ui.tiltAxisHint')} />
        <div className="atlas-ring-geometry-actions">
          <button type="button" className="atlas-secondary-btn" disabled={disabled} onClick={() => onTiltChange(-tiltDegrees)}>
            {t('atlas.ui.invertTilt')}
          </button>
          <button type="button" className="atlas-secondary-btn" disabled={disabled} onClick={reset}>
            <IconRefresh size={12} /> {t('atlas.ui.resetGeometry')}
          </button>
        </div>
        <SystemSearchInput label={t('atlas.ui.centerLabel')} value={centerSystem} onChange={onCenterChange}
          disabled={disabled} placeholder={t('atlas.ui.centerPlaceholder')} />
        <RangeNumberField id="ring-height" label={t('atlas.ui.heightLabel')}
          min={-5000} max={5000} step={100} value={heightOffset} onChange={onHeightChange} disabled={disabled}
          hint={t('atlas.ui.heightHint')} />
      </div>
    </details>
  );
}
