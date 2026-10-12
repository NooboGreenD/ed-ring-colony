'use client';

import { useState } from 'react';
import { parseRingParam } from '@/lib/atlasRingParams';

interface Props {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** Подсказка под полем (например, что изменится в расчёте). */
  hint?: string;
}

/**
 * Параметр с двумя способами ввода: ползунок и поле с клавиатуры.
 * Оба управляют одним значением. В поле можно печатать любое целое число в
 * диапазоне: применяется по Enter или при потере фокуса, Escape возвращает прежнее.
 */
export function RangeNumberField({ id, label, min, max, step, value, onChange, disabled, hint }: Props) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string) => {
    const parsed = parseRingParam(raw, min, max);
    if (parsed !== null) onChange(parsed);
    setDraft(null);
  };

  return (
    <div className="atlas-search-field">
      <label htmlFor={id}>
        {label}: <strong>{value.toLocaleString('ru-RU')} св.л.</strong>
      </label>
      <div className="atlas-range-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
        />
        <input
          id={`${id}-value`}
          className="atlas-range-number"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft ?? String(value)}
          aria-label={`${label}: ввод с клавиатуры`}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft ?? String(value))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(draft ?? String(value));
            } else if (event.key === 'Escape') {
              setDraft(null);
            }
          }}
          disabled={disabled}
        />
      </div>
      <div className="atlas-range-scale">
        <span>{min.toLocaleString('ru-RU')}</span>
        <span>{max.toLocaleString('ru-RU')}</span>
      </div>
      {hint && <p className="atlas-muted atlas-range-hint">{hint}</p>}
    </div>
  );
}
