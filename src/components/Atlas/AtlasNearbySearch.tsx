'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { RangeNumberField } from './RangeNumberField';
import { downloadCsv } from '@/lib/atlas';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  type NearbyResult,
  type NearbyShape,
  type NearbySourceId,
} from '@/lib/atlasNearby';
import {
  startAtlasSearchProgress,
  finishAtlasSearchProgress,
  publishAtlasSearchPoints,
} from '@/lib/atlasSearchProgress';

const SOURCE_NAMES: Record<NearbySourceId, string> = {
  catalog: 'atlas.ui.sourceCatalog',
  cache: 'atlas.ui.sourceCache',
  'edsm-sphere': 'atlas.ui.sourceEdsmSphere',
  'edsm-cube': 'atlas.ui.sourceEdsmCube',
  spansh: 'Spansh API',
};
const STATUS_NAMES = {
  ok: 'atlas.ui.sourceOk',
  empty: 'atlas.ui.sourceEmpty',
  partial: 'atlas.ui.sourcePartial',
  unavailable: 'atlas.ui.sourceUnavailable',
};

export default function AtlasNearbySearch({
  initialSystem = 'Sol',
}: {
  initialSystem?: string;
}) {
  const { t, locale } = useI18n();
  const [system, setSystem] = useState(initialSystem || 'Sol');
  const [shape, setShape] = useState<NearbyShape>('sphere');
  const [radius, setRadius] = useState(10);
  const [result, setResult] = useState<NearbyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(100);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    []
  );
  useEffect(() => {
    if (initialSystem) setSystem(initialSystem);
  }, [initialSystem]);
  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (
      result?.systems.filter(
        (row) =>
          !query ||
          row.name.toLowerCase().includes(query) ||
          row.aliases.some((name) => name.toLowerCase().includes(query))
      ) ?? []
    );
  }, [result, filter]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const currentPage = Math.min(page, pages);
  const displayed = rows.slice((currentPage - 1) * size, currentPage * size);
  const stop = () => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    setLoading(false);
    finishAtlasSearchProgress({
      stage: 'done',
      message: t('atlas.ui.nearbyStopped'),
    });
  };
  const search = async () => {
    controller.current?.abort();
    const activeGeneration = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setLoading(true);
    setError('');
    setResult(null);
    setPage(1);
    setFilter('');
    startAtlasSearchProgress({
      kind: 'nearby',
      title: t('atlas.ui.nearbyOverlayTitle'),
      stage: 'coords',
      message: t('atlas.ui.nearbyComparing', { system: system.trim() }),
    });
    try {
      const response = await fetch('/api/atlas/nearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
        body: JSON.stringify({
          reference_system: system.trim(),
          shape,
          radius,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (activeGeneration !== generation.current) return;
      if (!response.ok)
        throw new Error(
          data.error || t('atlas.ui.errSearchHttp', { status: response.status })
        );
      if (!Array.isArray(data.systems) || !Array.isArray(data.sources))
        throw new Error(t('atlas.ui.errNoSystemList'));
      setResult(data);
      // The overlay is capped independently of the complete result table/CSV.
      publishAtlasSearchPoints(
        data.systems.slice(0, 4000).map((row: any) => ({
          name: row.name,
          x: row.x,
          y: row.y,
          z: row.z,
          kind: 'system',
          label: row.name,
        }))
      );
      finishAtlasSearchProgress({
        stage: 'done',
        percent: 100,
        message: t('atlas.ui.nearbyFound', { count: data.systems.length }),
        summary: t('atlas.ui.nearbyFullList'),
        beam: {
          x: data.reference.x,
          y: data.reference.y,
          z: data.reference.z,
          label: data.reference.name,
        },
      });
    } catch (caught) {
      if (activeGeneration !== generation.current) return;
      const message =
        caught instanceof Error ? caught.message : t('atlas.ui.errFindSystems');
      setError(message);
      finishAtlasSearchProgress({ stage: 'failed', message });
    } finally {
      if (activeGeneration === generation.current) {
        setLoading(false);
        controller.current = null;
      }
    }
  };
  const focusSystem = (row: NearbyResult['systems'][number]) => {
    publishAtlasSearchPoints([
      {
        name: row.name,
        x: row.x,
        y: row.y,
        z: row.z,
        kind: 'system',
        label: row.name,
      },
    ]);
    window.dispatchEvent(
      new CustomEvent('atlas-focus-system', { detail: row })
    );
  };
  const exportResults = () => {
    if (!result) return;
    downloadCsv(
      `nearby-${result.reference.name}-${result.shape}-${result.radius}`,
      [
        [
          t('atlas.csvSystem'),
          t('atlas.ui.csvDistanceLy'),
          'X',
          'Y',
          'Z',
          'ID64',
          t('atlas.ui.csvSources'),
          t('atlas.ui.csvAltNames'),
          t('atlas.ui.csvCoordConflict'),
        ],
        ...rows.map((row) => [
          row.name,
          row.distance,
          row.x,
          row.y,
          row.z,
          row.id64 || '',
          row.sources.map((id) => t(SOURCE_NAMES[id])).join('; '),
          row.aliases.join('; '),
          row.coordinate_conflict ? t('atlas.ui.yes') : t('atlas.ui.no'),
        ]),
      ]
    );
  };
  return (
    <div className="atlas-section">
      <h4>{t('atlas.ui.nearbyTitle')}</h4>
      <p className="atlas-muted">{t('atlas.ui.nearbyIntro')}</p>
      <SystemSearchInput
        label={t('atlas.ui.refSystem')}
        value={system}
        onChange={setSystem}
        disabled={loading}
        onSubmit={() => {
          if (!loading && system.trim()) void search();
        }}
      />
      <div className="atlas-search-field">
        <label htmlFor="atlas-nearby-shape">{t('atlas.ui.shapeLabel')}</label>
        <select
          id="atlas-nearby-shape"
          value={shape}
          disabled={loading}
          onChange={(event) => setShape(event.target.value as NearbyShape)}
        >
          <option value="sphere">{t('atlas.ui.shapeSphere')}</option>
          <option value="cube">{t('atlas.ui.shapeCube')}</option>
        </select>
      </div>
      <RangeNumberField
        id="atlas-nearby-radius"
        label={shape === 'sphere' ? t('atlas.ui.radiusSphere') : t('atlas.ui.radiusCube')}
        min={1}
        max={50}
        step={1}
        value={radius}
        onChange={setRadius}
        disabled={loading}
        hint={
          shape === 'sphere'
            ? t('atlas.ui.sphereHint')
            : t('atlas.ui.cubeHint', { radius, side: radius * 2 })
        }
      />
      <div className="atlas-button-row">
        <button
          type="button"
          className="atlas-scan-btn"
          disabled={loading || !system.trim()}
          onClick={() => void search()}
        >
          {loading ? t('atlas.ui.nearbyComparingShort') : t('atlas.ui.findAllSystems')}
        </button>
        {loading && (
          <button type="button" className="atlas-stop-btn" onClick={stop}>
            {t('atlas.ui.stop')}
          </button>
        )}
      </div>
      {loading && (
        <p role="status" className="atlas-muted">{t('atlas.ui.nearbyReading')}</p>
      )}
      {error && (
        <p className="atlas-inline-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <h4>
            {t('atlas.ui.systemsFound', { count: result.systems.length.toLocaleString(locale) })}
          </h4>
          <p className="atlas-muted">
            {result.reference.name} ·{' '}
            {t('atlas.ui.shapeRadius', {
              shape: result.shape === 'sphere' ? t('atlas.ui.shapeSphereLower') : t('atlas.ui.shapeCubeLower'),
              radius: result.radius,
            })}
          </p>
          <details open>
            <summary>{t('atlas.ui.sourcesChecked')}</summary>
            <ul>
              {result.sources.map((source) => (
                <li key={source.id}>
                  {t(SOURCE_NAMES[source.id])} — {t(STATUS_NAMES[source.status])} (
                  {source.count.toLocaleString(locale)})
                  {source.message && `: ${source.message}`}
                </li>
              ))}
            </ul>
          </details>
          {result.warnings.length > 0 && (
            <details open className="atlas-muted">
              <summary>{t('atlas.ui.limitsWarnings')}</summary>
              <ul>
                {result.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {result.systems.length > 4000 && (
            <p className="atlas-muted">{t('atlas.ui.nearbyMapLimit')}</p>
          )}
          <div className="atlas-search-field">
            <label htmlFor="atlas-nearby-filter">{t('atlas.ui.searchWholeList')}</label>
            <input
              id="atlas-nearby-filter"
              type="search"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
              }}
              placeholder={t('atlas.ui.systemNamePlaceholder')}
            />
          </div>
          <button
            type="button"
            className="btn"
            onClick={exportResults}
            disabled={!rows.length}
          >
            {t('atlas.ui.csvWholeList', {
              scope: filter.trim() ? t('atlas.ui.csvScopeFiltered') : '',
              count: rows.length,
            })}
          </button>
          <nav
            className="atlas-nearby-pagination"
            aria-label={t('atlas.ui.paginationAria')}
          >
            <label>
              {t('atlas.ui.rowsPerPage')}{' '}
              <select
                aria-label={t('atlas.ui.rowsPerPage')}
                value={size}
                onChange={(event) => {
                  setSize(Number(event.target.value));
                  setPage(1);
                }}
              >
                {[50, 100, 250].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage(1)}
              aria-label={t('atlas.ui.firstPage')}
            >
              «
            </button>
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              aria-label={t('atlas.ui.prevPage')}
            >
              ‹
            </button>
            <label>
              {t('atlas.ui.pageLabel')}{' '}
              <select
                aria-label={t('atlas.ui.pageLabel')}
                value={currentPage}
                onChange={(event) => setPage(Number(event.target.value))}
              >
                {Array.from({ length: pages }, (_, index) => (
                  <option key={index + 1} value={index + 1}>
                    {index + 1}
                  </option>
                ))}
              </select>{' '}
              / {pages}
            </label>
            <button
              type="button"
              disabled={currentPage === pages}
              onClick={() => setPage(currentPage + 1)}
              aria-label={t('atlas.ui.nextPage')}
            >
              ›
            </button>
            <button
              type="button"
              disabled={currentPage === pages}
              onClick={() => setPage(pages)}
              aria-label={t('atlas.ui.lastPage')}
            >
              »
            </button>
          </nav>
          <p className="atlas-list-counter">
            {t('atlas.ui.pageRange', {
              from: rows.length ? (currentPage - 1) * size + 1 : 0,
              to: Math.min(currentPage * size, rows.length),
              total: rows.length,
            })}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('atlas.csvSystem')}</th>
                  <th>{t('atlas.ui.colLy')}</th>
                  <th>{t('atlas.ui.colCoords')}</th>
                  <th>{t('atlas.ui.csvSources')}</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <button
                        type="button"
                        className="atlas-link-btn"
                        title={t('atlas.showOnMap')}
                        onClick={() => focusSystem(row)}
                      >
                        {row.name}
                      </button>
                      {row.coordinate_conflict && (
                        <span title={t('atlas.ui.sourcesConflict')}>
                          {' '}
                          ⚠
                        </span>
                      )}
                    </td>
                    <td>
                      {row.distance.toLocaleString(locale, {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td>
                      {[row.x, row.y, row.z]
                        .map((value) =>
                          value.toLocaleString(locale, {
                            maximumFractionDigits: 3,
                          })
                        )
                        .join(' / ')}
                    </td>
                    <td>
                      {row.sources.map((id) => t(SOURCE_NAMES[id])).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="atlas-muted">{t('atlas.ui.nearbyNone')}</p>
          )}
        </>
      )}
    </div>
  );
}
