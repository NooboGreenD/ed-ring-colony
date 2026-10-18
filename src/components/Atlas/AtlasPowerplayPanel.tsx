'use client';

/**
 * Вкладка «PowerPlay» в Atlas: все системы под контролем держав PowerPlay 2.0
 * на карте и фильтр по державам и состояниям.
 *
 *  * переключатель слоя на карте и откуда/когда данные;
 *  * фильтр по состоянию (оплоты / укреплённые / эксплуатируемые) и по
 *    державам (каждая — со своим цветом и счётчиками, «только эта»);
 *  * список систем под фильтр с поиском по имени: клик ведёт камеру к системе
 *    и открывает её карточку; выгрузка списка в CSV;
 *  * «Чья зона?» — любая система галактики: под чьим она контролем и чьи
 *    оплоты и укреплённые системы до неё дотягиваются (важно для колонизации).
 *
 * Состояние (данные, фильтр, выбор) живёт в `useAtlasPowerplay` на странице:
 * им же пользуется 3D-слой карты.
 */

import { useMemo, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { PowerSwatch, PowerplayGlyph } from '@/components/GalaxyMap/PowerplayGlyph';
import { IconDownload, IconPower, IconRefresh, IconSearch, IconX } from '@/components/Icons';
import type { AtlasPowerplayState } from '@/hooks/usePowerplayLayer';
import type { SystemSuggestion } from '@/hooks/useSystemAutocomplete';
import { downloadCsv } from '@/lib/atlas';
import {
  POWER_ALLEGIANCE_LABEL,
  POWERPLAY_STATE_HINT,
  POWERPLAY_STATE_LABEL,
  POWERPLAY_STATE_PLURAL,
  POWERPLAY_STATES,
  filterPowerplaySystems,
  findPowerplaySystem,
  formatLy,
  formatPowerplayDate,
  hideAllPowers,
  isDefaultPowerplayFilter,
  isPowerVisible,
  orderPowerplaySystems,
  powerInfo,
  powerplayInfluenceAt,
  searchPowerplaySystems,
  showAllPowers,
  soloPower,
  togglePowerVisible,
  togglePowerplayState,
  type PowerplayInfluence,
  type PowerplayPoint,
  type PowerplaySystem,
} from '@/lib/powerplay';

const PAGE_SIZE = 150;
const MUTED = '#9ca3af';
const DIM = '#6b7280';
const TEXT = '#eeeeee';
const PP_COLOR = '#f0af28';

function formatCount(value: number): string {
  return value.toLocaleString('ru-RU');
}

interface CheckResult {
  name: string;
  point: PowerplayPoint;
  controlled: PowerplaySystem | null;
  influence: PowerplayInfluence[];
}

/** Координаты системы по имени: сначала слой, затем каталог сайта, затем EDSM. */
async function resolveSystem(name: string, systems: PowerplaySystem[]): Promise<{ name: string; point: PowerplayPoint } | null> {
  const inLayer = findPowerplaySystem(systems, name);
  if (inLayer) return { name: inLayer.name, point: inLayer };
  try {
    const response = await fetch(`/api/galaxy/systems/by-name?name=${encodeURIComponent(name)}`);
    if (response.ok) {
      const row = await response.json();
      if ([row?.x, row?.y, row?.z].every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return { name: String(row.name || name), point: { x: row.x, y: row.y, z: row.z } };
      }
    }
  } catch {
    // каталог необязателен — дальше EDSM
  }
  try {
    const response = await fetch(`/api/edsm/system?name=${encodeURIComponent(name)}`);
    if (!response.ok) return null;
    const row = await response.json();
    const coords = row?.coords;
    if (coords && [coords.x, coords.y, coords.z].every((value: unknown) => Number.isFinite(Number(value)))) {
      return { name: String(row.name || name), point: { x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) } };
    }
  } catch {
    // нет связи с EDSM
  }
  return null;
}

export interface AtlasPowerplayPanelProps {
  powerplay: AtlasPowerplayState;
}

