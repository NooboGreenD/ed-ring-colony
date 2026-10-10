'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IconAnchor, IconChevronLeft, IconChevronRight, IconClock, IconCopy, IconCpu, IconDatabase,
  IconDownload, IconEdit, IconExternalLink, IconLayers, IconPlus, IconRefresh, IconSearch,
  IconShield, IconTrash, IconX,
} from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';
import type { Bulkhead, OutfittingModule } from '@/lib/outfitting/types';
import {
  CATALOG_CATEGORIES, changeId, groupDeletionReason, type CatalogCommand,
  type CatalogGroup, type CatalogKind, type CatalogSnapshot, type CatalogValue,
} from '@/lib/outfitting/catalog';
import { publishOutfittingData } from '@/lib/outfitting/useOutfittingData';
import { bulkheadName } from '@/lib/outfitting/i18n';
import { num } from '@/components/Outfitting/styles';
import OutfittingEditor, { type CatalogEditorItem } from './OutfittingEditor';
import OutfittingDialog from './OutfittingDialog';
import styles from './OutfittingAdmin.module.css';

type View = 'module' | 'group' | 'bulkhead' | 'history';
type RowStatus = 'source' | 'modified' | 'custom' | 'deleted';
interface CatalogRow {
  kind: CatalogKind;
  key: string;
  value: CatalogValue;
  owner: string;
  status: RowStatus;
  change?: CatalogSnapshot['changes'][number];
}
interface Confirmation {
  title: string;
  text: string;
  label: string;
  commands: CatalogCommand[];
  danger?: boolean;
}
const STATUS_LABELS: Record<RowStatus, string> = { source: 'Игровой', modified: 'Изменён', custom: 'Добавлен', deleted: 'Удалён' };
const ACTION_LABELS = { create: 'Добавление', update: 'Редактирование', delete: 'Удаление', restore: 'Восстановление', reset: 'Сброс к исходному' };

async function requestSnapshot(init?: RequestInit): Promise<CatalogSnapshot> {
  const response = await authFetch('/api/admin/outfitting', { cache: 'no-store', ...init });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || `Ошибка API (${response.status})`) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  if (!result.data?.modules || !Array.isArray(result.changes)) throw new Error('Сервер вернул некорректный каталог');
  return result;
}

function rowsOf(snapshot: CatalogSnapshot, view: CatalogKind): CatalogRow[] {
  const changes = new Map(snapshot.changes.map((change) => [changeId(change.kind, change.key), change]));
  const rows: CatalogRow[] = [];
  const append = (key: string, owner: string, value: CatalogValue) => {
    const change = changes.get(changeId(view, key));
    if (change?.deleted) return;
    rows.push({ kind: view, key, owner, value, change, status: !change ? 'source' : change.fromSource ? 'modified' : 'custom' });
  };
  if (view === 'module') for (const [group, modules] of Object.entries(snapshot.data.modules)) {
    modules.forEach((module) => append(`${group}:${module.id}`, group, module));
  }
  if (view === 'group') for (const [key, value] of Object.entries(snapshot.data.groups)) append(key, key, value);
  if (view === 'bulkhead') for (const ship of Object.values(snapshot.data.ships)) {
    ship.bulkheads.forEach((bulkhead) => append(`${ship.id}:${bulkhead.id}`, ship.id, bulkhead));
  }
  for (const change of snapshot.changes) if (change.kind === view && change.deleted) {
    rows.push({ kind: view, key: change.key, owner: view === 'group' ? change.key : change.key.split(':')[0], value: change.value, change, status: 'deleted' });
  }
  return rows;
}

