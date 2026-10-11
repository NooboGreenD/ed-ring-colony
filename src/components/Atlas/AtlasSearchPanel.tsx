'use client';

import { useEffect, useMemo, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { IconAlert, IconBolt } from '@/components/Icons';
import type { WorldType } from '@/types/atlas';

const WORLD_TYPE_OPTIONS: { value: WorldType; label: string; color: string }[] = [
  { value: 'earth_like', label: 'Earth-like', color: '#4caf50' },
  { value: 'water_world', label: 'Water World', color: '#2196f3' },
  { value: 'ammonia', label: 'Ammonia World', color: '#ff9800' },
  { value: 'terraformable', label: 'Terraformable', color: '#8bc34a' },
  { value: 'neutron_star', label: 'Neutron Star', color: '#00bcd4' },
  { value: 'black_hole', label: 'Black Hole', color: '#9c27b0' },
  { value: 'white_dwarf', label: 'White Dwarf', color: '#e0e0e0' },
  { value: 'wolf_rayet', label: 'Wolf-Rayet', color: '#ff5722' },
];

const ROCKY_OPTIONS: { value: WorldType; label: string; color: string }[] = [
  { value: 'rocky_atmosphere', label: 'Rocky + Atmosphere', color: '#a1887f' },
  { value: 'rocky_bio', label: 'Rocky + Biology', color: '#66bb6a' },
];

const STAR_OPTIONS: { value: WorldType; label: string; color: string }[] = [
  { value: 'herbig_ae_be', label: 'Herbig Ae/Be', color: '#ba68c8' },
  { value: 't_tauri', label: 'T Tauri', color: '#7986cb' },
  { value: 'proto_star', label: 'Proto Star', color: '#4dd0e1' },
  { value: 'carbon_star', label: 'Carbon Star', color: '#ff8a65' },
  { value: 'supergiant', label: 'Supergiant', color: '#ffd54f' },
  { value: 'giant', label: 'Giant', color: '#ffb74d' },
];

/** Быстрые точки отсчёта: чаще всего ищут именно от них. */
const PRESETS = ['Sol', 'Colonia', 'Sagittarius A*', 'Beagle Point', 'Shinrarta Dezhra'];

const LAST_SEARCH_KEY = 'atlas:last-search';

interface SearchDraft {
  reference_system: string;
  cube_size_ly: number;
  world_types: WorldType[];
  require_landable?: boolean;
  min_estimated_value?: number;
  max_distance_to_arrival?: number;
}

interface AtlasSearchPanelProps {
  onSearch: (params: SearchDraft) => void;
  loading?: boolean;
  /**
   * Прогресс поиска. Оценка по таймеру остаётся как запасной вариант, но когда
   * сервер отдаёт реальный этап (`progress` сессии), показываем именно его —
   * поиск идёт в фоне, и выдуманный процент вводил в заблуждение.
   */
  progress?: {
    elapsedMs: number;
    phase: string;
    found: number;
    status: string;
    serverPercent?: number;
    serverMessage?: string;
  };
}

export function AtlasSearchPanel({ onSearch, loading, progress }: AtlasSearchPanelProps) {
  const [refSystem, setRefSystem] = useState('Sol');
  const [cubeSize, setCubeSize] = useState(500);
  const [selectedTypes, setSelectedTypes] = useState<WorldType[]>(['earth_like']);
  const [requireLandable, setRequireLandable] = useState(false);
  const [minValue, setMinValue] = useState(0);
  const [maxDist, setMaxDist] = useState(0);
  const [touched, setTouched] = useState(false);

  // Помним последний запрос: возвращаться в раздел удобнее с теми же полями.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAST_SEARCH_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as SearchDraft;
      if (saved.reference_system) setRefSystem(String(saved.reference_system));
      if (Number.isFinite(saved.cube_size_ly)) setCubeSize(Number(saved.cube_size_ly));
      if (Array.isArray(saved.world_types) && saved.world_types.length > 0) setSelectedTypes(saved.world_types);
      if (typeof saved.require_landable === 'boolean') setRequireLandable(saved.require_landable);
      if (Number.isFinite(saved.min_estimated_value)) setMinValue(Number(saved.min_estimated_value));
      if (Number.isFinite(saved.max_distance_to_arrival)) setMaxDist(Number(saved.max_distance_to_arrival));
    } catch {
      // Нечитаемая запись ничего не ломает — остаются значения по умолчанию.
    }
  }, []);

  const toggleType = (type: WorldType) => {
    setSelectedTypes((previous) => (
      previous.includes(type) ? previous.filter((item) => item !== type) : [...previous, type]
    ));
  };

  const validationError = useMemo(() => {
    if (!refSystem.trim()) return 'Укажите систему отсчёта';
    if (selectedTypes.length === 0) return 'Выберите хотя бы один тип мира';
    if (cubeSize < 100) return 'Размер области — минимум 100 св.л.';
    return null;
  }, [cubeSize, refSystem, selectedTypes.length]);

  const handleSubmit = () => {
    setTouched(true);
    if (validationError) return;
    const draft: SearchDraft = {
      reference_system: refSystem.trim(),
      cube_size_ly: cubeSize,
      world_types: selectedTypes,
      require_landable: requireLandable || undefined,
      min_estimated_value: minValue > 0 ? minValue : undefined,
      max_distance_to_arrival: maxDist > 0 ? maxDist : undefined,
    };
    try {
      window.localStorage.setItem(LAST_SEARCH_KEY, JSON.stringify(draft));
    } catch {
      // ignore
    }
    onSearch(draft);
  };

  const progressPercent = loading && progress
    ? (Number.isFinite(progress.serverPercent)
      ? Math.max(1, Math.min(99, Number(progress.serverPercent)))
      : Math.min(96, 12 + (progress.elapsedMs / 45_000) * 70))
    : 0;

  return (
    <div className="atlas-search-panel">
      <h3>Поиск миров</h3>

      <SystemSearchInput
        label="Система отсчёта"
        value={refSystem}
        onChange={setRefSystem}
        placeholder="Sol, Colonia, Sagittarius A*…"
        hint={selectedTypes.length > 1 ? `Типов выбрано: ${selectedTypes.length}` : undefined}
        onSubmit={() => handleSubmit()}
      />

      <div className="atlas-preset-row" role="group" aria-label="Быстрые системы">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`atlas-preset${refSystem.trim().toLowerCase() === preset.toLowerCase() ? ' active' : ''}`}
            onClick={() => setRefSystem(preset)}
          >
            {preset}
          </button>
        ))}
      </div>

      <div className="atlas-search-field">
        <label htmlFor="atlas-cube-size">
          Область поиска: <strong>{cubeSize.toLocaleString('ru-RU')} св.л.</strong>
        </label>
        <input
          id="atlas-cube-size"
          type="range"
          min={100}
          max={5000}
          step={100}
          value={cubeSize}
          onChange={(event) => setCubeSize(Number(event.target.value))}
        />
        <div className="atlas-range-scale"><span>100</span><span>5000</span></div>
      </div>

      <div className="atlas-search-field">
        <div className="atlas-field-label-row">
          <span>Типы миров</span>
          <span className="atlas-field-hint">{selectedTypes.length} из {WORLD_TYPE_OPTIONS.length + ROCKY_OPTIONS.length + STAR_OPTIONS.length}</span>
        </div>
        <div className="atlas-type-grid">
          {[...WORLD_TYPE_OPTIONS, ...ROCKY_OPTIONS, ...STAR_OPTIONS].map((type) => {
            const active = selectedTypes.includes(type.value);
            return (
              <button
                key={type.value}
                type="button"
                onClick={() => toggleType(type.value)}
                className={`atlas-type-btn${active ? ' active' : ''}`}
                aria-pressed={active}
                style={active ? { borderColor: type.color, color: type.color, background: `${type.color}22` } : {}}
              >
                {type.label}
              </button>
            );
          })}
        </div>
        <div className="atlas-type-actions">
          <button
            type="button"
            className="atlas-link-btn"
            onClick={() => setSelectedTypes([...WORLD_TYPE_OPTIONS, ...ROCKY_OPTIONS, ...STAR_OPTIONS].map((type) => type.value))}
          >
            Выбрать все
          </button>
          <button type="button" className="atlas-link-btn" onClick={() => setSelectedTypes([])}>Сбросить</button>
        </div>
      </div>

      <details className="atlas-details">
        <summary>Дополнительные фильтры</summary>
        <label className="atlas-checkbox-row">
          <input type="checkbox" checked={requireLandable} onChange={(event) => setRequireLandable(event.target.checked)} />
          Только с посадкой (landable)
        </label>
        <div className="atlas-two-col">
          <div className="atlas-search-field">
            <label htmlFor="atlas-min-value">Мин. стоимость скана, CR</label>
            <input
              id="atlas-min-value"
              type="number"
              min={0}
              step={1000}
              value={minValue || ''}
              onChange={(event) => setMinValue(Number(event.target.value))}
              placeholder="0"
            />
          </div>
          <div className="atlas-search-field">
            <label htmlFor="atlas-max-dist">Макс. удаление от звезды, св.с.</label>
            <input
              id="atlas-max-dist"
              type="number"
              min={0}
              step={100}
              value={maxDist || ''}
              onChange={(event) => setMaxDist(Number(event.target.value))}
              placeholder="∞"
            />
          </div>
        </div>
      </details>

      {touched && validationError && (
        <p className="atlas-inline-error" role="alert">
          <IconAlert size={12} /> {validationError}
        </p>
      )}

      {loading && progress && (
        <div className="atlas-progress" aria-live="polite">
          <div className="atlas-progress-head">
            <span>ATLAS SEARCH · {progress.serverMessage || progress.phase}</span>
            <span>{Math.round(progressPercent)}% · {(progress.elapsedMs / 1000).toFixed(1)} с</span>
          </div>
          <div className="atlas-progress-bar">
            <div style={{ width: `${progressPercent}%` }} />
          </div>
          <div className="atlas-progress-meta">
            Найдено кандидатов: <strong>{progress.found.toLocaleString('ru-RU')}</strong>
          </div>
          <div className="atlas-progress-steps">
            Каталог Spansh → кэш тел → EDSM/Spansh → сохранение. Ход поиска виден на 3D-карте.
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading || !!validationError}
        className="atlas-scan-btn"
        title={validationError || 'Запустить поиск по выбранным условиям'}
      >
        {loading ? (
          'Сканирование…'
        ) : (
          <>
            <IconBolt size={13} /> Сканировать сектор
          </>
        )}
      </button>
    </div>
  );
}
