'use client';

import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconCheck, IconClock, IconSearch, IconX } from '@/components/Icons';
import type { StationSearchKind } from '@/lib/stationSearch';
import {
  filterStationOptions, optionWords, type StationPickRef, type StationSearchOption,
} from '@/lib/stationSearchOptions';

/**
 * Поле запроса поиска станций с быстрым выбором из справочника.
 *
 * Список фильтруется прямо при вводе — по русскому и английскому названию,
 * символу Frontier и сокращениям (FSD, AFMU, SCB). Выбранная строка ищется
 * точно (сервер получает её `id`), а свободный текст — как раньше, по
 * вхождению. Клавиатура как у комбобокса: ↑/↓, Enter, Escape, Tab.
 * Оформление и поведение — те же, что у поля системы (`SystemSearchInput`).
 */

const RECENT_KEY = 'station-search-recent-v1';
const RECENT_LIMIT = 5;
const QUERY_LIMIT = 50;
const EMPTY_LIMIT = 150;

/* ── Загрузка списков: один запрос на вкладку за сессию ── */

const optionsCache = new Map<StationSearchKind, Promise<StationSearchOption[]>>();

export function loadStationSearchOptions(kind: StationSearchKind): Promise<StationSearchOption[]> {
  let promise = optionsCache.get(kind);
  if (!promise) {
    promise = fetch(`/api/stations/search/options?kind=${kind}`).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(body?.options)) throw new Error(body?.error || 'Список быстрого выбора недоступен');
      return body.options as StationSearchOption[];
    });
    // Сбой не запоминаем: следующая попытка снова сходит на сервер.
    promise.catch(() => { if (optionsCache.get(kind) === promise) optionsCache.delete(kind); });
    optionsCache.set(kind, promise);
  }
  return promise;
}

interface OptionsState { kind: StationSearchKind; options: StationSearchOption[]; loading: boolean; error: string }

export function useStationSearchOptions(kind: StationSearchKind): OptionsState {
  const [state, setState] = useState<OptionsState>({ kind, options: [], loading: true, error: '' });
  useEffect(() => {
    let alive = true;
    setState({ kind, options: [], loading: true, error: '' });
    loadStationSearchOptions(kind).then(
      (options) => { if (alive) setState({ kind, options, loading: false, error: '' }); },
      (error: unknown) => {
        if (alive) setState({ kind, options: [], loading: false, error: error instanceof Error ? error.message : 'Список недоступен' });
      },
    );
    return () => { alive = false; };
  }, [kind]);
  return state.kind === kind ? state : { kind, options: [], loading: true, error: '' };
}

/* ── Недавний выбор (localStorage) ── */

function readRecent(kind: StationSearchKind): StationPickRef[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '{}');
    const list = Array.isArray(all?.[kind]) ? all[kind] : [];
    return list.filter((entry: unknown): entry is StationPickRef =>
      !!entry && typeof (entry as StationPickRef).id === 'string' && typeof (entry as StationPickRef).label === 'string');
  } catch {
    return [];
  }
}

export function rememberStationPick(kind: StationSearchKind, pick: StationPickRef) {
  try {
    const all = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '{}') || {};
    const list = readRecent(kind).filter((entry) => entry.id !== pick.id);
    all[kind] = [{ id: pick.id, label: pick.label }, ...list].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(all));
  } catch {
    // Приватный режим или переполненное хранилище — без истории.
  }
}

/** Подсветка введённого фрагмента в названии. */
function highlight(label: string, query: string) {
  const needle = optionWords(query);
  if (!needle) return label;
  const haystack = label.toLowerCase().replace(/ё/g, 'е');
  const at = haystack.indexOf(needle);
  if (at < 0) return label;
  return <>{label.slice(0, at)}<mark>{label.slice(at, at + needle.length)}</mark>{label.slice(at + needle.length)}</>;
}

interface Props {
  kind: StationSearchKind;
  id: string;
  label: string;
  value: string;
  pick: StationPickRef | null;
  placeholder?: string;
  disabled?: boolean;
  options: StationSearchOption[];
  loading?: boolean;
  error?: string;
  /** Ввод с клавиатуры: точный выбор при этом сбрасывается. */
  onChange: (value: string) => void;
  onPick: (option: StationSearchOption) => void;
}

interface Entry { option: StationSearchOption; recent: boolean }

