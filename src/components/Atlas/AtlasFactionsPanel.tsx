'use client';

/**
 * Вкладка «Фракции» в Atlas: минорные фракции на карте.
 *
 *  * сверху — состояние данных: грузит ли браузер набор, импортирует ли сервер
 *    дамп EDSM (этап и процент), сколько систем и фракций, от какого числа
 *    данные и когда их последний раз обновили пилоты (Colonial Helper,
 *    загрузка журналов на сайте);
 *  * поиск минорных фракций по имени: одну или несколько (до 12) можно
 *    добавить на карту — у каждой свой цвет; любую можно временно скрыть,
 *    оставить одну («только») или убрать;
 *  * без выбранных фракций на карте все населённые системы, где есть
 *    фракции, — цвет по принадлежности, фильтр по принадлежности;
 *  * список систем под фильтром: клик ведёт камеру к системе и открывает её
 *    карточку со всеми фракциями (по самой точке на карте тоже можно кликнуть).
 *
 * Состояние (данные, выбор, фильтр) живёт в `useAtlasFactions` на странице:
 * им же пользуется 3D-слой карты.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { PowerSwatch, PowerplayGlyph } from '@/components/GalaxyMap/PowerplayGlyph';
import {
  IconAlert,
  IconCheckCircle,
  IconDownload,
  IconEye,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconShieldHalf,
  IconX,
} from '@/components/Icons';
import { useFactionSearch, type AtlasFactionsState } from '@/hooks/useFactionsLayer';
import { downloadCsv } from '@/lib/atlas';
import {
  BGS_ALLEGIANCES,
  BGS_ALLEGIANCE_COLOR,
  BGS_CONFLICT_STATES,
  BGS_MAX_SELECTED,
  BGS_SOURCE_LABEL,
  DEFAULT_BGS_FILTER,
  allegianceLabel,
  formatBgsDate,
  formatInfluence,
  formatPopulation,
  governmentLabel,
  orderBgsPoints,
  searchBgsSystems,
  soloAllegiance,
  stateLabel,
  toggleAllegiance,
  type BgsMapPoint,
} from '@/lib/bgs';
import { formatBgsBytes } from '@/lib/bgsProgress';

const PAGE_SIZE = 150;
const SHAPE_GLYPH = { 0: 'Exploited', 1: 'Fortified', 2: 'Stronghold' } as const;

function formatCount(value: number): string {
  return value.toLocaleString('ru-RU');
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function StatusBar({ percent, label }: { percent: number | null; label: string }) {
  const value = percent == null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div
      className={`powerplay-progress bgs-progress${value == null ? ' indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(value)}
    >
      <div className="powerplay-progress-fill" style={value == null ? undefined : { width: `${value}%` }} />
    </div>
  );
}

export interface AtlasFactionsPanelProps {
  factions: AtlasFactionsState;
}

export function AtlasFactionsPanel({ factions }: AtlasFactionsPanelProps) {
  const {
    visible, setVisible, status, data, error, reload, systems, allegianceCounts, filter, setFilter, selection, presence,
    presenceStatus, presenceError, addFaction, removeFaction, toggleFactionHidden, soloFaction, clearSelection, points,
    selectedKey, select, focusOverview, download,
  } = factions;
  const [query, setQuery] = useState('');
  const [playerOnly, setPlayerOnly] = useState(false);
  const [listQuery, setListQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const searchActive = query.trim().length >= 2 || playerOnly;
  const search = useFactionSearch(query, { player: playerOnly, enabled: searchActive });

  const loaded = systems.length > 0;
  const meta = data?.meta;
  const selectionMode = selection.length > 0;
  const visibleSelected = selection.filter((item) => !item.hidden).length;
  const selectedIds = useMemo(() => new Set(selection.map((item) => item.id)), [selection]);
  const listed = useMemo(() => {
    const base = selectionMode ? orderBgsPoints(points) : points;
    return searchBgsSystems(base, listQuery);
  }, [listQuery, points, selectionMode]);
  const shown = listed.slice(0, limit);
  const mapCount = points.filter((point) => !point.background).length;

  const exportList = () => {
    if (listed.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    if (selectionMode) {
      const rows: Array<Array<string | number>> = [['Система', 'Фракция', 'Влияние, %', 'Состояние', 'У власти', 'X', 'Y', 'Z', 'id64', 'Наблюдение']];
      for (const point of listed) {
        for (const entry of point.entries) {
          rows.push([
            point.name, entry.name, entry.influence == null ? '' : Math.round(entry.influence * 1000) / 10, stateLabel(entry.state),
            entry.controls ? 'да' : '', point.x, point.y, point.z, point.id64, formatBgsDate(point.observedAt),
          ]);
        }
      }
      downloadCsv(`factions-${date}`, rows);
      return;
    }
    downloadCsv(`populated-systems-${date}`, [
      ['Система', 'Принадлежность', 'Правительство', 'Контролирующая фракция', 'Население', 'Фракций', 'X', 'Y', 'Z', 'id64', 'Наблюдение', 'Источник'],
      ...listed.map((point) => [
        point.name,
        allegianceLabel(point.system?.allegiance),
        governmentLabel(point.system?.government),
        point.system?.controlling ?? '',
        point.system?.population ?? '',
        point.system?.factionsCount ?? '',
        point.x,
        point.y,
        point.z,
        point.id64,
        formatBgsDate(point.observedAt),
        point.system ? BGS_SOURCE_LABEL[point.system.source] : '',
      ]),
    ]);
  };

  /* ── Что с данными ── */
  const serverProgress = meta?.progress ?? null;
  const importing = Boolean(meta?.refreshing);
  const statusKind = status === 'loading' || status === 'idle'
    ? 'loading'
    : status === 'error'
      ? 'error'
      : status === 'empty'
        ? importing ? 'importing' : 'empty'
        : 'ready';

  let statusBlock: ReactNode = null;
  if (statusKind === 'loading') {
    const percent = download?.total ? (download.received / download.total) * 100 : null;
    statusBlock = (
      <>
        <div className="powerplay-status-title">Загружаю населённые системы…</div>
        <StatusBar percent={percent} label="Загрузка систем с фракциями" />
        <div className="powerplay-status-detail">
          {download && download.received > 0
            ? `${formatBgsBytes(download.received)}${download.total ? ` из ${formatBgsBytes(download.total)}` : ''}`
            : 'Запрашиваю набор у сервера'}
        </div>
      </>
    );
  } else if (statusKind === 'importing') {
    statusBlock = (
      <>
        <div className="powerplay-status-title">Сервер загружает дамп EDSM{serverProgress ? ` — ${Math.round(serverProgress.percent)} %` : '…'}</div>
        <StatusBar percent={serverProgress ? serverProgress.percent : null} label="Импорт дампа EDSM на сервере" />
        <div className="powerplay-status-detail">{serverProgress?.message || 'Скачивание и разбор дампа EDSM'}</div>
        <div className="powerplay-status-hint">Дамп большой (≈0,5 ГБ) — это может занять долго. Карта заполнится сама.</div>
      </>
    );
  } else if (statusKind === 'error') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> Не удалось загрузить данные о фракциях</div>
        <div className="powerplay-status-detail">{error || 'Сервер не ответил'}</div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>Повторить</button>
      </>
    );
  } else if (statusKind === 'empty') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> Данных о фракциях пока нет</div>
        <div className="powerplay-status-detail">
          {meta?.lastError ? `Последняя загрузка не удалась: ${meta.lastError}.` : 'Дамп EDSM на сервер ещё не загружали.'}
        </div>
        <div className="powerplay-status-hint">
          Администратор загружает данные в Админка → Игровые данные → Фракции (дамп EDSM, ≈0,5 ГБ). Системы, где побывали
          пилоты с Colonial Helper или чьи журналы загружены на сайт, появятся и без него.
        </div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>Проверить снова</button>
      </>
    );
  } else {
    statusBlock = (
      <>
        <div className="powerplay-status-title">
          <IconCheckCircle size={12} /> {formatCount(systems.length)} населённых систем · фракций: {formatCount(meta?.factions ?? 0)}
        </div>
        <div className="powerplay-status-detail">
          {meta?.dumpGeneratedAt || meta?.syncedAt ? <>Дамп EDSM от {formatBgsDate(meta?.dumpGeneratedAt ?? meta?.syncedAt)}</> : 'Дамп EDSM не загружен'}
          {meta?.pilotUpdateAt ? ` · пилоты обновляли ${formatDateTime(meta.pilotUpdateAt)}` : ''}
          {' · '}
          <a href={meta?.sourceUrl || 'https://www.edsm.net/en/nightly-dumps'} target="_blank" rel="noopener noreferrer">EDSM</a>
        </div>
        {importing && (
          <div className="powerplay-status-hint">
            Сервер обновляет данные{serverProgress ? `: ${serverProgress.stageLabel.toLowerCase()}, ${Math.round(serverProgress.percent)} %` : '…'} —
            новый набор подгрузится сам.
          </div>
        )}
        {meta?.lastError && <div className="powerplay-warning">Последнее обновление не удалось: {meta.lastError}</div>}
      </>
    );
  }

  const presenceFor = (id: number) => presence.get(id) ?? null;

  return (
    <div className="atlas-section powerplay-panel bgs-panel" data-bgs-panel="">
      <div className="atlas-section-head">
        <h4>
          <IconShieldHalf size={13} /> Минорные фракции
        </h4>
        <div className="atlas-section-actions">
          <button type="button" className="atlas-icon-btn" title="Выгрузить список в CSV" onClick={exportList} disabled={listed.length === 0}>
            <IconDownload size={12} />
          </button>
          <button type="button" className="atlas-icon-btn" title="Перезапросить данные" onClick={reload}>
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <div className={`powerplay-state-card ${statusKind}`} data-bgs-status={statusKind} role="status" aria-live="polite">
        {statusBlock}
      </div>

      <label className="powerplay-toggle bgs-toggle">
        <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
        Показывать на карте
        {(loaded || selectionMode) && <span className="powerplay-toggle-count">{formatCount(mapCount)}</span>}
      </label>

      {/* ── Поиск и выбор фракций ── */}
      <div className="bgs-picker" data-bgs-picker="">
        <div className="powerplay-group-head">
          <span className="powerplay-group-title">Фракции на карте · выбрано {selection.length} из {BGS_MAX_SELECTED}</span>
          {selectionMode && (
            <span className="powerplay-group-actions">
              <button type="button" className="atlas-link-btn" onClick={() => focusOverview()} disabled={mapCount === 0} title="Подвести камеру к системам выбранных фракций">
                показать целиком
              </button>
              <button type="button" className="atlas-link-btn" onClick={clearSelection} data-bgs-clear="">
                сбросить
              </button>
            </span>
          )}
        </div>
        <div className="atlas-inline-search">
          <IconSearch size={12} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти минорную фракцию (от 2 букв)"
            aria-label="Поиск минорной фракции"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск фракции">
              <IconX size={11} />
            </button>
          )}
        </div>
        <label className="bgs-check">
          <input type="checkbox" checked={playerOnly} onChange={(event) => setPlayerOnly(event.target.checked)} />
          только фракции игроков (PMF)
        </label>
        {searchActive && (
          <ul className="bgs-results" aria-label="Найденные фракции" data-bgs-results="">
            {search.loading && search.results.length === 0 && <li className="powerplay-empty">Ищу…</li>}
            {search.error && <li className="powerplay-empty" style={{ color: '#f87171' }}>{search.error}</li>}
            {!search.loading && !search.error && search.results.length === 0 && (
              <li className="powerplay-empty">{query.trim().length >= 2 ? `Фракция «${query.trim()}» не найдена` : 'Ничего не найдено'}</li>
            )}
            {search.results.map((result) => {
              const chosen = selectedIds.has(result.id);
              const full = !chosen && selection.length >= BGS_MAX_SELECTED;
              return (
                <li key={result.id}>
                  <button
                    type="button"
                    className={`bgs-result${chosen ? ' chosen' : ''}`}
                    data-bgs-result={result.name}
                    disabled={full}
                    title={chosen ? 'Уже на карте — убрать' : full ? `Не больше ${BGS_MAX_SELECTED} фракций за раз` : 'Показать все системы фракции на карте'}
                    onClick={() => (chosen ? removeFaction(result.id) : addFaction(result))}
                  >
                    <PowerSwatch color={BGS_ALLEGIANCE_COLOR[result.allegiance]} />
                    <span className="bgs-result-name">
                      {result.name}
                      {result.isPlayer && <span className="bgs-pmf" title="Фракция игроков">PMF</span>}
                    </span>
                    <span className="bgs-result-meta">
                      {allegianceLabel(result.allegiance)} · {governmentLabel(result.government)} · систем {formatCount(result.systems)}
                      {result.controlled > 0 ? ` · у власти ${formatCount(result.controlled)}` : ''}
                    </span>
                    <span className="bgs-result-action" aria-hidden="true">{chosen ? <IconX size={11} /> : <IconPlus size={11} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selectionMode ? (
          <ul className="bgs-selected" aria-label="Выбранные фракции" data-bgs-selected="">
            {selection.map((item) => {
              const info = presenceFor(item.id);
              const counts = info
                ? `систем ${formatCount(info.systems.length)} · у власти ${formatCount(info.systems.filter((system) => system.controls).length)}`
                : presenceStatus === 'error' ? 'ошибка загрузки' : 'загрузка…';
              return (
                <li key={item.id} className={`bgs-selected-item${item.hidden ? ' off' : ''}`} data-bgs-selected-faction={item.name}>
                  <button
                    type="button"
                    className="bgs-swatch-btn"
                    title={item.hidden ? 'Показать на карте' : 'Скрыть с карты (останется в списке)'}
                    aria-pressed={!item.hidden}
                    onClick={() => toggleFactionHidden(item.id)}
                  >
                    <PowerSwatch color={item.color} />
                  </button>
                  <button
                    type="button"
                    className="bgs-selected-name"
                    title="Подвести камеру к системам фракции"
                    onClick={() => info && focusOverview(info.systems.filter((system) => !filter.controlsOnly || system.controls))}
                  >
                    <span className="bgs-selected-title">
                      {item.name}
                      {info?.isPlayer && <span className="bgs-pmf">PMF</span>}
                    </span>
                    <span className="bgs-selected-meta">{counts}</span>
                  </button>
                  <button type="button" className="powerplay-solo" title="Оставить на карте только эту фракцию" onClick={() => soloFaction(item.id)}>
                    только
                  </button>
                  <button type="button" className="bgs-icon-btn" title={item.hidden ? 'Показать' : 'Скрыть'} aria-label={item.hidden ? 'Показать фракцию' : 'Скрыть фракцию'} onClick={() => toggleFactionHidden(item.id)}>
                    <IconEye size={11} />
                  </button>
                  <button type="button" className="bgs-icon-btn" title="Убрать с карты" aria-label={`Убрать ${item.name}`} onClick={() => removeFaction(item.id)}>
                    <IconX size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="powerplay-hint bgs-hint">
            Фракции не выбраны — на карте все населённые системы с минорными фракциями. Найдите фракцию и нажмите на неё,
            чтобы показать только её системы; можно выбрать несколько (до {BGS_MAX_SELECTED}).
          </p>
        )}
        {presenceError && <div className="powerplay-warning">{presenceError}</div>}
        {selectionMode && (
          <div className="bgs-options">
            <label className="bgs-check">
              <input type="checkbox" checked={filter.controlsOnly} onChange={(event) => setFilter({ ...filter, controlsOnly: event.target.checked })} />
              только системы, где выбранная фракция у власти
            </label>
            <label className="bgs-check">
              <input type="checkbox" checked={filter.background} onChange={(event) => setFilter({ ...filter, background: event.target.checked })} />
              остальные населённые системы — фоном
            </label>
            {visibleSelected === 0 && <div className="powerplay-warning">Все выбранные фракции скрыты — включите хотя бы одну.</div>}
          </div>
        )}
      </div>

      {/* ── Фильтр по принадлежности (все населённые системы / фон) ── */}
      {(!selectionMode || filter.background) && (
        <div className="bgs-allegiance-filter">
          <div className="powerplay-group-head">
            <span className="powerplay-group-title">Принадлежность систем</span>
            <span className="powerplay-group-actions">
              <button type="button" className="atlas-link-btn" onClick={() => setFilter({ ...filter, hiddenAllegiances: DEFAULT_BGS_FILTER.hiddenAllegiances })} disabled={filter.hiddenAllegiances.length === 0}>
                все
              </button>
            </span>
          </div>
          <div className="powerplay-chips" role="group" aria-label="Принадлежность систем">
            {BGS_ALLEGIANCES.filter((allegiance) => allegianceCounts[allegiance] > 0 || !loaded).map((allegiance) => {
              const on = !filter.hiddenAllegiances.includes(allegiance);
              return (
                <button
                  key={allegiance}
                  type="button"
                  className={`powerplay-chip bgs-chip${on ? ' active' : ''}`}
                  aria-pressed={on}
                  data-bgs-allegiance={allegiance}
                  title={on ? `Скрыть: ${allegianceLabel(allegiance)} (двойной клик — только эта)` : `Показать: ${allegianceLabel(allegiance)}`}
                  onClick={() => setFilter(toggleAllegiance(filter, allegiance))}
                  onDoubleClick={() => setFilter(soloAllegiance(filter, allegiance))}
                >
                  <span className="bgs-dot" style={{ background: BGS_ALLEGIANCE_COLOR[allegiance] }} />
                  {allegianceLabel(allegiance)}
                  {loaded && <span className="powerplay-chip-count">{formatCount(allegianceCounts[allegiance])}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(loaded || selectionMode) && (
        <>
          <div className="powerplay-summary">
            <span>
              На карте: <strong>{formatCount(mapCount)}</strong> {selectionMode ? 'систем выбранных фракций' : `из ${formatCount(systems.length)} населённых систем`}
            </span>
            <button
              type="button"
              className="atlas-link-btn powerplay-overview"
              onClick={() => focusOverview()}
              disabled={mapCount === 0}
              title="Подвести камеру так, чтобы были видны все системы под фильтром"
            >
              Показать целиком
            </button>
            {!visible && <div className="powerplay-warning">Слой выключен — включите «Показывать на карте».</div>}
            <div className="powerplay-hint">Системы кликабельны: щёлкните точку на карте или строку списка — откроется карточка со всеми фракциями системы.</div>
          </div>

          <div className="atlas-inline-search">
            <IconSearch size={12} />
            <input
              type="search"
              value={listQuery}
              onChange={(event) => {
                setListQuery(event.target.value);
                setLimit(PAGE_SIZE);
              }}
              placeholder="Найти систему на карте"
              aria-label="Поиск системы среди систем слоя"
            />
            {listQuery && (
              <button type="button" onClick={() => setListQuery('')} aria-label="Очистить поиск системы">
                <IconX size={11} />
              </button>
            )}
          </div>
          <p className="atlas-list-counter">
            Показано {formatCount(shown.length)} из {formatCount(listed.length)}
            {selectionMode ? ' — сначала где выбранные фракции у власти, затем по влиянию' : ' — по имени'}
          </p>
          <ul className="powerplay-list bgs-list" aria-label="Системы слоя «Фракции»">
            {shown.map((point) => (
              <li key={point.key}>
                <FactionRow point={point} active={selectedKey === point.key} onClick={() => select(point, { focus: true })} />
              </li>
            ))}
            {listed.length === 0 && (
              <li className="powerplay-empty">
                {listQuery
                  ? 'Под поиск ничего не нашлось'
                  : selectionMode
                    ? presenceStatus === 'loading' ? 'Загружаю системы выбранных фракций…' : 'У выбранных фракций под фильтром систем нет'
                    : 'Под фильтр систем нет'}
              </li>
            )}
          </ul>
          {listed.length > shown.length && (
            <button type="button" className="atlas-link-btn powerplay-more" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              Показать ещё {formatCount(Math.min(PAGE_SIZE, listed.length - shown.length))}
            </button>
          )}
          <p className="powerplay-hint">
            Источники: ночной дамп EDSM и журналы пилотов — Colonial Helper и загрузка журналов на сайте обновляют системы,
            где пилоты побывали, сразу после прыжка (свежее наблюдение побеждает).
          </p>
        </>
      )}
    </div>
  );
}

function FactionRow({ point, active, onClick }: { point: BgsMapPoint; active: boolean; onClick: () => void }) {
  const lead = point.entries[0];
  let meta: ReactNode;
  if (point.entries.length > 0) {
    meta = point.entries.slice(0, 3).map((entry, index) => (
      <span key={entry.factionId}>
        {index > 0 ? ' · ' : ''}
        <span style={{ color: entry.color }}>{entry.name}</span> {formatInfluence(entry.influence)}
        {entry.controls ? ' (у власти)' : ''}
        {entry.state && entry.state !== 'None' ? (
          <span style={{ color: BGS_CONFLICT_STATES.has(entry.state) ? '#f87171' : undefined }}>, {stateLabel(entry.state).toLowerCase()}</span>
        ) : null}
      </span>
    ));
  } else {
    meta = (
      <>
        {point.system?.controlling ? `${point.system.controlling} · ` : ''}
        {allegianceLabel(point.system?.allegiance)}
        {point.system?.population ? ` · ${formatPopulation(point.system.population)}` : ''}
        {point.system ? ` · фракций ${point.system.factionsCount}` : ''}
      </>
    );
  }
  return (
    <button
      type="button"
      className={`powerplay-row bgs-row${active ? ' active' : ''}`}
      aria-pressed={active}
      data-bgs-row={point.name}
      onClick={onClick}
      title="Показать на карте и открыть карточку"
    >
      <PowerplayGlyph state={SHAPE_GLYPH[point.shape]} color={lead?.color ?? point.color} size={12} title={lead?.controls ? 'у власти' : 'система'} />
      <span className="powerplay-row-name">{point.name}</span>
      <span className="powerplay-row-meta">{meta}</span>
    </button>
  );
}

export default AtlasFactionsPanel;
