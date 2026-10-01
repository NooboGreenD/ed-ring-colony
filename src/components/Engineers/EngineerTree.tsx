'use client';

/**
 * Вертикальное дерево инженеров. Карточки можно раскрывать, искать и отмечать
 * как открытые; прогресс сохраняется в localStorage.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ENGINEERS,
  ENGINEER_BY_ID,
  childrenOf,
  lookupNames,
  pathTo,
  resolveEngineer,
  rootsOf,
  type Engineer,
  type EngineerBranch,
} from '@/lib/engineers/data';
import { blueprintLabel } from '@/lib/outfitting/build';
import { groupName as localizedGroupName } from '@/lib/outfitting/i18n';
import { engineerSearchText, engineerSkills, engineerText } from '@/lib/engineers/i18n';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useOutfittingData } from '@/lib/outfitting/useOutfittingData';
import { LABEL, MONO, PANEL, button } from '@/components/Outfitting/styles';

const STORE_KEY = 'ed-ring-colony:engineers:unlocked';

interface UpgradeRow {
  group: string;
  groupName: string;
  blueprints: { id: string; label: string; grade: number }[];
}

function useUpgrades(engineer: Engineer | null): UpgradeRow[] {
  const { data } = useOutfittingData();
  // Названия групп и чертежей общие с верфью — показываем их на том же языке.
  const { locale } = useI18n();
  return useMemo(() => {
    if (!data || !engineer) return [];
    const merged: Record<string, number> = {};
    for (const name of lookupNames(engineer)) {
      for (const [key, grade] of Object.entries(data.engineers[name] ?? {})) {
        merged[key] = Math.max(merged[key] ?? 0, grade);
      }
    }
    const rows = new Map<string, UpgradeRow>();
    for (const [key, grade] of Object.entries(merged)) {
      const [group, blueprint] = key.split(':');
      if (!rows.has(group)) {
        rows.set(group, {
          group,
          groupName: localizedGroupName(locale, group, data.groups[group]?.name ?? group.toUpperCase()),
          blueprints: [],
        });
      }
      rows.get(group)!.blueprints.push({ id: blueprint, label: blueprintLabel(blueprint, locale), grade });
    }
    for (const row of rows.values()) {
      row.blueprints.sort((left, right) => right.grade - left.grade || left.label.localeCompare(right.label));
    }
    return [...rows.values()].sort((left, right) => left.groupName.localeCompare(right.groupName));
  }, [data, engineer, locale]);
}

function engineerMatches(engineer: Engineer, query: string, locale: string) {
  if (!query) return true;
  // Ищем и по переводу, и по русскому оригиналу: ссылки и заметки командиров
  // ходят по эскадрилье на разных языках.
  return engineerSearchText(locale, engineer).toLocaleLowerCase(locale).includes(query);
}

function subtreeMatches(engineer: Engineer, branch: EngineerBranch, query: string, hideColonia: boolean, locale: string): boolean {
  if (hideColonia && engineer.colonia) return false;
  if (engineerMatches(engineer, query, locale)) return true;
  return childrenOf(engineer.id, branch)
    .filter((child) => child.from[0] === engineer.id)
    .some((child) => subtreeMatches(child, branch, query, hideColonia, locale));
}

function Card({
  engineer, selected, unlocked, available, childCount, collapsed, onSelect, onToggle, onCollapse,
}: {
  engineer: Engineer;
  selected: boolean;
  unlocked: boolean;
  available: boolean;
  childCount: number;
  collapsed: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onCollapse: () => void;
}) {
  const { t, locale } = useI18n();
  const focus = engineerText(locale, engineer, 'focus');
  const accent = unlocked ? 'var(--green)' : available ? 'var(--orange)' : 'var(--line)';
  return (
    <div
      className="eng-card"
      data-selected={selected || undefined}
      style={{
        borderColor: selected ? 'var(--cyan)' : accent,
        background: selected ? 'rgba(52,152,219,0.10)' : 'var(--panel)',
        boxShadow: selected ? '0 0 0 1px var(--cyan)' : undefined,
        opacity: unlocked || available ? 1 : 0.78,
      }}
    >
      {childCount > 0 && (
        <button
          type="button"
          onClick={onCollapse}
          className="eng-card-collapse"
          aria-label={t(collapsed ? 'engineers.card.showBranch' : 'engineers.card.hideBranch', { name: engineer.name })}
          aria-expanded={!collapsed}
          title={collapsed ? t('engineers.card.showChildren', { count: childCount }) : t('engineers.card.collapseBranch')}
        >
          <span className={collapsed ? '' : 'open'}>›</span>
        </button>
      )}
      <button type="button" onClick={onSelect} className="eng-card-main" aria-pressed={selected}>
        <span className="eng-card-heading">
          <span className="eng-card-name" style={{ color: unlocked ? 'var(--green)' : 'var(--text)' }}>{engineer.name}</span>
          <span className={`eng-status ${unlocked ? 'done' : available ? 'available' : ''}`}>
            {t(unlocked ? 'engineers.status.unlocked' : available ? 'engineers.status.available' : 'engineers.status.locked')}
          </span>
        </span>
        <span className="eng-card-sub">
          {engineer.system}
          {engineer.permit ? ` · ${t('engineers.card.permit')}` : ''}
          {engineer.colonia ? ` · ${t('engineers.card.colonia')}` : ''}
        </span>
        <span className="eng-card-focus" title={focus}>{focus}</span>
      </button>
      <button
        type="button"
        onClick={onToggle}
        className="eng-card-mark"
        aria-label={t(unlocked ? 'engineers.card.markLocked' : 'engineers.card.markUnlocked', { name: engineer.name })}
        title={t(unlocked ? 'engineers.card.markLockedShort' : 'engineers.card.markUnlockedShort')}
        style={{ color: unlocked ? 'var(--green)' : 'var(--muted)', borderColor: unlocked ? 'var(--green)' : 'var(--line)' }}
      >
        {unlocked ? '✓' : '+'}
      </button>
    </div>
  );
}

function Node(props: {
  engineer: Engineer;
  branch: EngineerBranch;
  selected: string | null;
  unlocked: Set<string>;
  collapsed: Set<string>;
  query: string;
  hideColonia: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onCollapse: (id: string) => void;
}) {
  const { locale } = useI18n();
  const { engineer, branch, selected, unlocked, collapsed, query, hideColonia, onSelect, onToggle, onCollapse } = props;
  const allChildren = childrenOf(engineer.id, branch)
    .filter((child) => child.from[0] === engineer.id && !(hideColonia && child.colonia));
  const children = query
    ? allChildren.filter((child) => subtreeMatches(child, branch, query, hideColonia, locale))
    : allChildren;
  const available = engineer.from.length === 0 || engineer.from.some((parent) => unlocked.has(parent));
  const isCollapsed = !query && collapsed.has(engineer.id);

  return (
    <li className="eng-node">
      <Card
        engineer={engineer}
        selected={selected === engineer.id}
        unlocked={unlocked.has(engineer.id)}
        available={available}
        childCount={allChildren.length}
        collapsed={isCollapsed}
        onSelect={() => onSelect(engineer.id)}
        onToggle={() => onToggle(engineer.id)}
        onCollapse={() => onCollapse(engineer.id)}
      />
      {children.length > 0 && !isCollapsed && (
        <ul className="eng-children">
          {children.map((child) => <Node key={child.id} {...props} engineer={child} />)}
        </ul>
      )}
    </li>
  );
}

export default function EngineerTree() {
  const { t, locale } = useI18n();
  const [branch, setBranch] = useState<EngineerBranch>('ship');
  const [selected, setSelected] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hideColonia, setHideColonia] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) setUnlocked(new Set(JSON.parse(raw) as string[]));
    } catch { /* Страница работает и без сохранения отметок. */ }
    const engineer = resolveEngineer(new URLSearchParams(window.location.search).get('engineer'));
    if (engineer) {
      setSelected(engineer.id);
      setBranch(engineer.branch);
    }
  }, []);

  const toggle = useCallback((id: string) => {
    setUnlocked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      window.localStorage.setItem(STORE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const select = useCallback((id: string) => {
    setSelected(id);
    const url = new URL(window.location.href);
    url.searchParams.set('engineer', id);
    window.history.replaceState(null, '', url.toString());
  }, []);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const query = search.trim().toLocaleLowerCase(locale);
  const current = selected ? ENGINEER_BY_ID.get(selected) ?? null : null;
  const upgrades = useUpgrades(current);
  const roots = rootsOf(branch).filter((engineer) => subtreeMatches(engineer, branch, query, hideColonia, locale));
  const branchEngineers = ENGINEERS.filter((engineer) => engineer.branch === branch && !(hideColonia && engineer.colonia));
  const total = branchEngineers.length;
  const done = branchEngineers.filter((engineer) => unlocked.has(engineer.id)).length;
  const progress = total ? Math.round((done / total) * 100) : 0;
  const parents = branchEngineers.filter((engineer) => childrenOf(engineer.id, branch).some((child) => child.from[0] === engineer.id));

  const changeBranch = (next: EngineerBranch) => {
    setBranch(next);
    setSearch('');
    setSelected(null);
  };

  return (
    <>
      <style>{treeCss}</style>

      <section className="eng-toolbar" aria-label={t('engineers.toolbarLabel')}>
        <div className="eng-toolbar-row">
          <div className="eng-segmented" aria-label={t('engineers.branchLabel')}>
            <button type="button" className={branch === 'ship' ? 'active' : ''} onClick={() => changeBranch('ship')}>{t('engineers.branch.ship')}</button>
            <button type="button" className={branch === 'odyssey' ? 'active' : ''} onClick={() => changeBranch('odyssey')}>{t('engineers.branch.odyssey')}</button>
          </div>
          <label className="eng-search">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('engineers.search.placeholder')}
              aria-label={t('engineers.search.label')}
            />
            {search && <button type="button" onClick={() => setSearch('')} aria-label={t('engineers.search.clear')}>×</button>}
          </label>
        </div>
        <div className="eng-toolbar-row eng-toolbar-actions">
          <button type="button" style={button(hideColonia)} onClick={() => setHideColonia((value) => !value)}>
            {t(hideColonia ? 'engineers.colonia.show' : 'engineers.colonia.hide')}
          </button>
          <button type="button" style={button(false)} onClick={() => setCollapsed(new Set())}>{t('engineers.expandAll')}</button>
          <button type="button" style={button(false)} onClick={() => setCollapsed(new Set(parents.map((engineer) => engineer.id)))}>{t('engineers.collapseAll')}</button>
          {done > 0 && (
            <button type="button" style={button(false, 'var(--red)')} onClick={() => {
              setUnlocked(new Set());
              window.localStorage.removeItem(STORE_KEY);
            }}>{t('engineers.resetMarks')}</button>
          )}
          <div className="eng-progress" title={t('engineers.progressTitle', { percent: progress })}>
            <span>{t('engineers.progress', { done, total })}</span>
            <div><i style={{ width: `${progress}%` }} /></div>
          </div>
        </div>
      </section>

      <div className="eng-layout">
        <div className="eng-tree-wrap">
          {roots.length > 0 ? (
            <ul className="eng-roots">
              {roots.map((engineer) => (
                <Node
                  key={engineer.id}
                  engineer={engineer}
                  branch={branch}
                  selected={selected}
                  unlocked={unlocked}
                  collapsed={collapsed}
                  query={query}
                  hideColonia={hideColonia}
                  onSelect={select}
                  onToggle={toggle}
                  onCollapse={toggleCollapse}
                />
              ))}
            </ul>
          ) : (
            <div className="eng-empty">{t('engineers.empty')}</div>
          )}
        </div>

        <aside className="eng-details">
          {!current && (
            <div style={PANEL}>
              <p style={{ ...LABEL, marginTop: 0 }}>{t('engineers.help.title')}</p>
              <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 0 }}>
                {t('engineers.help.text')}
              </p>
            </div>
          )}

          {current && (
            <div style={PANEL}>
              <div className="eng-details-head">
                <h2>{current.name}</h2>
                <button type="button" onClick={() => setSelected(null)} aria-label={t('engineers.details.close')}>×</button>
              </div>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: MONO, margin: '0 0 10px' }}>
                {current.station} · {current.system}
                {current.permit ? ` · ${t('engineers.details.permit')}` : ''}
                {current.colonia ? ` · ${t('engineers.card.colonia')}` : ''}
              </p>

              <Row title={t('engineers.row.discovery')}>{engineerText(locale, current, 'discovery')}</Row>
              {current.meeting && current.meeting !== '—' && (
                <Row title={t('engineers.row.meeting')}>{engineerText(locale, current, 'meeting')}</Row>
              )}
              <Row title={t('engineers.row.unlock')}>{engineerText(locale, current, 'unlock')}</Row>
              {current.referral && <Row title={t('engineers.row.referral')}>{engineerText(locale, current, 'referral')}</Row>}

              {current.from.length > 0 && (
                <Row title={t('engineers.row.prereq')}>
                  {pathTo(current.id).slice(0, -1).map((parent, index, list) => (
                    <span key={parent.id}>
                      <button type="button" onClick={() => select(parent.id)} className="eng-inline-link">{parent.name}</button>
                      {index < list.length - 1 ? ' → ' : ''}
                    </span>
                  ))}
                  {current.from.length > 1 && t('engineers.details.alsoFrom', {
                    names: current.from.slice(1).map((id) => ENGINEER_BY_ID.get(id)?.name ?? id).join(', '),
                  })}
                </Row>
              )}

              <p style={{ ...LABEL, margin: '14px 0 6px', color: 'var(--orange)' }}>{t('engineers.details.upgrades')}</p>
              {current.skills && (
                <ul className="eng-skills">
                  {(engineerSkills(locale, current) ?? []).map((skill) => <li key={skill}>{skill}</li>)}
                </ul>
              )}
              {!current.skills && upgrades.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>{t('engineers.details.loading')}</p>
              )}
              {upgrades.map((row) => (
                <div key={row.group} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--cyan)', fontFamily: MONO, marginBottom: 2 }}>{row.groupName}</div>
                  <div className="eng-blueprints">
                    {row.blueprints.map((blueprint) => (
                      <span
                        key={blueprint.id}
                        title={t('engineers.blueprint.title', { label: blueprint.label, grade: blueprint.grade })}
                        className={blueprint.grade >= 5 ? 'grade-five' : ''}
                      >
                        {blueprint.label} · G{blueprint.grade}
                      </span>
                    ))}
                  </div>
                </div>
              ))}

              {current.branch === 'ship' && <p style={{ marginTop: 12, marginBottom: 0 }}><Link href="/outfitting" style={{ fontSize: 12 }}>{t('engineers.details.buildLink')}</Link></p>}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ marginBottom: 8 }}><div style={LABEL}>{title}</div><div style={{ fontSize: 12, lineHeight: 1.6 }}>{children}</div></div>;
}