export default function OutfittingAdmin() {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<View>('module');
  const [category, setCategory] = useState('all');
  const [group, setGroup] = useState('all');
  const [ship, setShip] = useState('all');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('all');
  const [rating, setRating] = useState('all');
  const [status, setStatus] = useState('active');
  const [sort, setSort] = useState('group');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<CatalogEditorItem | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmationError, setConfirmationError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true); setError('');
    try { setSnapshot(await requestSnapshot()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось загрузить каталог'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    requestSnapshot({ signal: controller.signal }).then(setSnapshot).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить каталог');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => { setPage(1); setSelected(new Set()); }, [view, category, group, ship, query, level, rating, status, pageSize]);

  const data = snapshot?.data;
  const rows = useMemo(() => snapshot && view !== 'history' ? rowsOf(snapshot, view) : [], [snapshot, view]);
  const rowName = useCallback((row: CatalogRow) => {
    if (row.kind === 'bulkhead') return bulkheadName('ru', (row.value as Bulkhead).name);
    return (row.value as OutfittingModule).name || data?.groups[row.owner]?.name || row.key;
  }, [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('ru');
    const result = rows.filter((row) => {
      const value = row.value as OutfittingModule;
      const rowCategory = row.kind === 'group' ? (row.value as CatalogGroup).category : data?.groups[row.owner]?.category;
      if (view !== 'bulkhead' && category !== 'all' && rowCategory !== category) return false;
      if (view === 'module' && group !== 'all' && row.owner !== group) return false;
      if (view === 'bulkhead' && ship !== 'all' && row.owner !== ship) return false;
      if (view === 'module' && level !== 'all' && value.class !== Number(level)) return false;
      if (view === 'module' && rating !== 'all' && value.rating !== rating) return false;
      if (status === 'active' ? row.status === 'deleted' : status !== 'all' && row.status !== status) return false;
      return !q || [rowName(row), row.key, data?.groups[row.owner]?.name, data?.ships[row.owner]?.properties.name, value.pp, value.info].join(' ').toLocaleLowerCase('ru').includes(q);
    });
    result.sort((a, b) => {
      const av = a.value as OutfittingModule, bv = b.value as OutfittingModule;
      let compared = 0;
      if (sort === 'cost') compared = Number(av.cost ?? 0) - Number(bv.cost ?? 0);
      else if (sort === 'class') compared = Number(av.class ?? 0) - Number(bv.class ?? 0);
      else if (sort === 'name') compared = rowName(a).localeCompare(rowName(b), 'ru');
      else compared = (data?.groups[a.owner]?.name || data?.ships[a.owner]?.properties.name || a.owner)
        .localeCompare(data?.groups[b.owner]?.name || data?.ships[b.owner]?.properties.name || b.owner, 'ru')
        || Number(av.class ?? 0) - Number(bv.class ?? 0);
      return (compared || a.key.localeCompare(b.key)) * (direction === 'asc' ? 1 : -1);
    });
    return result;
  }, [rows, query, category, data, view, group, ship, level, rating, status, rowName, sort, direction]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const deletionReason = (row: CatalogRow): string | null => {
    if (!data) return 'Каталог ещё не загружен';
    if (row.kind === 'group') return groupDeletionReason(data, row.key);
    if (row.kind === 'bulkhead' && data.ships[row.owner]?.bulkheads[0]?.id === (row.value as Bulkhead).id) return 'Базовую броню корабля удалять нельзя';
    return null;
  };
  const canWrite = !!snapshot && snapshot.storage !== 'source';
  const selectable = paged.filter((row) => row.status !== 'deleted' && !deletionReason(row));
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(row.key));

  const mutate = async (commands: CatalogCommand[], message = 'Изменения сохранены и доступны в верфи') => {
    if (!snapshot) throw new Error('Каталог ещё не загружен');
    setSaving(true); setError(''); setNotice('');
    try {
      const next = await requestSnapshot({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: snapshot.revision, commands }) });
      setSnapshot(next); setSelected(new Set()); publishOutfittingData(next.data); setNotice(message);
    } catch (reason) {
      if ((reason as Error & { status?: number }).status === 409) {
        // Preserve the form's draft while refreshing the optimistic revision.
        try { setSnapshot(await requestSnapshot()); } catch { /* Original error remains visible. */ }
      }
      throw reason;
    } finally { setSaving(false); }
  };
  const ask = (next: Confirmation) => { setConfirmationError(''); setConfirmation(next); };
  const remove = (list: CatalogRow[]) => ask({
    title: list.length === 1 ? `Удалить «${rowName(list[0])}»?` : `Удалить записи (${list.length})?`,
    text: 'Записи исчезнут из списка установки в верфи. Они останутся в архиве: их можно восстановить через фильтр «Удалённые». Коды сохранённых сборок не удаляются. У брони сохраняется её индекс и параметры в старых сборках.',
    label: 'Удалить', danger: true,
    commands: list.map((row) => ({ action: 'delete', kind: row.kind, key: row.key })),
  });
  const restore = (row: CatalogRow, reset = false) => ask({
    title: reset ? 'Вернуть исходные параметры?' : `Восстановить «${rowName(row)}»?`,
    text: reset ? 'Ручные правки этой записи будут отменены. Будут использованы параметры из текущего игрового справочника.' : 'Запись снова станет доступна в верфи с параметрами, которые были у неё перед удалением.',
    label: reset ? 'Сбросить к исходному' : 'Восстановить',
    commands: [{ action: reset ? 'reset' : 'restore', kind: row.kind, key: row.key }],
  });
  const create = (copy?: CatalogRow) => {
    if (!data || view === 'history') return;
    const kind = copy?.kind ?? view;
    const id = `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const owner = copy?.owner ?? (kind === 'bulkhead' ? (ship === 'all' ? 'sidewinder' : ship) : (group === 'all' ? (category === 'all' ? 'pp' : Object.keys(data.groups).find((key) => data.groups[key].category === category) ?? 'pp') : group));
    let value: CatalogValue;
    let key = `${owner}:${id}`;
    if (copy) {
      value = { ...structuredClone(copy.value), name: `${rowName(copy)} — копия` };
      if (kind === 'group') { key = id; if ((value as CatalogGroup).category === 'core') (value as CatalogGroup).category = 'internal'; }
      else Object.assign(value, { id });
    } else if (kind === 'group') { key = id; value = { name: '', category: category === 'all' || category === 'core' ? 'internal' : category as CatalogGroup['category'] }; }
    else if (kind === 'bulkhead') value = { id, grp: 'bh', name: '', mass: 0, cost: 0, hullboost: 0.8, kinres: 0, thermres: 0, explres: 0, causres: 0 };
    else value = { id, grp: owner, name: '', class: data.groups[owner]?.category === 'utility' ? 0 : 1, rating: 'A', mass: 0, cost: 0, power: 0, integrity: 0 };
    setEditor({ kind, key, value, mode: 'create' });
  };
  const exportCatalog = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `outfitting-catalog-r${snapshot?.revision}.json`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const clearFilters = () => { setQuery(''); setCategory('all'); setGroup('all'); setShip('all'); setLevel('all'); setRating('all'); setStatus('active'); };
  const changeView = (next: View) => { setView(next); clearFilters(); setSort('group'); };

  const renderActions = (row: CatalogRow) => <div className={styles.rowActions}>
    {row.status === 'deleted' ? <button type="button" disabled={!canWrite || saving} className={styles.restoreButton} onClick={() => restore(row)} aria-label={`Восстановить ${rowName(row)}`}><IconRefresh size={14} color="currentColor" /> Восстановить</button> : <>
      <button type="button" className={styles.editButton} disabled={!canWrite || saving} onClick={() => setEditor({ kind: row.kind, key: row.key, value: row.value, mode: 'update', fromSource: row.status === 'source' || row.change?.fromSource })} aria-label={`Редактировать ${rowName(row)}`}><IconEdit size={14} color="currentColor" /><span>Изменить</span></button>
      <button type="button" className={styles.iconButton} disabled={!canWrite || saving} title="Создать копию" aria-label={`Копировать ${rowName(row)}`} onClick={() => create(row)}><IconCopy size={15} color="currentColor" /></button>
      <button type="button" className={`${styles.iconButton} ${styles.dangerButton}`} disabled={!canWrite || saving || !!deletionReason(row)} title={deletionReason(row) || 'Удалить запись'} aria-label={`Удалить ${rowName(row)}`} onClick={() => remove([row])}><IconTrash size={15} color="currentColor" /></button>
    </>}
    {row.change?.fromSource && <button type="button" className={styles.iconButton} disabled={!canWrite || saving} title="Вернуть исходные параметры" aria-label={`Сбросить изменения ${rowName(row)}`} onClick={() => restore(row, true)}><IconRefresh size={14} color="currentColor" /></button>}
  </div>;
  const statusBadge = (row: CatalogRow) => <span className={`${styles.badge} ${styles[row.status]}`}>{STATUS_LABELS[row.status]}</span>;

  return <section className={styles.root} aria-label="Управление верфью">
    <header className={styles.header}>
      <div className={styles.titleBlock}><span className={styles.sectionIcon}><IconAnchor size={24} color="currentColor" /></span><div><span className={styles.eyebrow}>Каталог оборудования / Shipyard</span><h2>Управление верфью</h2><p>Модули, группы и броня кораблей. Все изменения применяются к конструктору сборок.</p></div></div>
      <a className={styles.secondaryButton} href="/outfitting" target="_blank" rel="noopener noreferrer"><IconExternalLink size={15} color="currentColor" /> Открыть верфь</a>
    </header>
    {snapshot && <>
      <div className={styles.stats}>
        {[
          { label: 'Модули', value: Object.values(snapshot.data.modules).reduce((sum, list) => sum + list.length, 0), icon: IconCpu },
          { label: 'Группы', value: Object.keys(snapshot.data.groups).length, icon: IconLayers },
          { label: 'Броня кораблей', value: Object.values(snapshot.data.ships).reduce((sum, item) => sum + item.bulkheads.filter((entry) => !entry.archived).length, 0), icon: IconShield },
          { label: 'Ручные правки', value: snapshot.changes.length, icon: IconEdit },
        ].map((stat) => <div key={stat.label} className={styles.stat}><stat.icon size={18} color="currentColor" /><strong>{stat.value.toLocaleString('ru-RU')}</strong><span>{stat.label}</span></div>)}
      </div>
      <div className={styles.meta}><span><IconDatabase size={13} color="currentColor" /> {snapshot.storage === 'local' ? 'Локальный режим — изменения только в этом окружении' : snapshot.storage === 'source' ? 'Исходный справочник — сохранение не настроено' : 'Supabase / постоянное хранилище'}</span><span>Ревизия {snapshot.revision} · {snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleString('ru-RU') : 'Без ручных изменений'}</span></div>
      {snapshot.storage === 'source' && <div className={styles.warning}>Для сохранения настройте SUPABASE_SERVICE_ROLE_KEY и примените миграцию 20261010010000_outfitting_catalog.sql. Исходный справочник доступен для просмотра.</div>}
    </>}
    {error && <div role="alert" className={styles.errorBanner}>{error}<button type="button" className={styles.secondaryButton} onClick={() => void refresh()} disabled={loading}>Повторить</button></div>}
    {notice && <div role="status" className={styles.successBanner}><span>{notice}</span><button type="button" className={styles.iconButton} aria-label="Скрыть уведомление" onClick={() => setNotice('')}><IconX size={14} color="currentColor" /></button></div>}
    <div className={styles.toolbar}>
      <div className={styles.viewTabs} role="tablist" aria-label="Каталоги верфи">
        {([{ key: 'module', label: 'Модули', icon: IconCpu }, { key: 'group', label: 'Группы', icon: IconLayers }, { key: 'bulkhead', label: 'Броня', icon: IconShield }, { key: 'history', label: 'Журнал', icon: IconClock }] as const).map((item) =>
          <button key={item.key} type="button" role="tab" aria-selected={view === item.key} aria-controls="shipyard-catalog-panel" className={view === item.key ? styles.activeTab : styles.tabButton} onClick={() => changeView(item.key)}><item.icon size={15} color="currentColor" />{item.label}</button>)}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.iconButton} disabled={loading || saving} onClick={() => void refresh()} title="Обновить каталог" aria-label="Обновить каталог"><IconRefresh size={16} color="currentColor" /></button>
        <button type="button" className={styles.secondaryButton} onClick={exportCatalog} disabled={!snapshot || loading} title="Скачать полный справочник с текущими изменениями"><IconDownload size={15} color="currentColor" /> Экспорт JSON</button>
        {view !== 'history' && <button type="button" className={styles.primaryButton} disabled={!canWrite || loading || saving} onClick={() => create()}><IconPlus size={16} color="currentColor" />{view === 'module' ? 'Добавить модуль' : view === 'group' ? 'Добавить группу' : 'Добавить броню'}</button>}
      </div>
    </div>
    {loading && !snapshot ? <div className={styles.empty} role="status">Загрузка каталога верфи…</div> : snapshot && <div id="shipyard-catalog-panel" role="tabpanel" aria-label={view === 'history' ? 'Журнал изменений' : 'Каталог'}>
      {view === 'history' ? <>
        <div className={styles.panelHeading}><h3>Журнал изменений</h3><span>Последние 100 операций</span></div>
        {snapshot.history.length ? <div className={styles.tableContainer}><table className={styles.table}><thead><tr><th>Дата / администратор</th><th>Действие</th><th>Запись</th></tr></thead><tbody>
          {snapshot.history.map((entry, index) => <tr key={`${entry.at}-${index}`}><td data-label="Дата / администратор"><span>{new Date(entry.at).toLocaleString('ru-RU')}</span><small>{entry.actor}</small></td><td data-label="Действие">{ACTION_LABELS[entry.action]}</td><td data-label="Запись">{entry.label}<small>{entry.kind} / {entry.key}</small></td></tr>)}
        </tbody></table></div> : <div className={styles.empty}><IconClock size={28} color="currentColor" /><h3>Журнал пока пуст</h3><p>Добавления, изменения, удаления и восстановления будут показаны здесь.</p></div>}
      </> : <>
        {view !== 'bulkhead' && <div className={styles.categoryBar} aria-label="Категории модулей">
          <button type="button" aria-pressed={category === 'all'} className={category === 'all' ? styles.activeCategory : styles.categoryButton} onClick={() => { setCategory('all'); setGroup('all'); }}>Все категории<span>{rows.filter((row) => row.status !== 'deleted').length}</span></button>
          {Object.entries(CATALOG_CATEGORIES).map(([key, label]) => <button key={key} type="button" aria-pressed={category === key} className={category === key ? styles.activeCategory : styles.categoryButton} onClick={() => { setCategory(key); setGroup('all'); }}>{label}<span>{rows.filter((row) => row.status !== 'deleted' && (view === 'group' ? (row.value as CatalogGroup).category : data?.groups[row.owner]?.category) === key).length}</span></button>)}
        </div>}
        <div className={styles.filters}>
          <label className={`${styles.field} ${styles.searchField}`}><span>Поиск</span><div className={styles.searchControl}><IconSearch size={16} color="currentColor" /><input type="search" placeholder="Название, ID, группа…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Поиск по каталогу" /></div></label>
          {view === 'module' && <label className={styles.field}><span>Группа</span><select aria-label="Фильтр группы" value={group} onChange={(event) => setGroup(event.target.value)}><option value="all">Все группы</option>{Object.entries(snapshot.data.groups).filter(([, meta]) => category === 'all' || meta.category === category).sort(([, a], [, b]) => a.name.localeCompare(b.name, 'ru')).map(([key, meta]) => <option key={key} value={key}>{meta.name}</option>)}</select></label>}
          {view === 'bulkhead' && <label className={styles.field}><span>Корабль</span><select aria-label="Фильтр корабля" value={ship} onChange={(event) => setShip(event.target.value)}><option value="all">Все корабли</option>{Object.values(snapshot.data.ships).sort((a, b) => a.properties.name.localeCompare(b.properties.name)).map((item) => <option key={item.id} value={item.id}>{item.properties.name}</option>)}</select></label>}
          {view === 'module' && <><label className={styles.field}><span>Класс</span><select aria-label="Фильтр класса" value={level} onChange={(event) => setLevel(event.target.value)}><option value="all">Все</option>{Array.from({ length: 9 }, (_, index) => <option key={index} value={index}>{index}</option>)}</select></label>
            <label className={styles.field}><span>Рейтинг</span><select aria-label="Фильтр рейтинга" value={rating} onChange={(event) => setRating(event.target.value)}><option value="all">Все</option>{Array.from(new Set(rows.map((row) => (row.value as OutfittingModule).rating))).sort().map((key) => <option key={key}>{key}</option>)}</select></label></>}
          <label className={styles.field}><span>Состояние</span><select aria-label="Фильтр состояния" value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">Доступные</option><option value="all">Все, включая удалённые</option><option value="source">Без изменений</option><option value="modified">Изменённые</option><option value="custom">Добавленные</option><option value="deleted">Удалённые</option></select></label>
        </div>
        <div className={styles.listToolbar}>
          <span className={styles.resultCount}>Найдено <strong>{filtered.length.toLocaleString('ru-RU')}</strong> / {rows.length.toLocaleString('ru-RU')}</span>
          {view !== 'group' && <label className={styles.mobileSelectAll}><input type="checkbox" aria-label="Выбрать все записи на странице" checked={allSelected} disabled={!canWrite || selectable.length === 0} onChange={(event) => setSelected((previous) => { const next = new Set(previous); selectable.forEach((row) => event.target.checked ? next.add(row.key) : next.delete(row.key)); return next; })} /> Выбрать страницу</label>}
          <div className={styles.sortActions}><label>Сортировка<select aria-label="Сортировка" value={sort} onChange={(event) => setSort(event.target.value)}><option value="group">{view === 'bulkhead' ? 'По кораблю' : 'По группе'}</option><option value="name">По названию</option>{view !== 'group' && <option value="cost">По цене</option>}{view === 'module' && <option value="class">По классу</option>}</select></label><button type="button" className={styles.iconButton} title={direction === 'asc' ? 'По возрастанию' : 'По убыванию'} aria-label="Изменить направление сортировки" onClick={() => setDirection(direction === 'asc' ? 'desc' : 'asc')}>{direction === 'asc' ? '↑' : '↓'}</button>
            <button type="button" className={styles.quietButton} onClick={clearFilters}>Сбросить фильтры</button></div>
        </div>
        {selected.size > 0 && <div className={styles.selectionBar}><span>Выбрано: {selected.size}</span><div className={styles.actions}><button type="button" className={styles.quietButton} onClick={() => setSelected(new Set())}>Снять выбор</button><button type="button" className={styles.dangerButton} disabled={!canWrite || saving || selected.size > 100} onClick={() => remove(rows.filter((row) => selected.has(row.key)))}><IconTrash size={14} color="currentColor" />Удалить выбранные</button></div></div>}
        {filtered.length ? <div className={styles.tableContainer} aria-busy={loading || saving}>
          <table className={styles.table}><thead><tr>
            {view !== 'group' && <th className={styles.selectionCell}><input type="checkbox" aria-label="Выбрать записи на странице" checked={allSelected} disabled={!canWrite || selectable.length === 0} onChange={(event) => setSelected((previous) => { const next = new Set(previous); selectable.forEach((row) => event.target.checked ? next.add(row.key) : next.delete(row.key)); return next; })} /></th>}
            <th>{view === 'module' ? 'Модуль' : view === 'group' ? 'Группа' : 'Броня'}</th><th>{view === 'bulkhead' ? 'Корабль' : 'Категория / группа'}</th>
            {view === 'group' ? <th>Модулей</th> : <><th className={styles.numberCell}>Масса, т</th>{view === 'module' && <th className={styles.numberCell}>Энергия, МВт</th>}<th className={styles.numberCell}>Цена, CR</th></>}
            <th>Состояние</th><th className={styles.actionHeading}>Действия</th>
          </tr></thead><tbody>{paged.map((row) => {
            const value = row.value as OutfittingModule;
            return <tr key={row.key} className={`${selected.has(row.key) ? styles.selectedRow : ''} ${row.status === 'deleted' ? styles.deletedRow : ''}`}>
              {view !== 'group' && <td className={styles.selectionCell}><input type="checkbox" aria-label={`Выбрать ${row.key}`} checked={selected.has(row.key)} disabled={!canWrite || row.status === 'deleted' || !!deletionReason(row)} onChange={(event) => setSelected((previous) => { const next = new Set(previous); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; })} /></td>}
              <td className={styles.nameCell} data-label="Запись"><div className={styles.moduleName}>{view === 'module' && <span className={styles.classBadge}>{value.class}{value.rating}</span>}<span>{rowName(row)}</span></div><small>{row.key}{value.mount ? ` · ${value.mount === 'F' ? 'Фикс.' : value.mount === 'G' ? 'Турель' : 'Навод.'}` : ''}{value.preEngineered ? ' · Pre-eng' : ''}{value.merc ? ' · Merc Coin' : ''}</small></td>
              <td data-label={view === 'bulkhead' ? 'Корабль' : 'Категория / группа'}>{view === 'bulkhead' ? data?.ships[row.owner]?.properties.name ?? row.owner : view === 'group' ? CATALOG_CATEGORIES[(row.value as CatalogGroup).category] : data?.groups[row.owner]?.name ?? row.owner}{view === 'module' && <small>{CATALOG_CATEGORIES[data!.groups[row.owner]?.category] ?? 'Архив группы'}</small>}</td>
              {view === 'group' ? <td className={styles.numberCell} data-label="Модулей">{data?.modules[row.key]?.length ?? 0}</td> : <><td className={styles.numberCell} data-label="Масса, т">{typeof value.mass === 'number' ? num(value.mass, 2) : '—'}</td>{view === 'module' && <td className={styles.numberCell} data-label="Энергия, МВт">{typeof value.power === 'number' ? num(value.power, 2) : '—'}</td>}<td className={styles.numberCell} data-label="Цена, CR">{typeof value.cost === 'number' ? num(value.cost, 0) : '—'}</td></>}
              <td data-label="Состояние">{statusBadge(row)}</td><td className={styles.actionCell}>{renderActions(row)}</td>
            </tr>;
          })}</tbody></table>
        </div> : <div className={styles.empty}><IconSearch size={28} color="currentColor" /><h3>Записей не найдено</h3><p>Попробуйте другой запрос или сбросьте фильтры.</p><button type="button" className={styles.secondaryButton} onClick={clearFilters}>Сбросить фильтры</button></div>}
        <footer className={styles.pagination}>
          <label>Строк на странице<select aria-label="Строк на странице" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[25, 50, 100].map((size) => <option key={size}>{size}</option>)}</select></label>
          <div className={styles.actions}><span>{filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filtered.length)} из {filtered.length}</span><button type="button" className={styles.iconButton} disabled={currentPage === 1} aria-label="Предыдущая страница" onClick={() => { setPage(currentPage - 1); setSelected(new Set()); }}><IconChevronLeft size={16} color="currentColor" /></button><span>{currentPage} / {pages}</span><button type="button" className={styles.iconButton} disabled={currentPage === pages} aria-label="Следующая страница" onClick={() => { setPage(currentPage + 1); setSelected(new Set()); }}><IconChevronRight size={16} color="currentColor" /></button></div>
        </footer>
      </>}
    </div>}
    <p className={styles.sourceNote}>Источник: {snapshot?.data.source ?? 'EDCD/coriolis-data'}. Правки хранятся отдельно от игровых данных; обновление исходного справочника их не перезаписывает.</p>
    {editor && data && <OutfittingEditor key={`${editor.kind}/${editor.key}/${editor.mode}`} item={editor} data={data} onClose={() => setEditor(null)} onSave={async (key, value) => {
      await mutate([{ action: editor.mode, kind: editor.kind, key, value }]);
      setEditor(null); clearFilters(); setQuery(key); setPage(1);
    }} />}
    {confirmation && <OutfittingDialog title={confirmation.title} eyebrow="Подтверждение действия" compact busy={saving} onClose={() => { if (!saving) setConfirmation(null); }}>
      <div className={styles.confirmationBody}><p>{confirmation.text}</p>{confirmation.commands.length > 1 && <ul>{confirmation.commands.map((command) => <li key={command.key}>{command.key}</li>)}</ul>}{confirmationError && <div role="alert" className={styles.formError}>{confirmationError}</div>}</div>
      <footer className={styles.dialogFooter}><div className={styles.actions}><button type="button" disabled={saving} className={styles.secondaryButton} onClick={() => setConfirmation(null)}>Отмена</button><button type="button" disabled={saving} className={confirmation.danger ? styles.dangerButton : styles.primaryButton} onClick={async () => {
        setConfirmationError('');
        try { await mutate(confirmation.commands); setConfirmation(null); }
        catch (reason) { setConfirmationError(reason instanceof Error ? reason.message : 'Операция не выполнена'); }
      }}>{saving ? 'Выполнение…' : confirmation.label}</button></div></footer>
    </OutfittingDialog>}
  </section>;
}
