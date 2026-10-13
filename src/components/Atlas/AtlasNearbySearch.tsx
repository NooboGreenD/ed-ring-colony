'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { RangeNumberField } from './RangeNumberField';
import { downloadCsv } from '@/lib/atlas';
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
  catalog: 'Каталог Spansh',
  cache: 'Кэш Atlas',
  'edsm-sphere': 'EDSM: сфера',
  'edsm-cube': 'EDSM: куб',
  spansh: 'Spansh API',
};
const STATUS_NAMES = {
  ok: 'прочитан',
  empty: 'нет записей',
  partial: 'частичные данные',
  unavailable: 'недоступен',
};

export default function AtlasNearbySearch({
  initialSystem = 'Sol',
}: {
  initialSystem?: string;
}) {
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
      message: 'Поиск ближайших систем остановлен',
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
      title: 'БЛИЖАЙШИЕ СИСТЕМЫ',
      stage: 'coords',
      message: `Сверяем источники вокруг ${system.trim()}`,
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
          data.error || `Ошибка поиска (HTTP ${response.status})`
        );
      if (!Array.isArray(data.systems) || !Array.isArray(data.sources))
        throw new Error('Источник не вернул список систем.');
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
        message: `Найдено ${data.systems.length} систем`,
        summary:
          'Полный полученный список доступен в панели; статусы источников и ограничения указаны отдельно.',
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
        caught instanceof Error ? caught.message : 'Не удалось найти системы';
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
          'Система',
          'Расстояние, св.л.',
          'X',
          'Y',
          'Z',
          'ID64',
          'Источники',
          'Альтернативные имена',
          'Расхождение координат',
        ],
        ...rows.map((row) => [
          row.name,
          row.distance,
          row.x,
          row.y,
          row.z,
          row.id64 || '',
          row.sources.map((id) => SOURCE_NAMES[id]).join('; '),
          row.aliases.join('; '),
          row.coordinate_conflict ? 'Да' : 'Нет',
        ]),
      ]
    );
  };
  return (
    <div className="atlas-section">
      <h4>Все системы поблизости</h4>
      <p className="atlas-muted">
        Поиск известных систем без фильтров по мирам, населению или товарам.
        Сверяем локальный каталог, кэш Atlas, EDSM и Spansh API.
      </p>
      <SystemSearchInput
        label="Система отсчёта"
        value={system}
        onChange={setSystem}
        disabled={loading}
        onSubmit={() => {
          if (!loading && system.trim()) void search();
        }}
      />
      <div className="atlas-search-field">
        <label htmlFor="atlas-nearby-shape">Форма области</label>
        <select
          id="atlas-nearby-shape"
          value={shape}
          disabled={loading}
          onChange={(event) => setShape(event.target.value as NearbyShape)}
        >
          <option value="sphere">Сфера</option>
          <option value="cube">Куб</option>
        </select>
      </div>
      <RangeNumberField
        id="atlas-nearby-radius"
        label={shape === 'sphere' ? 'Радиус сферы' : 'От центра до грани куба'}
        min={1}
        max={50}
        step={1}
        value={radius}
        onChange={setRadius}
        disabled={loading}
        hint={
          shape === 'sphere'
            ? 'Все системы на расстоянии не больше указанного радиуса.'
            : `Куб ±${radius} св.л. по каждой оси; сторона ${radius * 2} св.л. Углы дальше радиуса сферы.`
        }
      />
      <div className="atlas-button-row">
        <button
          type="button"
          className="atlas-scan-btn"
          disabled={loading || !system.trim()}
          onClick={() => void search()}
        >
          {loading ? 'Сверка источников…' : 'Найти все системы'}
        </button>
        {loading && (
          <button type="button" className="atlas-stop-btn" onClick={stop}>
            Стоп
          </button>
        )}
      </div>
      {loading && (
        <p role="status" className="atlas-muted">
          Читаем все страницы локальных данных и Spansh, сверяем сферу и куб
          EDSM. Ожидание до одной минуты.
        </p>
      )}
      {error && (
        <p className="atlas-inline-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <>
          <h4>
            Систем найдено: {result.systems.length.toLocaleString('ru-RU')}
          </h4>
          <p className="atlas-muted">
            {result.reference.name} ·{' '}
            {result.shape === 'sphere' ? 'сфера' : 'куб'} · {result.radius}{' '}
            св.л.
          </p>
          <details open>
            <summary>Проверенные источники</summary>
            <ul>
              {result.sources.map((source) => (
                <li key={source.id}>
                  {SOURCE_NAMES[source.id]} — {STATUS_NAMES[source.status]} (
                  {source.count.toLocaleString('ru-RU')})
                  {source.message && `: ${source.message}`}
                </li>
              ))}
            </ul>
          </details>
          {result.warnings.length > 0 && (
            <details open className="atlas-muted">
              <summary>Ограничения и предупреждения</summary>
              <ul>
                {result.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          {result.systems.length > 4000 && (
            <p className="atlas-muted">
              На карте показаны ближайшие 4 000 систем; список и CSV содержат
              все полученные записи.
            </p>
          )}
          <div className="atlas-search-field">
            <label htmlFor="atlas-nearby-filter">Поиск по всему списку</label>
            <input
              id="atlas-nearby-filter"
              type="search"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setPage(1);
              }}
              placeholder="Название системы"
            />
          </div>
          <button
            type="button"
            className="btn"
            onClick={exportResults}
            disabled={!rows.length}
          >
            CSV: весь {filter.trim() ? 'отфильтрованный ' : ''}список (
            {rows.length})
          </button>
          <nav
            className="atlas-nearby-pagination"
            aria-label="Страницы ближайших систем"
          >
            <label>
              Строк на странице{' '}
              <select
                aria-label="Строк на странице"
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
              aria-label="Первая страница"
            >
              «
            </button>
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              aria-label="Предыдущая страница"
            >
              ‹
            </button>
            <label>
              Страница{' '}
              <select
                aria-label="Страница"
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
              aria-label="Следующая страница"
            >
              ›
            </button>
            <button
              type="button"
              disabled={currentPage === pages}
              onClick={() => setPage(pages)}
              aria-label="Последняя страница"
            >
              »
            </button>
          </nav>
          <p className="atlas-list-counter">
            Показано {rows.length ? (currentPage - 1) * size + 1 : 0}–
            {Math.min(currentPage * size, rows.length)} из {rows.length}. Список
            отсортирован по расстоянию.
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Система</th>
                  <th>Св.л.</th>
                  <th>Координаты</th>
                  <th>Источники</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((row) => (
                  <tr key={row.name}>
                    <td>
                      <button
                        type="button"
                        className="atlas-link-btn"
                        title="Показать на карте"
                        onClick={() => focusSystem(row)}
                      >
                        {row.name}
                      </button>
                      {row.coordinate_conflict && (
                        <span title="Источники расходятся в координатах">
                          {' '}
                          ⚠
                        </span>
                      )}
                    </td>
                    <td>
                      {row.distance.toLocaleString('ru-RU', {
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td>
                      {[row.x, row.y, row.z]
                        .map((value) =>
                          value.toLocaleString('ru-RU', {
                            maximumFractionDigits: 3,
                          })
                        )
                        .join(' / ')}
                    </td>
                    <td>
                      {row.sources.map((id) => SOURCE_NAMES[id]).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!rows.length && (
            <p className="atlas-muted">Систем по этим условиям не найдено.</p>
          )}
        </>
      )}
    </div>
  );
}