const treeCss = `
.eng-toolbar { border: 1px solid var(--line); background: color-mix(in srgb, var(--panel) 80%, transparent); border-radius: 5px; padding: 10px; margin-bottom: 14px; }
.eng-toolbar-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.eng-toolbar-row + .eng-toolbar-row { margin-top: 8px; }
.eng-segmented { display: flex; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.eng-segmented button { border: 0; border-right: 1px solid var(--line); border-radius: 0; margin: 0; padding: 7px 13px; background: transparent; color: var(--muted); }
.eng-segmented button:last-child { border-right: 0; }
.eng-segmented button.active { background: rgba(230,126,34,.13); color: var(--orange); }
.eng-search { flex: 1 1 280px; position: relative; display: flex; align-items: center; border: 1px solid var(--line); border-radius: 3px; padding-left: 9px; color: var(--muted); }
.eng-search:focus-within { border-color: var(--cyan); box-shadow: 0 0 0 1px color-mix(in srgb, var(--cyan) 30%, transparent); }
.eng-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); padding: 7px 8px; font-size: 12px; }
.eng-search button { border: 0; background: none; color: var(--muted); font-size: 18px; padding: 0 9px; margin: 0; }
.eng-progress { min-width: 150px; margin-left: auto; color: var(--muted); font: 10px ${MONO}; text-align: right; }
.eng-progress > div { height: 3px; margin-top: 4px; background: var(--line); overflow: hidden; border-radius: 2px; }
.eng-progress i { display: block; height: 100%; background: var(--green); transition: width .25s ease; }
.eng-layout { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(280px, 340px); gap: 14px; align-items: start; }
.eng-tree-wrap { min-width: 0; }
.eng-roots, .eng-children { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; gap: 7px; }
.eng-roots { padding: 3px; }
.eng-node { position: relative; min-width: 0; }
.eng-children { position: relative; margin: 7px 0 0 20px; padding-left: 20px; }
.eng-children::before { content: ''; position: absolute; top: -7px; bottom: 21px; left: 0; width: 1px; background: var(--orange); opacity: .48; }
.eng-children > .eng-node::before { content: ''; position: absolute; top: 21px; left: -20px; width: 20px; height: 1px; background: var(--orange); opacity: .48; }
.eng-card { position: relative; display: flex; align-items: stretch; width: 100%; min-height: 72px; border: 1px solid var(--line); border-radius: 4px; transition: border-color .15s ease, background .15s ease, transform .15s ease; }
.eng-card:hover { transform: translateX(2px); }
.eng-card-collapse { width: 28px; flex: 0 0 28px; border: 0; border-right: 1px solid var(--line); background: rgba(255,255,255,.018); color: var(--orange); padding: 0; margin: 0; }
.eng-card-collapse span { display: inline-block; font-size: 21px; transition: transform .18s ease; }
.eng-card-collapse span.open { transform: rotate(90deg); }
.eng-card-main { display: flex; flex-direction: column; gap: 3px; align-items: flex-start; text-align: left; flex: 1; min-width: 0; background: none; border: none; cursor: pointer; padding: 8px 10px; color: var(--text); margin: 0; text-transform: none; letter-spacing: 0; }
.eng-card-heading { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.eng-card-name { font-size: 12.5px; font-weight: 600; line-height: 1.25; }
.eng-status { flex: none; padding: 1px 5px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); font: 8px ${MONO}; letter-spacing: .6px; text-transform: uppercase; }
.eng-status.available { color: var(--orange); border-color: color-mix(in srgb, var(--orange) 55%, transparent); }
.eng-status.done { color: var(--green); border-color: color-mix(in srgb, var(--green) 55%, transparent); }
.eng-card-sub { font-size: 10px; color: var(--muted); letter-spacing: 1px; text-transform: uppercase; font-family: ${MONO}; }
.eng-card-focus { font-size: 10.5px; color: var(--muted); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.eng-card-mark { width: 34px; flex: 0 0 34px; background: none; border: none; border-left: 1px solid var(--line); cursor: pointer; font-size: 15px; margin: 0; padding: 0; border-radius: 0; }
.eng-card-mark:hover { background: rgba(255,255,255,.04); }
/* Панель деталей «прилипает» НИЖЕ шапки сайта: .topbar — sticky, 52px,
   z-index 50 (см. globals.css). Раньше top: 12px прятал верх панели под
   шапкой, и при прокрутке карточка инженера «уезжала» под неё. */
.eng-details { min-width: 0; position: sticky; top: 64px; max-height: calc(100vh - 76px); overflow-y: auto; z-index: 1; }
.eng-details-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
.eng-details-head h2 { font-size: 15px; margin: 0 0 2px; }
.eng-details-head button { border: 0; background: none; color: var(--muted); padding: 0 3px; margin: 0; font-size: 18px; }
.eng-inline-link { background: none; border: none; padding: 0; margin: 0; color: var(--cyan); cursor: pointer; font-size: 12px; text-transform: none; letter-spacing: 0; }
.eng-skills { margin: 0; padding-left: 18px; font-size: 12px; line-height: 1.7; }
.eng-blueprints { display: flex; flex-wrap: wrap; gap: 4px; }
.eng-blueprints span { font-size: 10.5px; font-family: ${MONO}; border: 1px solid var(--line); border-radius: 2px; padding: 2px 5px; color: var(--muted); }
.eng-blueprints span.grade-five { color: var(--orange); }
.eng-empty { border: 1px dashed var(--line); color: var(--muted); padding: 32px 16px; text-align: center; font-size: 12px; }
@media (max-width: 900px) {
  .eng-layout { grid-template-columns: 1fr; }
  .eng-details { position: static; max-height: none; }
}
@media (max-width: 560px) {
  .eng-toolbar { padding: 8px; }
  .eng-segmented { width: 100%; }
  .eng-segmented button { flex: 1; }
  .eng-search { flex-basis: 100%; }
  .eng-toolbar-actions > button { flex: 1 1 calc(50% - 4px); }
  .eng-progress { width: 100%; margin-left: 0; text-align: left; }
  .eng-children { margin-left: 9px; padding-left: 12px; }
  .eng-children > .eng-node::before { left: -12px; width: 12px; }
  .eng-card-collapse { width: 25px; flex-basis: 25px; }
  .eng-status { display: none; }
}
`;
