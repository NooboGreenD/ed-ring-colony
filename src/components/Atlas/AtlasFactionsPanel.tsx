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
import { useI18n } from '@/lib/i18n/I18nContext';
import { ALLEGIANCE_KEYS, GOVERNMENT_KEYS, STATE_KEYS, gameLabel } from '@/lib/i18n/gameLabels';

const PAGE_SIZE = 150;
const SHAPE_GLYPH = { 0: 'Exploited', 1: 'Fortified', 2: 'Stronghold' } as const;

function formatCount(value: number, locale: string): string {
  return value.toLocaleString(locale);
}

function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
  const { t, locale } = useI18n();
  const allegianceText = (value?: string | null) => gameLabel(t, ALLEGIANCE_KEYS, value, allegianceLabel(value));
  const governmentText = (value?: string | null) => gameLabel(t, GOVERNMENT_KEYS, value, governmentLabel(value));
  const stateText = (value?: string | null) => gameLabel(t, STATE_KEYS, value, stateLabel(value));
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
        <div className="powerplay-status-title">{t('atlas.ui.bgsLoadingSystems')}</div>
        <StatusBar percent={percent} label={t('atlas.ui.bgsLoadingProgress')} />
        <div className="powerplay-status-detail">
          {download && download.received > 0
            ? (download.total ? t('atlas.ui.bgsBytesOf', { received: formatBgsBytes(download.received), total: formatBgsBytes(download.total) }) : formatBgsBytes(download.received))
            : t('atlas.ui.bgsRequestingSet')}
        </div>
      </>
    );
  } else if (statusKind === 'importing') {
    statusBlock = (
      <>
        <div className="powerplay-status-title">{t('atlas.ui.bgsServerImport')}{serverProgress ? ` — ${Math.round(serverProgress.percent)} %` : '…'}</div>
        <StatusBar percent={serverProgress ? serverProgress.percent : null} label={t('atlas.ui.bgsDumpImportLabel')} />
        <div className="powerplay-status-detail">{serverProgress?.message || t('atlas.ui.bgsDumpParsing')}</div>
        <div className="powerplay-status-hint">{t('atlas.ui.bgsDumpHint')}</div>
      </>
    );
  } else if (statusKind === 'error') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> {t('atlas.ui.bgsLoadFailed')}</div>
        <div className="powerplay-status-detail">{error || t('atlas.ui.bgsServerNoAnswer')}</div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>{t('atlas.ui.bgsRetry')}</button>
      </>
    );
  } else if (statusKind === 'empty') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> {t('atlas.ui.bgsNoDataYet')}</div>
        <div className="powerplay-status-detail">
          {meta?.lastError ? t('atlas.ui.bgsLastLoadFailed', { error: meta.lastError }) : t('atlas.ui.bgsDumpNotUploaded')}
        </div>
        <div className="powerplay-status-hint">
          {t('atlas.ui.bgsAdminHint')}
        </div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>{t('atlas.ui.bgsCheckAgain')}</button>
      </>
    );
  } else {
    statusBlock = (
      <>
        <div className="powerplay-status-title">
          <IconCheckCircle size={12} /> {t('atlas.ui.bgsSystemsAndFactions', { systems: formatCount(systems.length, locale), factions: formatCount(meta?.factions ?? 0, locale) })}
        </div>
        <div className="powerplay-status-detail">
          {meta?.dumpGeneratedAt || meta?.syncedAt ? <>{t('atlas.ui.bgsDumpFrom', { date: formatBgsDate(meta?.dumpGeneratedAt ?? meta?.syncedAt) })}</> : t('atlas.ui.bgsDumpMissing')}
          {meta?.pilotUpdateAt ? t('atlas.ui.bgsPilotsUpdated', { date: formatDateTime(meta.pilotUpdateAt, locale) }) : ''}
          {' · '}
          <a href={meta?.sourceUrl || 'https://www.edsm.net/en/nightly-dumps'} target="_blank" rel="noopener noreferrer">EDSM</a>
        </div>
        {importing && (
          <div className="powerplay-status-hint">
            {t('atlas.ui.bgsServerUpdating', { progress: serverProgress ? `: ${serverProgress.stageLabel.toLowerCase()}, ${Math.round(serverProgress.percent)} %` : '…' })}
          </div>
        )}
        {meta?.lastError && <div className="powerplay-warning">{t('atlas.ui.bgsLastUpdateFailed', { error: meta.lastError })}</div>}
      </>
    );
  }

  const presenceFor = (id: number) => presence.get(id) ?? null;

  return (
    <div className="atlas-section powerplay-panel bgs-panel" data-bgs-panel="">
      <div className="atlas-section-head">
        <h4>
          <IconShieldHalf size={13} /> {t('atlas.ui.bgsTitle')}
        </h4>
        <div className="atlas-section-actions">
          <button type="button" className="atlas-icon-btn" title={t('atlas.ui.bgsExportCsvTitle')} onClick={exportList} disabled={listed.length === 0}>
            <IconDownload size={12} />
          </button>
          <button type="button" className="atlas-icon-btn" title={t('atlas.ui.bgsReloadTitle')} onClick={reload}>
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <div className={`powerplay-state-card ${statusKind}`} data-bgs-status={statusKind} role="status" aria-live="polite">
        {statusBlock}
      </div>

      <label className="powerplay-toggle bgs-toggle">
        <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
        {t('atlas.ui.bgsShowOnMap')}
        {(loaded || selectionMode) && <span className="powerplay-toggle-count">{formatCount(mapCount, locale)}</span>}
      </label>

      {/* ── Поиск и выбор фракций ── */}
      <div className="bgs-picker" data-bgs-picker="">
        <div className="powerplay-group-head">
          <span className="powerplay-group-title">{t('atlas.ui.bgsMapFactionsTitle', { selected: selection.length, max: BGS_MAX_SELECTED })}</span>
          {selectionMode && (
            <span className="powerplay-group-actions">
              <button type="button" className="atlas-link-btn" onClick={() => focusOverview()} disabled={mapCount === 0} title={t('atlas.ui.bgsFocusSelectedTitle')}>
                {t('atlas.ui.bgsShowWhole')}
              </button>
              <button type="button" className="atlas-link-btn" onClick={clearSelection} data-bgs-clear="">
                {t('atlas.ui.bgsReset')}
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
            placeholder={t('atlas.ui.bgsSearchFactionPlaceholder')}
            aria-label={t('atlas.ui.bgsSearchFactionAria')}
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label={t('atlas.ui.bgsClearFactionSearchAria')}>
              <IconX size={11} />
            </button>
          )}
        </div>
        <label className="bgs-check">
          <input type="checkbox" checked={playerOnly} onChange={(event) => setPlayerOnly(event.target.checked)} />
          {t('atlas.ui.bgsPlayerOnly')}
        </label>
        {searchActive && (
          <ul className="bgs-results" aria-label={t('atlas.ui.bgsResultsAria')} data-bgs-results="">
            {search.loading && search.results.length === 0 && <li className="powerplay-empty">{t('atlas.ui.bgsSearching')}</li>}
            {search.error && <li className="powerplay-empty" style={{ color: '#f87171' }}>{search.error}</li>}
            {!search.loading && !search.error && search.results.length === 0 && (
              <li className="powerplay-empty">{query.trim().length >= 2 ? t('atlas.ui.bgsFactionNotFound', { name: query.trim() }) : t('atlas.ui.bgsNothingFound')}</li>
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
                    title={chosen ? t('atlas.ui.bgsAlreadyOnMap') : full ? t('atlas.ui.bgsMaxFactions', { count: BGS_MAX_SELECTED }) : t('atlas.ui.bgsShowAllSystems')}
                    onClick={() => (chosen ? removeFaction(result.id) : addFaction(result))}
                  >
                    <PowerSwatch color={BGS_ALLEGIANCE_COLOR[result.allegiance]} />
                    <span className="bgs-result-name">
                      {result.name}
                      {result.isPlayer && <span className="bgs-pmf" title={t('atlas.ui.bgsPlayerFactionTitle')}>PMF</span>}
                    </span>
                    <span className="bgs-result-meta">
                      {t('atlas.ui.bgsFactionMeta', { allegiance: allegianceText(result.allegiance), government: governmentText(result.government), systems: formatCount(result.systems, locale) })}
                      {result.controlled > 0 ? t('atlas.ui.bgsControlledSuffix', { count: formatCount(result.controlled, locale) }) : ''}
                    </span>
                    <span className="bgs-result-action" aria-hidden="true">{chosen ? <IconX size={11} /> : <IconPlus size={11} />}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selectionMode ? (
          <ul className="bgs-selected" aria-label={t('atlas.ui.bgsSelectedAria')} data-bgs-selected="">
            {selection.map((item) => {
              const info = presenceFor(item.id);
              const counts = info
                ? t('atlas.ui.bgsPresenceCounts', { systems: formatCount(info.systems.length, locale), controlled: formatCount(info.systems.filter((system) => system.controls).length, locale) })
                : presenceStatus === 'error' ? t('atlas.ui.bgsPresenceLoadError') : t('atlas.ui.bgsPresenceLoading');
              return (
                <li key={item.id} className={`bgs-selected-item${item.hidden ? ' off' : ''}`} data-bgs-selected-faction={item.name}>
                  <button
                    type="button"
                    className="bgs-swatch-btn"
                    title={item.hidden ? t('atlas.ui.bgsShowOnMapShort') : t('atlas.ui.bgsHideFromMap')}
                    aria-pressed={!item.hidden}
                    onClick={() => toggleFactionHidden(item.id)}
                  >
                    <PowerSwatch color={item.color} />
                  </button>
                  <button
                    type="button"
                    className="bgs-selected-name"
                    title={t('atlas.ui.bgsFocusFactionTitle')}
                    onClick={() => info && focusOverview(info.systems.filter((system) => !filter.controlsOnly || system.controls))}
                  >
                    <span className="bgs-selected-title">
                      {item.name}
                      {info?.isPlayer && <span className="bgs-pmf">PMF</span>}
                    </span>
                    <span className="bgs-selected-meta">{counts}</span>
                  </button>
                  <button type="button" className="powerplay-solo" title={t('atlas.ui.bgsSoloTitle')} onClick={() => soloFaction(item.id)}>
                    {t('atlas.ui.bgsSoloOnly')}
                  </button>
                  <button type="button" className="bgs-icon-btn" title={item.hidden ? t('atlas.ui.bgsShow') : t('atlas.ui.bgsHide')} aria-label={item.hidden ? t('atlas.ui.bgsShowFactionAria') : t('atlas.ui.bgsHideFactionAria')} onClick={() => toggleFactionHidden(item.id)}>
                    <IconEye size={11} />
                  </button>
                  <button type="button" className="bgs-icon-btn" title={t('atlas.ui.bgsRemoveFromMap')} aria-label={t('atlas.ui.bgsRemoveFactionAria', { name: item.name })} onClick={() => removeFaction(item.id)}>
                    <IconX size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="powerplay-hint bgs-hint">
            {t('atlas.ui.bgsNoSelectionHint', { max: BGS_MAX_SELECTED })}
          </p>
        )}
        {presenceError && <div className="powerplay-warning">{presenceError}</div>}
        {selectionMode && (
          <div className="bgs-options">
            <label className="bgs-check">
              <input type="checkbox" checked={filter.controlsOnly} onChange={(event) => setFilter({ ...filter, controlsOnly: event.target.checked })} />
              {t('atlas.ui.bgsControlsOnly')}
            </label>
            <label className="bgs-check">
              <input type="checkbox" checked={filter.background} onChange={(event) => setFilter({ ...filter, background: event.target.checked })} />
              {t('atlas.ui.bgsBackground')}
            </label>
            {visibleSelected === 0 && <div className="powerplay-warning">{t('atlas.ui.bgsAllHidden')}</div>}
          </div>
        )}
      </div>

      {/* ── Фильтр по принадлежности (все населённые системы / фон) ── */}
      {(!selectionMode || filter.background) && (
        <div className="bgs-allegiance-filter">
          <div className="powerplay-group-head">
            <span className="powerplay-group-title">{t('atlas.ui.bgsAllegianceTitle')}</span>
            <span className="powerplay-group-actions">
              <button type="button" className="atlas-link-btn" onClick={() => setFilter({ ...filter, hiddenAllegiances: DEFAULT_BGS_FILTER.hiddenAllegiances })} disabled={filter.hiddenAllegiances.length === 0}>
                {t('atlas.ui.bgsAll')}
              </button>
            </span>
          </div>
          <div className="powerplay-chips" role="group" aria-label={t('atlas.ui.bgsAllegianceTitle')}>
            {BGS_ALLEGIANCES.filter((allegiance) => allegianceCounts[allegiance] > 0 || !loaded).map((allegiance) => {
              const on = !filter.hiddenAllegiances.includes(allegiance);
              return (
                <button
                  key={allegiance}
                  type="button"
                  className={`powerplay-chip bgs-chip${on ? ' active' : ''}`}
                  aria-pressed={on}
                  data-bgs-allegiance={allegiance}
                  title={on ? t('atlas.ui.bgsHideAllegiance', { name: allegianceText(allegiance) }) : t('atlas.ui.bgsShowAllegiance', { name: allegianceText(allegiance) })}
                  onClick={() => setFilter(toggleAllegiance(filter, allegiance))}
                  onDoubleClick={() => setFilter(soloAllegiance(filter, allegiance))}
                >
                  <span className="bgs-dot" style={{ background: BGS_ALLEGIANCE_COLOR[allegiance] }} />
                  {allegianceText(allegiance)}
                  {loaded && <span className="powerplay-chip-count">{formatCount(allegianceCounts[allegiance], locale)}</span>}
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
              {t('atlas.ui.bgsOnMapLead')} <strong>{formatCount(mapCount, locale)}</strong> {selectionMode ? t('atlas.ui.bgsOnMapSelected') : t('atlas.ui.bgsOnMapOf', { count: formatCount(systems.length, locale) })}
            </span>
            <button
              type="button"
              className="atlas-link-btn powerplay-overview"
              onClick={() => focusOverview()}
              disabled={mapCount === 0}
              title={t('atlas.ui.bgsOverviewTitle')}
            >
              {t('atlas.ui.bgsShowWholeBtn')}
            </button>
            {!visible && <div className="powerplay-warning">{t('atlas.ui.bgsLayerOff')}</div>}
            <div className="powerplay-hint">{t('atlas.ui.bgsClickHint')}</div>
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
              placeholder={t('atlas.ui.bgsSearchSystemPlaceholder')}
              aria-label={t('atlas.ui.bgsSearchSystemAria')}
            />
            {listQuery && (
              <button type="button" onClick={() => setListQuery('')} aria-label={t('atlas.ui.bgsClearSystemSearchAria')}>
                <IconX size={11} />
              </button>
            )}
          </div>
          <p className="atlas-list-counter">
            {t('atlas.shownOf', { shown: formatCount(shown.length, locale), total: formatCount(listed.length, locale) })}
            {selectionMode ? t('atlas.ui.bgsListCountSuffixOrder') : t('atlas.ui.bgsListCountSuffixName')}
          </p>
          <ul className="powerplay-list bgs-list" aria-label={t('atlas.ui.bgsListAria')}>
            {shown.map((point) => (
              <li key={point.key}>
                <FactionRow point={point} active={selectedKey === point.key} onClick={() => select(point, { focus: true })} />
              </li>
            ))}
            {listed.length === 0 && (
              <li className="powerplay-empty">
                {listQuery
                  ? t('atlas.ui.bgsNoSearchResults')
                  : selectionMode
                    ? presenceStatus === 'loading' ? t('atlas.ui.bgsLoadingSelectedSystems') : t('atlas.ui.bgsNoSelectedUnderFilter')
                    : t('atlas.ui.bgsNoFilterResults')}
              </li>
            )}
          </ul>
          {listed.length > shown.length && (
            <button type="button" className="atlas-link-btn powerplay-more" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
              {t('atlas.ui.bgsShowMore', { count: formatCount(Math.min(PAGE_SIZE, listed.length - shown.length), locale) })}
            </button>
          )}
          <p className="powerplay-hint">
            {t('atlas.ui.bgsSourcesHint')}
          </p>
        </>
      )}
    </div>
  );
}

function FactionRow({ point, active, onClick }: { point: BgsMapPoint; active: boolean; onClick: () => void }) {
  const { t } = useI18n();
  const allegianceText = (value?: string | null) => gameLabel(t, ALLEGIANCE_KEYS, value, allegianceLabel(value));
  const stateText = (value?: string | null) => gameLabel(t, STATE_KEYS, value, stateLabel(value));
  const lead = point.entries[0];
  let meta: ReactNode;
  if (point.entries.length > 0) {
    meta = point.entries.slice(0, 3).map((entry, index) => (
      <span key={entry.factionId}>
        {index > 0 ? ' · ' : ''}
        <span style={{ color: entry.color }}>{entry.name}</span> {formatInfluence(entry.influence)}
        {entry.controls ? t('atlas.ui.bgsControlsSuffix') : ''}
        {entry.state && entry.state !== 'None' ? (
          <span style={{ color: BGS_CONFLICT_STATES.has(entry.state) ? '#f87171' : undefined }}>, {stateText(entry.state)}</span>
        ) : null}
      </span>
    ));
  } else {
    meta = (
      <>
        {point.system?.controlling ? `${point.system.controlling} · ` : ''}
        {allegianceText(point.system?.allegiance)}
        {point.system?.population ? ` · ${formatPopulation(point.system.population)}` : ''}
        {point.system ? t('atlas.ui.bgsFactionsSuffix', { count: point.system.factionsCount }) : ''}
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
      title={t('atlas.ui.bgsRowTitle')}
    >
      <PowerplayGlyph state={SHAPE_GLYPH[point.shape]} color={lead?.color ?? point.color} size={12} title={lead?.controls ? t('atlas.ui.bgsInControl') : t('atlas.ui.bgsSystemWord')} />
      <span className="powerplay-row-name">{point.name}</span>
      <span className="powerplay-row-meta">{meta}</span>
    </button>
  );
}

export default AtlasFactionsPanel;