export function AtlasPowerplayPanel({ powerplay }: AtlasPowerplayPanelProps) {
  const { visible, setVisible, filter, setFilter, status, data, error, reload, systems, visibleSystems, counts, selectedId, select, focusOverview } = powerplay;
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [checkName, setCheckName] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);

  const allPowers = useMemo(() => counts.powers.map((item) => item.power), [counts]);
  const visibleCounts = useMemo(() => {
    const out = { Stronghold: 0, Fortified: 0, Exploited: 0 };
    for (const system of visibleSystems) out[system.state] += 1;
    return out;
  }, [visibleSystems]);
  const listed = useMemo(
    () => orderPowerplaySystems(searchPowerplaySystems(visibleSystems, query)),
    [query, visibleSystems],
  );
  const shown = listed.slice(0, limit);
  const meta = data?.meta;
  const filtered = !isDefaultPowerplayFilter(filter);

  const runCheck = async (name: string, suggestion?: SystemSuggestion) => {
    const clean = name.trim();
    if (!clean) return;
    setChecking(true);
    setCheckError('');
    try {
      const resolved = suggestion && [suggestion.x, suggestion.y, suggestion.z].every((value) => typeof value === 'number' && Number.isFinite(value))
        ? { name: suggestion.name, point: { x: suggestion.x!, y: suggestion.y!, z: suggestion.z! } }
        : await resolveSystem(clean, systems);
      if (!resolved) {
        setCheck(null);
        setCheckError(`Система «${clean}» не найдена ни в каталоге, ни в EDSM`);
        return;
      }
      const controlled = findPowerplaySystem(systems, resolved.name);
      setCheck({
        name: resolved.name,
        point: resolved.point,
        controlled,
        influence: powerplayInfluenceAt(resolved.point, systems, { excludeId64: controlled?.id64 ?? null }),
      });
      // Система скрытой фильтром державы карточку не откроет — тогда только камера.
      if (controlled && isPowerVisible(filter, controlled.power) && filter.states[controlled.state] !== false) {
        select(controlled, { focus: true });
      } else if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('atlas-focus-system', { detail: { name: resolved.name, ...resolved.point } }));
      }
    } finally {
      setChecking(false);
    }
  };

  const exportList = () => {
    if (listed.length === 0) return;
    downloadCsv(`powerplay-${new Date().toISOString().slice(0, 10)}`, [
      ['Система', 'Держава', 'Состояние', 'X', 'Y', 'Z', 'id64', 'Данные EDSM'],
      ...listed.map((system) => [
        system.name,
        powerInfo(system.power).label,
        POWERPLAY_STATE_LABEL[system.state],
        system.x,
        system.y,
        system.z,
        system.id64,
        formatPowerplayDate(system.observedAt),
      ]),
    ]);
  };

  const sourceLine = meta?.dumpGeneratedAt || meta?.syncedAt
    ? `Дамп EDSM от ${formatPowerplayDate(meta.dumpGeneratedAt ?? meta.syncedAt)}`
      + (meta.oldestObservation && meta.newestObservation
        ? ` · наблюдения ${formatPowerplayDate(meta.oldestObservation)}–${formatPowerplayDate(meta.newestObservation)}`
        : '')
    : '';

  return (
    <div className="atlas-section powerplay-panel" data-powerplay-panel="">
      <div className="atlas-section-head">
        <h4>
          <IconPower size={13} /> PowerPlay: системы держав
        </h4>
        <div className="atlas-section-actions">
          <button type="button" className="atlas-icon-btn" title="Выгрузить список в CSV" onClick={exportList} disabled={listed.length === 0}>
            <IconDownload size={12} />
          </button>
          <button type="button" className="atlas-icon-btn" title="Обновить данные" onClick={reload}>
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <p className="atlas-muted powerplay-intro">
        Все системы под контролем держав PowerPlay 2.0: оплоты (зона влияния 30 св. лет), укреплённые (20 св. лет) и
        эксплуатируемые. Цвет точки — держава, форма — состояние.
      </p>

      <label className="powerplay-toggle">
        <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
        Показывать на карте
        {status === 'ready' && <span className="powerplay-toggle-count">{formatCount(visibleSystems.length)}</span>}
      </label>

      {status === 'loading' && <div className="powerplay-status">Загрузка систем держав…</div>}
      {status === 'error' && (
        <div className="atlas-error powerplay-status" role="alert">
          {error || 'Не удалось загрузить системы PowerPlay'}{' '}
          <button type="button" className="atlas-link-btn" onClick={reload}>Повторить</button>
        </div>
      )}
      {status === 'empty' && (
        <div className="powerplay-status" role="status">
          {meta?.refreshing
            ? 'Сервер загружает свежий дамп EDSM — системы появятся через минуту.'
            : meta?.lastError
              ? `Данных пока нет: ${meta.lastError}.`
              : 'Данных пока нет: импорт запускается задачей powerplay-sync.'}
        </div>
      )}
      {status === 'ready' && (
        <div className="powerplay-source" title="EDSM собирает состояние систем из журналов пилотов (EDDN); в дампе — системы, о которых сообщали за последние ~30 дней">
          {sourceLine}
          {meta?.lastError && <div className="powerplay-warning">Последнее обновление не удалось: {meta.lastError}</div>}
          {' '}
          <a href={meta?.sourceUrl || 'https://www.edsm.net/en/nightly-dumps'} target="_blank" rel="noopener noreferrer">EDSM</a>
        </div>
      )}

      {systems.length > 0 && (
        <>
          <div className="powerplay-group-title">Состояние</div>
          <div className="powerplay-chips" role="group" aria-label="Состояние систем">
            {POWERPLAY_STATES.map((state) => {
              const on = filter.states[state] !== false;
              return (
                <button
                  key={state}
                  type="button"
                  className={`powerplay-chip${on ? ' active' : ''}`}
                  aria-pressed={on}
                  title={POWERPLAY_STATE_HINT[state]}
                  onClick={() => setFilter(togglePowerplayState(filter, state))}
                >
                  <PowerplayGlyph state={state} color={on ? PP_COLOR : DIM} size={12} />
                  {POWERPLAY_STATE_PLURAL[state]}
                  <span className="powerplay-chip-count">{formatCount(counts.states[state])}</span>
                </button>
              );
            })}
          </div>

          <div className="powerplay-group-head">
            <span className="powerplay-group-title">Державы ({counts.powers.length})</span>
            <span className="powerplay-group-actions">
              <button type="button" className="atlas-link-btn" onClick={() => setFilter(showAllPowers(filter))} disabled={filter.hiddenPowers.length === 0}>
                все
              </button>
              <button type="button" className="atlas-link-btn" onClick={() => setFilter(hideAllPowers(filter, allPowers))}>
                скрыть все
              </button>
            </span>
          </div>
          <ul className="powerplay-powers" aria-label="Державы">
            {counts.powers.map((item) => {
              const info = powerInfo(item.power);
              const on = isPowerVisible(filter, item.power);
              return (
                <li key={item.power} className={`powerplay-power${on ? '' : ' off'}`} data-power={item.power}>
                  <label className="powerplay-power-main" title={`${info.label}: ${formatCount(item.total)} систем`}>
                    <input type="checkbox" checked={on} onChange={() => setFilter(togglePowerVisible(filter, item.power))} />
                    <PowerSwatch color={info.color} />
                    <span className="powerplay-power-name">{info.label}</span>
                    {info.allegiance && <span className="powerplay-power-allegiance">{POWER_ALLEGIANCE_LABEL[info.allegiance]}</span>}
                  </label>
                  <span className="powerplay-power-counts" aria-label={`Оплоты ${item.states.Stronghold}, укреплённые ${item.states.Fortified}, эксплуатируемые ${item.states.Exploited}`}>
                    <span title="Оплоты"><PowerplayGlyph state="Stronghold" color={info.color} size={9} /> {formatCount(item.states.Stronghold)}</span>
                    <span title="Укреплённые"><PowerplayGlyph state="Fortified" color={info.color} size={9} /> {formatCount(item.states.Fortified)}</span>
                    <span title="Эксплуатируемые"><PowerplayGlyph state="Exploited" color={info.color} size={9} /> {formatCount(item.states.Exploited)}</span>
                  </span>
                  <button
                    type="button"
                    className="powerplay-solo"
                    title={`Показать только ${info.label} и подвести к ней камеру`}
                    onClick={() => {
                      const next = soloPower(filter, item.power, allPowers);
                      setFilter(next);
                      focusOverview(filterPowerplaySystems(systems, next));
                    }}
                  >
                    только
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="powerplay-summary">
            <span>
              На карте: <strong>{formatCount(visibleSystems.length)}</strong> из {formatCount(systems.length)} систем
              {filtered && (
                <>
                  {' · '}
                  <span title="Оплоты / укреплённые / эксплуатируемые">
                    {formatCount(visibleCounts.Stronghold)} / {formatCount(visibleCounts.Fortified)} / {formatCount(visibleCounts.Exploited)}
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              className="atlas-link-btn powerplay-overview"
              onClick={() => focusOverview()}
              disabled={visibleSystems.length === 0}
              title="Подвести камеру так, чтобы были видны все системы под фильтром"
            >
              Показать целиком
            </button>
            {!visible && <div className="powerplay-warning">Слой выключен — включите «Показывать на карте».</div>}
          </div>

          <div className="atlas-inline-search">
            <IconSearch size={12} />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              placeholder="Найти систему под фильтром"
              aria-label="Поиск системы среди систем держав"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск">
                <IconX size={11} />
              </button>
            )}
          </div>
          <p className="atlas-list-counter">
            Показано {formatCount(shown.length)} из {formatCount(listed.length)} — сначала оплоты, затем укреплённые
          </p>
          <ul className="powerplay-list" aria-label="Системы держав">
            {shown.map((system) => {
              const info = powerInfo(system.power);
              const key = system.id64 || system.nameLc;
              const active = selectedId === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={`powerplay-row${active ? ' active' : ''}`}
                    aria-pressed={active}
                    data-powerplay-row={system.name}
                    onClick={() => select(system, { focus: true })}
                    title="Показать на карте"
                  >
                    <PowerplayGlyph state={system.state} color={info.color} size={12} />
                    <span className="powerplay-row-name">{system.name}</span>
                    <span className="powerplay-row-meta">{info.label} · {POWERPLAY_STATE_LABEL[system.state].toLowerCase()}</span>
                  </button>
                </li>
              );
            })}
            {listed.length === 0 && <li className="powerplay-empty">{query ? 'Под поиск ничего не нашлось' : 'Под фильтр систем нет'}</li>}
          </ul>
          {listed.length > shown.length && (
            <button type="button" className="atlas-link-btn powerplay-more" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Показать ещё {formatCount(Math.min(PAGE_SIZE, listed.length - shown.length))}
            </button>
          )}

          <div className="powerplay-check">
            <div className="powerplay-group-title">Чья зона? Проверить любую систему</div>
            <SystemSearchInput
              compact
              value={checkName}
              onChange={setCheckName}
              onSelect={(suggestion) => void runCheck(suggestion.name, suggestion)}
              onSubmit={(value) => void runCheck(value)}
              placeholder="Например, система вашей колонии"
            />
            {checking && <div className="powerplay-status">Проверяем…</div>}
            {checkError && <div className="atlas-error powerplay-status">{checkError}</div>}
            {check && !checking && (
              <div className="powerplay-check-result" data-powerplay-check={check.name}>
                <div className="powerplay-check-title">{check.name}</div>
                {check.controlled ? (
                  <div>
                    Под контролем:{' '}
                    <span style={{ color: powerInfo(check.controlled.power).color, fontWeight: 600 }}>{powerInfo(check.controlled.power).label}</span>
                    {' · '}{POWERPLAY_STATE_LABEL[check.controlled.state].toLowerCase()}
                  </div>
                ) : (
                  <div style={{ color: MUTED }}>Не под контролем держав (по данным слоя).</div>
                )}
                {check.influence.length > 0 ? (
                  <ul className="powerplay-check-list" aria-label="Зоны влияния">
                    {check.influence.map((item) => {
                      const info = powerInfo(item.power);
                      return (
                        <li key={item.power} data-powerplay-zone={item.power}>
                          <PowerplayGlyph state={item.nearest.state} color={info.color} size={11} />
                          <span>
                            <span style={{ color: info.color, fontWeight: 600 }}>{info.label}</span>
                            <span style={{ color: MUTED }}>
                              {' '}— {POWERPLAY_STATE_LABEL[item.nearest.state].toLowerCase()} {item.nearest.name}, {formatLy(item.nearest.distance)}
                              {item.sources > 1 ? `, зон: ${item.sources}` : ''}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div style={{ color: DIM }}>Ни одна зона влияния сюда не дотягивается.</div>
                )}
                <div className="powerplay-hint">
                  Зона влияния — 30 св. лет вокруг оплота и 20 св. лет вокруг укреплённой системы: в ней держава может
                  забрать систему себе.
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {systems.length === 0 && status === 'ready' && (
        <div className="powerplay-status" style={{ color: TEXT }}>В наборе нет систем.</div>
      )}
    </div>
  );
}

export default AtlasPowerplayPanel;
