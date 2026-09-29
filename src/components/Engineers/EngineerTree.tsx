'use client';

/**
 * Дерево инженеров: кто о ком рассказывает, что просит за знакомство и что
 * умеет улучшать.
 *
 * Раскладка повторяет привычную «схему разблокировки»: сверху — инженеры,
 * доступные сразу, ниже — те, к кому ведёт наводка, связи нарисованы линиями.
 * Карточку можно отметить как открытую — отметки живут в браузере и сразу
 * подсвечивают, кто стал доступен следующим.
 *
 * Список улучшений подтягивается из того же справочника, что и верфь, поэтому
 * страницы не расходятся: `/outfitting?engineer=<id>` и наоборот.
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
import { useOutfittingData } from '@/lib/outfitting/useOutfittingData';
import { LABEL, MONO, PANEL, button } from '@/components/Outfitting/styles';

const STORE_KEY = 'ed-ring-colony:engineers:unlocked';

interface UpgradeRow {
  group: string;
  groupName: string;
  blueprints: { id: string; label: string; grade: number }[];
}

/** Что инженер улучшает — из справочника верфи, сгруппировано по модулям. */
function useUpgrades(engineer: Engineer | null): UpgradeRow[] {
  const { data } = useOutfittingData();
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
          groupName: data.groups[group]?.name ?? group.toUpperCase(),
          blueprints: [],
        });
      }
      rows.get(group)!.blueprints.push({ id: blueprint, label: blueprintLabel(blueprint), grade });
    }
    for (const row of rows.values()) {
      row.blueprints.sort((left, right) => right.grade - left.grade || left.label.localeCompare(right.label));
    }
    return [...rows.values()].sort((left, right) => left.groupName.localeCompare(right.groupName));
  }, [data, engineer]);
}

