'use client';

/**
 * Вкладка «PowerPlay» в Atlas: все системы под контролем держав PowerPlay 2.0
 * на карте и фильтр отображения по державам.
 *
 *  * сверху — состояние данных: грузит ли браузер набор (полоса в байтах),
 *    загружает ли сервер дамп EDSM (этап и процент), сколько систем на карте и
 *    от какого числа данные, или почему их нет;
 *  * фильтр по державам виден всегда — все двенадцать держав сразу, даже пока
 *    данные грузятся: галочка на каждой, «только эта», «все», «ни одной» и
 *    быстрый выбор фракции (Империя, Федерация, Альянс, независимые);
 *  * фильтр по состоянию (оплоты / укреплённые / эксплуатируемые);
 *  * список систем под фильтр с поиском: клик ведёт камеру к системе и
 *    открывает её карточку (по самой точке на карте тоже можно кликнуть);
 *  * «Чья зона?» — любая система галактики: под чьим она контролем и чьи
 *    оплоты и укреплённые системы до неё дотягиваются. Имена систем в ответе
 *    кликабельны;
 *  * системы, чей владелец не определён (дамп EDSM перечисляет несколько
 *    держав), — отдельная строка фильтра «Держава не определена» и серые
 *    точки; у каждой державы рядом с числом систем — «+N?»: в скольких таких
 *    системах она среди претендентов.
 *
 * Состояние (данные, фильтр, выбор) живёт в `useAtlasPowerplay` на странице:
 * им же пользуется 3D-слой карты.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { PowerSwatch, PowerplayGlyph } from '@/components/GalaxyMap/PowerplayGlyph';
import {
  IconAlert,
  IconAlliance,
  IconCheckCircle,
  IconDownload,
  IconEmpire,
  IconFederation,
  IconIndependent,
  IconPower,
  IconRefresh,
  IconSearch,
  IconX,
} from '@/components/Icons';
import type { AtlasPowerplayState } from '@/hooks/usePowerplayLayer';
import type { SystemSuggestion } from '@/hooks/useSystemAutocomplete';
import { downloadCsv } from '@/lib/atlas';
import {
  POWER_ALLEGIANCE_LABEL,
  POWERPLAY_BASIS_SHORT,
  POWERPLAY_STATE_HINT,
  POWERPLAY_STATE_LABEL,
  POWERPLAY_STATE_PLURAL,
  POWERPLAY_STATES,
  filterPowerplaySystems,
  findPowerplaySystem,
  formatLy,
  formatPowerplayDate,
  hideAllPowers,
  isAllegianceSolo,
  isDefaultPowerplayFilter,
  isPowerVisible,
  isUnknownPower,
  orderPowerplaySystems,
  powerInfo,
  powerplayInfluenceAt,
  searchPowerplaySystems,
  showAllPowers,
  soloAllegiance,
  soloPower,
  togglePowerVisible,
  togglePowerplayState,
  type PowerAllegiance,
  type PowerplayInfluence,
  type PowerplayPoint,
  type PowerplaySystem,
} from '@/lib/powerplay';
import { formatPowerplayBytes } from '@/lib/powerplayProgress';

const PAGE_SIZE = 150;
const MUTED = '#9ca3af';
const DIM = '#6b7280';
const PP_COLOR = '#f0af28';

const ALLEGIANCES: { id: PowerAllegiance; Icon: typeof IconEmpire }[] = [
  { id: 'Empire', Icon: IconEmpire },
  { id: 'Federation', Icon: IconFederation },
  { id: 'Alliance', Icon: IconAlliance },
  { id: 'Independent', Icon: IconIndependent },
];

function formatCount(value: number): string {
  return value.toLocaleString('ru-RU');
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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

/** Полоса хода: с процентом или «бегущая», когда объём заранее неизвестен. */
function StatusBar({ percent, label }: { percent: number | null; label: string }) {
  const value = percent == null ? null : Math.max(0, Math.min(100, percent));
  return (
    <div
      className={`powerplay-progress${value == null ? ' indeterminate' : ''}`}
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

export interface AtlasPowerplayPanelProps {
  powerplay: AtlasPowerplayState;
}

export function AtlasPowerplayPanel({ powerplay }: AtlasPowerplayPanelProps) {
  const {
    visible, setVisible, filter, setFilter, status, data, error, reload, systems, visibleSystems, counts, selectedId, select,
    showSystem, focusOverview, download, filterPowers,
  } = powerplay;
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [checkName, setCheckName] = useState('');
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checkError, setCheckError] = useState('');
  const [checking, setChecking] = useState(false);

  const loaded = systems.length > 0;
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
  const shownPowers = filterPowers.filter((power) => isPowerVisible(filter, power)).length;
  const powersWithSystems = counts.powers.filter((item) => item.total > 0 && !isUnknownPower(item.power)).length;

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
      ['Система', 'Держава', 'Как определена', 'Державы в системе', 'Состояние', 'X', 'Y', 'Z', 'id64', 'Наблюдение'],
      ...listed.map((system) => [
        system.name,
        powerInfo(system.power).label,
        isUnknownPower(system.power) ? POWERPLAY_BASIS_SHORT.unknown : system.basis ? POWERPLAY_BASIS_SHORT[system.basis] : '',
        (system.candidates ?? []).map((candidate) => powerInfo(candidate).label).join('; '),
        POWERPLAY_STATE_LABEL[system.state],
        system.x,
        system.y,
        system.z,
        system.id64,
        formatPowerplayDate(system.observedAt),
      ]),
    ]);
  };

  /* ── Что с данными: одна понятная плашка вместо строчки мелким шрифтом ── */
  const serverProgress = meta?.progress ?? null;
  const importing = status === 'empty' && Boolean(meta?.refreshing);
  const statusKind = status === 'loading' || status === 'idle'
    ? 'loading'
    : status === 'error'
      ? 'error'
      : importing
        ? 'importing'
        : status === 'empty'
          ? 'empty'
          : 'ready';

  let statusBlock: ReactNode = null;
  if (statusKind === 'loading') {
    const percent = download?.total ? (download.received / download.total) * 100 : null;
    statusBlock = (
      <>
        <div className="powerplay-status-title">Загружаю системы держав…</div>
        <StatusBar percent={percent} label="Загрузка систем держав" />
        <div className="powerplay-status-detail">
          {download && download.received > 0
            ? `${formatPowerplayBytes(download.received)}${download.total ? ` из ${formatPowerplayBytes(download.total)}` : ''}`
            : 'Запрашиваю набор у сервера'}
        </div>
      </>
    );
  } else if (statusKind === 'importing') {
    statusBlock = (
      <>
        <div className="powerplay-status-title">Сервер загружает данные EDSM{serverProgress ? ` — ${Math.round(serverProgress.percent)} %` : '…'}</div>
        <StatusBar percent={serverProgress ? serverProgress.percent : null} label="Импорт дампа EDSM на сервере" />
        <div className="powerplay-status-detail">
          {serverProgress?.message || 'Скачивание и разбор дампа EDSM'}
        </div>
        <div className="powerplay-status-hint">Это занимает до минуты. Карта заполнится сама — обновлять страницу не нужно.</div>
      </>
    );
  } else if (statusKind === 'error') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> Не удалось загрузить системы PowerPlay</div>
        <div className="powerplay-status-detail">{error || 'Сервер не ответил'}</div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>Повторить</button>
      </>
    );
  } else if (statusKind === 'empty') {
    statusBlock = (
      <>
        <div className="powerplay-status-title"><IconAlert size={12} /> Данных пока нет</div>
        <div className="powerplay-status-detail">
          {meta?.lastError ? `Последняя загрузка не удалась: ${meta.lastError}.` : 'Сервер ещё не загружал дамп EDSM.'}
        </div>
        <div className="powerplay-status-hint">
          Сайт загружает данные сам (задача powerplay-sync, а при пустой базе — при открытии этой вкладки). Администратор
          может запустить загрузку и посмотреть её журнал: Админка → Игровые данные → PowerPlay.
        </div>
        <button type="button" className="atlas-link-btn powerplay-retry" onClick={reload}>Проверить снова</button>
      </>
    );
  } else {
    statusBlock = (
      <>
        <div className="powerplay-status-title">
          <IconCheckCircle size={12} /> Загружено {formatCount(systems.length)} систем · держав: {powersWithSystems}
        </div>
        <div className="powerplay-status-detail" title="EDSM собирает состояние систем из журналов пилотов (EDDN); в дампе — системы, о которых сообщали за последние ~30 дней">
          Дамп EDSM от {formatPowerplayDate(meta?.dumpGeneratedAt ?? meta?.syncedAt)}
          {meta?.oldestObservation && meta.newestObservation
            ? ` · наблюдения ${formatPowerplayDate(meta.oldestObservation)}–${formatPowerplayDate(meta.newestObservation)}`
            : ''}
          {meta?.checkedAt ? ` · проверено ${formatDateTime(meta.checkedAt)}` : ''}
          {' · '}
          <a href={meta?.sourceUrl || 'https://www.edsm.net/en/nightly-dumps'} target="_blank" rel="noopener noreferrer">EDSM</a>
        </div>
        {counts.unknown > 0 && (
          <div className="powerplay-status-hint" data-powerplay-unknown={counts.unknown}>
            У {formatCount(counts.unknown)} систем владелец не определён (серые точки): дамп EDSM перечисляет все державы,
            чьи зоны накрывают систему, но не говорит, какая из них владеет. Владельца уточняют журналы пилотов
            (Colonial Helper, загрузка журналов, CAPI) и живые данные EDDN; «+N?» у державы — в скольких таких системах
            она среди претендентов.
          </div>
        )}
        {meta?.refreshing && (
          <div className="powerplay-status-hint">
            Сервер обновляет данные{meta.progress ? `: ${meta.progress.stageLabel.toLowerCase()}, ${Math.round(meta.progress.percent)} %` : '…'} —
            новый набор подгрузится сам.
          </div>
        )}
        {meta?.lastError && <div className="powerplay-warning">Последнее обновление не удалось: {meta.lastError}</div>}
      </>
    );
  }

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
          <button type="button" className="atlas-icon-btn" title="Перезапросить данные" onClick={reload}>
            <IconRefresh size={12} />
          </button>
        </div>
      </div>

      <div className={`powerplay-state-card ${statusKind}`} data-powerplay-status={statusKind} role="status" aria-live="polite">
        {statusBlock}
      </div>

      <label className="powerplay-toggle">
        <input type="checkbox" checked={visible} onChange={(event) => setVisible(event.target.checked)} />
        Показывать на карте
        {loaded && <span className="powerplay-toggle-count">{formatCount(visibleSystems.length)}</span>}
      </label>

      {/* ── Фильтр по державам: всегда виден, работает и до загрузки ── */}
      <div className="powerplay-filter" data-powerplay-filter="">
        <div className="powerplay-group-head">
          <span className="powerplay-group-title">Державы · показано {shownPowers} из {filterPowers.length}</span>
          <span className="powerplay-group-actions">
            <button type="button" className="atlas-link-btn" onClick={() => setFilter(showAllPowers(filter))} disabled={filter.hiddenPowers.length === 0}>
              все
            </button>
            <button type="button" className="atlas-link-btn" onClick={() => setFilter(hideAllPowers(filter, filterPowers))} disabled={shownPowers === 0}>
              ни одной
            </button>
          </span>
        </div>
        <div className="powerplay-allegiances" role="group" aria-label="Фракции держав">
          {ALLEGIANCES.map(({ id, Icon }) => {
            const active = isAllegianceSolo(filter, id, filterPowers);
            return (
              <button
                key={id}
                type="button"
                className={`powerplay-allegiance${active ? ' active' : ''}`}
                aria-pressed={active}
                data-allegiance={id}
                title={active ? 'Снова показать все державы' : `Показать только державы: ${POWER_ALLEGIANCE_LABEL[id]}`}
                onClick={() => {
                  const next = active ? showAllPowers(filter) : soloAllegiance(filter, id, filterPowers);
                  setFilter(next);
                  if (!active) focusOverview(filterPowerplaySystems(systems, next));
                }}
              >
                <Icon size={11} /> {POWER_ALLEGIANCE_LABEL[id]}
              </button>
            );
          })}
        </div>
        <ul className="powerplay-powers" aria-label="Державы">
          {counts.powers.map((item) => {
            const info = powerInfo(item.power);
            const on = isPowerVisible(filter, item.power);
            const unknownRow = isUnknownPower(item.power);
            const title = !loaded
              ? info.label
              : unknownRow
                ? `${info.label}: ${formatCount(item.total)} систем — EDSM перечисляет у них несколько держав и не говорит, какая владелец`
                : `${info.label}: ${formatCount(item.total)} систем`
                  + (item.contested > 0 ? `; ещё в ${formatCount(item.contested)} системах владелец не определён, и эта держава — среди претендентов` : '');
            return (
              <li key={item.power} className={`powerplay-power${on ? '' : ' off'}${unknownRow ? ' unknown' : ''}`} data-power={item.power}>
                <label className="powerplay-power-main" title={title}>
                  <input type="checkbox" checked={on} onChange={() => setFilter(togglePowerVisible(filter, item.power))} />
                  <PowerSwatch color={info.color} />
                  <span className="powerplay-power-name">{info.label}</span>
                  {info.allegiance && <span className="powerplay-power-allegiance">{POWER_ALLEGIANCE_LABEL[info.allegiance]}</span>}
                </label>
                {loaded ? (
                  <span className="powerplay-power-counts" aria-label={`Оплоты ${item.states.Stronghold}, укреплённые ${item.states.Fortified}, эксплуатируемые ${item.states.Exploited}`}>
                    <span title="Оплоты"><PowerplayGlyph state="Stronghold" color={info.color} size={9} /> {formatCount(item.states.Stronghold)}</span>
                    <span title="Укреплённые"><PowerplayGlyph state="Fortified" color={info.color} size={9} /> {formatCount(item.states.Fortified)}</span>
                    <span title="Эксплуатируемые"><PowerplayGlyph state="Exploited" color={info.color} size={9} /> {formatCount(item.states.Exploited)}</span>
                    {item.contested > 0 && (
                      <span className="powerplay-power-contested" title={`Ещё в ${formatCount(item.contested)} системах владелец не определён, и ${info.label} — среди претендентов`} data-powerplay-contested={item.contested}>
                        +{formatCount(item.contested)}?
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="powerplay-power-counts" aria-hidden="true">—</span>
                )}
                <button
                  type="button"
                  className="powerplay-solo"
                  title={`Показать только ${info.label} и подвести к ней камеру`}
                  onClick={() => {
                    const next = soloPower(filter, item.power, filterPowers);
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
      </div>

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
              {loaded && <span className="powerplay-chip-count">{formatCount(counts.states[state])}</span>}
            </button>
          );
        })}
      </div>

      {loaded && (
        <>
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
            <div className="powerplay-hint">Системы кликабельны: щёлкните точку на карте или строку списка — откроется карточка системы.</div>
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
                    title="Показать на карте и открыть карточку"
                  >
                    <PowerplayGlyph state={system.state} color={info.color} size={12} />
                    <span className="powerplay-row-name">{system.name}</span>
                    <span className="powerplay-row-meta">{info.label} · {POWERPLAY_STATE_LABEL[system.state].toLowerCase()}</span>
                  </button>
                </li>
              );
            })}
            {listed.length === 0 && (
              <li className="powerplay-empty">
                {query ? 'Под поиск ничего не нашлось' : shownPowers === 0 ? 'Все державы скрыты — отметьте хотя бы одну' : 'Под фильтр систем нет'}
              </li>
            )}
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
                    <span style={{ color: powerInfo(check.controlled.power).color, fontWeight: 600 }}>
                      {isUnknownPower(check.controlled.power) ? 'держава не определена' : powerInfo(check.controlled.power).label}
                    </span>
                    {' · '}{POWERPLAY_STATE_LABEL[check.controlled.state].toLowerCase()}
                    {isUnknownPower(check.controlled.power) && (check.controlled.candidates ?? []).length > 0 && (
                      <span style={{ color: MUTED }}>
                        {' '}— одна из: {(check.controlled.candidates ?? []).map((candidate) => powerInfo(candidate).label).join(', ')}
                      </span>
                    )}
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
                              {' '}— {POWERPLAY_STATE_LABEL[item.nearest.state].toLowerCase()}{' '}
                              <button
                                type="button"
                                className="powerplay-system-link"
                                data-powerplay-link={item.nearest.name}
                                title="Показать эту систему на карте"
                                onClick={() => showSystem({ id64: item.nearest.id64, name: item.nearest.name })}
                              >
                                {item.nearest.name}
                              </button>
                              , {formatLy(item.nearest.distance)}
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
    </div>
  );
}

export default AtlasPowerplayPanel;
