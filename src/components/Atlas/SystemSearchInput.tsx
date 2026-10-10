'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconSearch, IconX, IconClock, IconGlobe } from '@/components/Icons';
import { useRecentSystems, useSystemAutocomplete, type SystemSuggestion } from '@/hooks/useSystemAutocomplete';
import { normalizeSystemKey } from '@/lib/atlas';

/**
 * Поле поиска системы с автодополнением — общий элемент для всех поисковиков
 * Atlas (поиск миров, маршрут, кольцо, рынок, быстрый переход на карте).
 *
 * Что даёт по сравнению с обычным `<input>`:
 *  - подсказки из локального каталога Spansh с откатом на EDSM;
 *  - клавиатурную навигацию (↑/↓/Enter/Escape), как в комбобоксе;
 *  - историю последних выбранных систем (localStorage);
 *  - честные состояния загрузки, «ничего не найдено» и недоступного каталога.
 */
interface Props {
  value: string;
  onChange: (value: string) => void;
  onSelect?: (system: SystemSuggestion) => void;
  onSubmit?: (value: string) => void;
  label?: string;
  placeholder?: string;
  hint?: string;
  id?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Компактный режим для узкой панели Atlas. */
  compact?: boolean;
}

function suggestionMeta(system: SystemSuggestion): string {
  const parts: string[] = [];
  if (typeof system.distance_from_sols === 'number') parts.push(`Sol: ${Math.round(system.distance_from_sols).toLocaleString('ru-RU')} св.л.`);
  if (typeof system.distance_from_sgra === 'number') parts.push(`Sgr A*: ${Math.round(system.distance_from_sgra).toLocaleString('ru-RU')} св.л.`);
  if (system.star_type) parts.push(system.star_type);
  else if (system.main_star) parts.push(system.main_star);
  if (system.needs_permit) parts.push('нужен пропуск');
  return parts.join(' · ');
}

export function SystemSearchInput({
  value,
  onChange,
  onSelect,
  onSubmit,
  label,
  placeholder = 'Например, Sol или Colonia',
  hint,
  id,
  disabled,
  autoFocus,
  compact,
}: Props) {
  const generatedId = useId();
  const inputId = id || `atlas-system-${generatedId}`;
  const listId = `${inputId}-list`;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [showRecent, setShowRecent] = useState(false);

  const { suggestions, loading, error } = useSystemAutocomplete(value, { limit: 8, enabled: open || value.length > 1 });
  const { recent, rememberSystem } = useRecentSystems();

  const options = useMemo<Array<{ kind: 'system'; system: SystemSuggestion } | { kind: 'recent'; name: string }>>(() => {
    if (showRecent && value.trim().length < 2) {
      return recent.map((name) => ({ kind: 'recent' as const, name }));
    }
    return suggestions.map((system) => ({ kind: 'system' as const, system }));
  }, [recent, suggestions, showRecent, value]);

  // Клик вне поля закрывает список — иначе он перекрывал бы карту.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  const commit = (nextValue: string) => {
    const clean = nextValue.trim();
    onChange(clean);
    if (clean) rememberSystem(clean);
    setOpen(false);
    onSubmit?.(clean);
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.kind === 'recent') {
      commit(option.name);
      return;
    }
    const system = option.system;
    onChange(system.name);
    rememberSystem(system.name);
    onSelect?.(system);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setShowRecent(value.trim().length < 2);
      setActiveIndex((current) => (options.length === 0 ? -1 : (current + 1) % options.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => (options.length === 0 ? -1 : (current - 1 + options.length) % options.length));
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && options[activeIndex]) {
        event.preventDefault();
        selectOption(activeIndex);
        return;
      }
      if (value.trim()) {
        event.preventDefault();
        commit(value);
      }
    }
  };

  const activeOptionId = activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined;
  const emptyState = !loading && options.length === 0 && value.trim().length >= 2;

  return (
    <div className={`atlas-system-search${compact ? ' compact' : ''}`} ref={wrapperRef}>
      {label && (
        <label htmlFor={inputId} className="atlas-system-label">
          {label}
        </label>
      )}
      <div className={`atlas-system-box${open ? ' focused' : ''}`}>
        <IconSearch size={compact ? 13 : 15} className="atlas-system-icon" />
        <input
          id={inputId}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          value={value}
          disabled={disabled}
          autoFocus={autoFocus}
          placeholder={placeholder}
          onFocus={() => {
            setShowRecent(true);
            setOpen(true);
          }}
          onChange={(event) => {
            setShowRecent(false);
            onChange(event.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {loading && <span className="atlas-system-spinner" aria-hidden="true" />}
        {!!value && !loading && (
          <button
            type="button"
            className="atlas-system-clear"
            aria-label="Очистить"
            onClick={() => {
              onChange('');
              setOpen(true);
              setShowRecent(true);
            }}
          >
            <IconX size={12} />
          </button>
        )}
      </div>

      {open && (options.length > 0 || emptyState || error) && (
        <ul className="atlas-system-list" id={listId} role="listbox" aria-label="Подсказки систем">
          {showRecent && value.trim().length < 2 && options.length > 0 && (
            <li className="atlas-system-group" role="presentation">Последние системы</li>
          )}
          {options.map((option, index) => {
            if (option.kind === 'recent') {
              return (
                <li
                  key={`recent-${option.name}`}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className={`atlas-system-option${index === activeIndex ? ' active' : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectOption(index);
                  }}
                >
                  <IconClock size={12} />
                  <span className="atlas-system-name">{option.name}</span>
                </li>
              );
            }
            const meta = suggestionMeta(option.system);
            return (
              <li
                key={`${option.system.source}-${option.system.name}`}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`atlas-system-option${index === activeIndex ? ' active' : ''}`}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectOption(index);
                }}
              >
                <IconGlobe size={12} />
                <span className="atlas-system-name">{option.system.name}</span>
                {meta && <span className="atlas-system-meta">{meta}</span>}
              </li>
            );
          })}
          {emptyState && (
            <li className="atlas-system-empty" role="presentation">
              {error ? 'Подсказки недоступны — введите имя системы вручную' : 'Система не найдена в каталоге'}
            </li>
          )}
          {!showRecent && suggestions.length > 0 && normalizeSystemKey(options[0]?.kind === 'system' ? options[0].system.name : '') !== normalizeSystemKey(value) && (
            <li className="atlas-system-hint" role="presentation">Enter — искать по введённому имени</li>
          )}
        </ul>
      )}

      {hint && <p className="atlas-system-hint-text">{hint}</p>}
    </div>
  );
}