function Card({
  engineer,
  selected,
  unlocked,
  available,
  onSelect,
  onToggle,
}: {
  engineer: Engineer;
  selected: boolean;
  unlocked: boolean;
  available: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const accent = unlocked ? 'var(--green)' : available ? 'var(--orange)' : 'var(--line)';
  return (
    <div
      className="eng-card"
      style={{
        border: `1px solid ${selected ? 'var(--cyan)' : accent}`,
        background: selected ? 'rgba(52,152,219,0.10)' : 'var(--panel)',
        boxShadow: selected ? '0 0 0 1px var(--cyan)' : undefined,
        opacity: unlocked || available ? 1 : 0.82,
      }}
    >
      <button type="button" onClick={onSelect} className="eng-card-main">
        <span className="eng-card-name" style={{ color: unlocked ? 'var(--green)' : 'var(--text)' }}>
          {engineer.name}
        </span>
        <span className="eng-card-sub">
          {engineer.system}
          {engineer.permit ? ' · пермит' : ''}
          {engineer.colonia ? ' · Колония' : ''}
        </span>
        <span className="eng-card-focus" title={engineer.focus}>{engineer.focus}</span>
      </button>
      <button
        type="button"
        onClick={onToggle}
        className="eng-card-mark"
        title={unlocked ? 'Отметить как не открытого' : 'Отметить как открытого'}
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
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { engineer, branch, selected, unlocked, onSelect, onToggle } = props;
  // Инженера с несколькими наставниками (Yi Shen) рисуем только под первым,
  // чтобы дерево не двоилось; остальные связи видно в карточке.
  const children = childrenOf(engineer.id, branch).filter((child) => child.from[0] === engineer.id);
  const available = engineer.from.length === 0 || engineer.from.some((parent) => unlocked.has(parent));
  return (
    <li className="eng-node">
      <Card
        engineer={engineer}
        selected={selected === engineer.id}
        unlocked={unlocked.has(engineer.id)}
        available={available}
        onSelect={() => onSelect(engineer.id)}
        onToggle={() => onToggle(engineer.id)}
      />
      {children.length > 0 && (
        <ul className="eng-children">
          {children.map((child) => (
            <Node key={child.id} {...props} engineer={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function EngineerTree() {
  const [branch, setBranch] = useState<EngineerBranch>('ship');
  const [selected, setSelected] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [hideColonia, setHideColonia] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) setUnlocked(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* отметки — приятный бонус, без них страница работает так же */
    }
    const engineer = resolveEngineer(new URLSearchParams(window.location.search).get('engineer'));
    if (engineer) {
      setSelected(engineer.id);
      setBranch(engineer.branch);
    }
  }, []);

  const toggle = useCallback((id: string) => {
    setUnlocked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
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

  const current = selected ? ENGINEER_BY_ID.get(selected) ?? null : null;
  const upgrades = useUpgrades(current);
  const roots = rootsOf(branch).filter((engineer) => !(hideColonia && engineer.colonia));
  const total = ENGINEERS.filter((engineer) => engineer.branch === branch).length;
  const done = ENGINEERS.filter((engineer) => engineer.branch === branch && unlocked.has(engineer.id)).length;

  return (
    <>
      <style>{treeCss}</style>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <button type="button" style={button(branch === 'ship')} onClick={() => setBranch('ship')}>корабли</button>
        <button type="button" style={button(branch === 'odyssey')} onClick={() => setBranch('odyssey')}>одиссея</button>
        <button type="button" style={button(hideColonia)} onClick={() => setHideColonia((value) => !value)}>
          {hideColonia ? 'колония скрыта' : 'скрыть колонию'}
        </button>
        <span style={{ ...LABEL, marginLeft: 'auto' }}>
          открыто {done} из {total}
        </span>
        {done > 0 && (
          <button
            type="button"
            style={button(false, 'var(--red)')}
            onClick={() => {
              setUnlocked(new Set());
              window.localStorage.removeItem(STORE_KEY);
            }}
          >
            сбросить отметки
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div className="eng-tree-wrap" style={{ flex: '1 1 640px', minWidth: 300 }}>
          <ul className="eng-roots">
            {roots.map((engineer) => (
              <Node
                key={engineer.id}
                engineer={engineer}
                branch={branch}
                selected={selected}
                unlocked={unlocked}
                onSelect={select}
                onToggle={toggle}
              />
            ))}
          </ul>
        </div>

        <aside style={{ flex: '0 1 340px', minWidth: 260, position: 'sticky', top: 12 }}>
          {!current && (
            <div style={PANEL}>
              <p style={{ ...LABEL, marginTop: 0 }}>как читать схему</p>
              <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.7, marginBottom: 0 }}>
                Верхний ряд — инженеры, о которых известно сразу. Линии вниз — наводки: чтобы узнать о нижнем
                инженере, нужно поднять верхнего до 3–4 уровня. Нажмите на карточку, чтобы увидеть условия
                знакомства и полный список чертежей; «+» отмечает уже открытых.
              </p>
            </div>
          )}

          {current && (
            <div style={PANEL}>
              <h2 style={{ fontSize: 15, margin: '0 0 2px' }}>{current.name}</h2>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', fontFamily: MONO, margin: '0 0 10px' }}>
                {current.station} · {current.system}
                {current.permit ? ' · нужен пермит' : ''}
                {current.colonia ? ' · Колония' : ''}
              </p>

              <Row title="как узнать">{current.discovery}</Row>
              {current.meeting && current.meeting !== '—' && <Row title="условие встречи">{current.meeting}</Row>}
              <Row title="приглашение">{current.unlock}</Row>
              {current.referral && <Row title="наводка дальше">{current.referral}</Row>}

              {current.from.length > 0 && (
                <Row title="сначала откройте">
                  {pathTo(current.id).slice(0, -1).map((parent, index, list) => (
                    <span key={parent.id}>
                      <button
                        type="button"
                        onClick={() => select(parent.id)}
                        style={{ background: 'none', border: 'none', padding: 0, margin: 0, color: 'var(--cyan)', cursor: 'pointer', fontSize: 12, textTransform: 'none', letterSpacing: 0 }}
                      >
                        {parent.name}
                      </button>
                      {index < list.length - 1 ? ' → ' : ''}
                    </span>
                  ))}
                  {current.from.length > 1 && ` (и ещё: ${current.from.slice(1).map((id) => ENGINEER_BY_ID.get(id)?.name ?? id).join(', ')})`}
                </Row>
              )}

              <p style={{ ...LABEL, margin: '14px 0 6px', color: 'var(--orange)' }}>что улучшает</p>
              {current.skills && (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.7 }}>
                  {current.skills.map((skill) => <li key={skill}>{skill}</li>)}
                </ul>
              )}
              {!current.skills && upgrades.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--muted)' }}>Загрузка списка чертежей…</p>
              )}
              {upgrades.map((row) => (
                <div key={row.group} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--cyan)', fontFamily: MONO, marginBottom: 2 }}>{row.groupName}</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {row.blueprints.map((blueprint) => (
                      <span
                        key={blueprint.id}
                        title={`${blueprint.label} — максимум ${blueprint.grade} уровень`}
                        style={{
                          fontSize: 10.5, fontFamily: MONO, border: '1px solid var(--line)', borderRadius: 2,
                          padding: '2px 5px', color: blueprint.grade >= 5 ? 'var(--orange)' : 'var(--muted)',
                        }}
                      >
                        {blueprint.label} · G{blueprint.grade}
                      </span>
                    ))}
                  </div>
                </div>
              ))}

              {current.branch === 'ship' && (
                <p style={{ marginTop: 12, marginBottom: 0 }}>
                  <Link href="/outfitting" style={{ fontSize: 12 }}>Собрать корабль с этими улучшениями →</Link>
                </p>
              )}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={LABEL}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

/**
 * Раскладка дерева. Вертикальные и горизонтальные линии рисуются рамками
 * псевдоэлементов — никакого canvas и пересчёта координат при ресайзе.
 */
const treeCss = `
.eng-tree-wrap { overflow-x: auto; padding-bottom: 8px; }
.eng-roots, .eng-children {
  display: flex; justify-content: center; list-style: none; margin: 0; padding: 0;
}
.eng-roots { align-items: flex-start; gap: 4px; padding-top: 4px; }
.eng-children { padding-top: 28px; }
.eng-node { position: relative; display: flex; flex-direction: column; align-items: center; padding: 0 5px; }
/* вертикаль вниз от карточки-наставника до перекладины */
.eng-node > .eng-children { position: relative; }
.eng-node > .eng-children::before {
  content: ''; position: absolute; top: 0; left: 50%; width: 1px; height: 14px;
  background: var(--orange); opacity: 0.55;
}
/* вертикаль от перекладины вниз к карточке ученика */
.eng-children > .eng-node::before {
  content: ''; position: absolute; top: -14px; left: 50%; width: 1px; height: 14px;
  background: var(--orange); opacity: 0.55;
}
/* перекладина между учениками одного наставника */
.eng-children > .eng-node::after {
  content: ''; position: absolute; top: -14px; left: 0; right: 0; height: 1px;
  background: var(--orange); opacity: 0.55;
}
.eng-children > .eng-node:first-child::after { left: 50%; }
.eng-children > .eng-node:last-child::after { right: 50%; }
.eng-children > .eng-node:only-child::after { display: none; }
.eng-card {
  position: relative; display: flex; align-items: stretch; width: 186px; min-height: 76px;
  border-radius: 3px;
  transition: border-color .12s ease, background .12s ease;
}
.eng-card-main {
  display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left;
  flex: 1; min-width: 0; background: none; border: none; cursor: pointer; padding: 7px 8px;
  color: var(--text); margin: 0; text-transform: none; letter-spacing: 0;
}
.eng-card-name { font-size: 12.5px; font-weight: 600; line-height: 1.25; }
.eng-card-sub {
  font-size: 10px; color: var(--muted); letter-spacing: 1px; text-transform: uppercase;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.eng-card-focus {
  font-size: 10.5px; color: var(--muted); line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.eng-card-mark {
  width: 26px; flex: 0 0 26px; background: none; border: none; border-left: 1px solid var(--line);
  cursor: pointer; font-size: 13px; margin: 0; padding: 0; border-radius: 0;
}
@media (max-width: 720px) {
  .eng-roots, .eng-children { flex-direction: column; align-items: stretch; gap: 6px; padding-top: 8px; }
  .eng-children { padding-left: 16px; border-left: 1px solid rgba(230,126,34,0.55); padding-top: 6px; }
  .eng-children > .eng-node::before, .eng-children > .eng-node::after,
  .eng-node > .eng-children::before { display: none; }
  .eng-node { padding: 0; align-items: stretch; }
  .eng-card { width: auto; min-height: 0; }
}
`;