export function StationItemPicker({
  kind, id, label, value, pick, placeholder, disabled, options, loading, error, onChange, onPick,
}: Props) {
  const generated = useId();
  const listId = `${id}-list-${generated.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<StationPickRef[]>([]);

  useEffect(() => { setRecent(readRecent(kind)); }, [kind]);

  const query = pick ? '' : value;
  const entries = useMemo<Entry[]>(() => {
    if (query.trim()) return filterStationOptions(options, query, QUERY_LIMIT).map((option) => ({ option, recent: false }));
    const byId = new Map(options.map((option) => [option.id, option]));
    const recentOptions = recent.map((entry) => byId.get(entry.id)).filter((option): option is StationSearchOption => !!option);
    const recentIds = new Set(recentOptions.map((option) => option.id));
    return [
      ...recentOptions.map((option) => ({ option, recent: true })),
      ...filterStationOptions(options, '', EMPTY_LIMIT).filter((option) => !recentIds.has(option.id)).map((option) => ({ option, recent: false })),
    ];
  }, [options, query, recent]);

  // Клик вне поля закрывает список.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => { if (!open) setActive(-1); }, [open]);
  useEffect(() => { setActive(-1); }, [query, kind]);

  useEffect(() => {
    if (active < 0) return;
    const element = document.getElementById(`${listId}-${active}`);
    if (element && typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  const choose = (index: number) => {
    const entry = entries[index];
    if (!entry) return;
    onPick(entry.option);
    rememberStationPick(kind, { id: entry.option.id, label: entry.option.label });
    setRecent(readRecent(kind));
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => (entries.length ? (current + 1) % entries.length : -1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => (entries.length ? (current - 1 + entries.length) % entries.length : -1));
      return;
    }
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); setOpen(false); }
      return;
    }
    if (event.key === 'Tab') { setOpen(false); return; }
    // Enter без выбранной строки отправляет форму — поиск по введённому тексту.
    if (event.key === 'Enter' && open && active >= 0 && entries[active]) {
      event.preventDefault();
      choose(active);
    }
  };

  const activeId = open && active >= 0 ? `${listId}-${active}` : undefined;
  const showList = open && !disabled;
  const typed = query.trim().length > 0;
  // У товаров категория уже во второй строке, у кораблей группа одна.
  const showGroups = kind === 'outfitting' || kind === 'services';
  let previousGroup = '';

  return (
    <div className="station-pick" ref={wrapperRef}>
      <label htmlFor={id} className="station-pick-label">{label}</label>
      <div className="station-pick-field">
        <div className={`station-pick-box${showList ? ' focused' : ''}${pick ? ' picked' : ''}`}>
          {pick ? <IconCheck size={14} className="station-pick-icon picked" /> : <IconSearch size={14} className="station-pick-icon" />}
          <input
            id={id}
            type="text"
            role="combobox"
            autoComplete="off"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            aria-describedby={`${id}-note`}
            required
            minLength={2}
            maxLength={120}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onChange={(event) => { onChange(event.target.value); setOpen(true); }}
            onKeyDown={onKeyDown}
          />
          {loading && showList && <span className="atlas-system-spinner" aria-hidden="true" />}
          {!!value && !disabled && (
            <button type="button" className="station-pick-clear" aria-label="Очистить запрос"
              onClick={() => { onChange(''); setOpen(true); document.getElementById(id)?.focus(); }}>
              <IconX size={12} />
            </button>
          )}
        </div>

        {showList && (
          <ul className="station-pick-list" id={listId} role="listbox" aria-label={`Быстрый выбор: ${label}`}>
            {entries.map((entry, index) => {
              const heading = typed ? '' : entry.recent ? 'Недавний выбор' : entry.option.group;
              const header = heading && heading !== previousGroup
                ? <li className="station-pick-group" role="presentation">{heading}</li> : null;
              if (heading) previousGroup = heading;
              const { option } = entry;
              return (
                <Fragment key={`${entry.recent ? 'recent' : 'all'}-${option.id}`}>
                  {header}
                  <li
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    className={`station-pick-option${index === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => { event.preventDefault(); choose(index); }}
                  >
                    {entry.recent && <IconClock size={12} className="station-pick-recent" />}
                    <span className="station-pick-text">
                      <span className="station-pick-name">{highlight(option.label, query)}</span>
                      {option.hint && <span className="station-pick-hint">{option.hint}</span>}
                    </span>
                    {option.badge && (typed || !option.featured) && <span className="station-pick-badge">{option.badge}</span>}
                    {typed && showGroups && <span className="station-pick-tag">{option.group}</span>}
                  </li>
                </Fragment>
              );
            })}
            {loading && !entries.length && <li className="station-pick-empty" role="presentation">Загружаем список…</li>}
            {!loading && error && <li className="station-pick-empty" role="presentation">Список недоступен — ищем по введённому тексту</li>}
            {!loading && !error && typed && !entries.length && (
              <li className="station-pick-empty" role="presentation">В справочнике такого нет — Enter ищет по введённому тексту</li>
            )}
          </ul>
        )}
      </div>

      <p className="station-pick-note" id={`${id}-note`}>
        {pick
          ? <>Точный выбор из справочника — ищем ровно «{pick.label}».</>
          : typed
            ? <>Свободный поиск по вхождению. Для точного совпадения выберите строку из списка.</>
            : <>Начните вводить название — список подскажет варианты на русском и английском.</>}
      </p>
    </div>
  );
}
