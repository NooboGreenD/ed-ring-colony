'use client';

/**
 * Разделы карточки системы: всё, что проект знает о системе, и ссылки в
 * разделы сайта, где её можно открыть дальше. Данные — `GET /api/systems/overview`
 * (`src/lib/systemOverview.ts`), стиль — как у остальной страницы системы
 * (DESIGN.md: плоские панели, моноширинные заголовки, палитра CSS-переменных).
 */

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import {
  IconAtlas,
  IconChart,
  IconCompass,
  IconConstruction,
  IconDatabase,
  IconExternalLink,
  IconPower,
  IconProjects,
  IconSearch,
  IconShieldHalf,
  IconStore,
  IconUsers,
  IconAnchor,
} from '@/components/Icons';
import { allegianceLabel, economyLabel, governmentLabel, securityLabel, stateLabel, BGS_SOURCE_LABEL, type BgsSource } from '@/lib/bgs';
import { CARRIER_RELATION_LABEL } from '@/lib/carrierMap';
import { POWERPLAY_STATE_LABEL, POWERPLAY_STATE_ZONE, powerColor, powerLabel, type PowerplayState } from '@/lib/powerplay';
import { STAGE_LABELS, STATUS_LABELS, type ProjectStatus, type SystemStage } from '@/lib/architect/projects';
import type { SystemOverview } from '@/lib/systemOverview';

const mono = 'ui-monospace, SFMono-Regular, Menlo, monospace';

const panel: CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--line)',
  borderRadius: 4,
  padding: 18,
  marginBottom: 20,
};

const sectionTitle: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--orange)',
  letterSpacing: 2,
  textTransform: 'uppercase',
  margin: '0 0 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontFamily: mono,
};

const label: CSSProperties = {
  fontSize: 11,
  color: 'var(--muted)',
  letterSpacing: 2,
  textTransform: 'uppercase',
  marginBottom: 4,
  fontFamily: mono,
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
  gap: 14,
};

const row: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '7px 0',
  borderBottom: '1px solid var(--line)',
  fontSize: 13,
};

const muted: CSSProperties = { color: 'var(--muted)', fontSize: 12 };

function chip(tone: string): CSSProperties {
  return {
    padding: '7px 12px',
    border: `1px solid ${tone}`,
    color: tone,
    borderRadius: 2,
    textDecoration: 'none',
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontFamily: mono,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  };
}

const number = (value: number | null | undefined, digits = 0) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits })
    : '—';

function when(value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

const SYSTEM_STATUS_LABEL: Record<string, string> = {
  planned: 'Запланирована',
  building: 'Строится',
  done: 'Построена',
  unknown: 'Нет данных',
};

const SOURCE_LABEL: Record<string, string> = {
  edsm: 'дамп EDSM',
  helper: 'Colonial Helper',
  web: 'журнал через сайт',
  eddn: 'EDDN',
  'colonial-helper': 'Colonial Helper',
  spansh: 'Spansh',
};

function Section({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={sectionTitle}>{icon} {title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div>
      <div style={label}>{name}</div>
      <div style={{ color: 'var(--text)', fontSize: 14 }}>{children}</div>
    </div>
  );
}

/** Переходы в разделы сайта и внешние сервисы — одинаковые на всех страницах. */
export function SystemLinksBar({ overview }: { overview: SystemOverview }) {
  const { links } = overview;
  return (
    <nav aria-label="Эта система в других разделах" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
      <Link href={links.atlas} style={chip('var(--cyan)')}><IconAtlas size={12} /> Атлас</Link>
      <Link href={links.factions} style={chip('var(--cyan)')}><IconShieldHalf size={12} /> Фракции</Link>
      <Link href={links.powerplay} style={chip('var(--cyan)')}><IconPower size={12} /> PowerPlay</Link>
      <Link href={links.nearby} style={chip('var(--cyan)')}><IconCompass size={12} /> Поблизости</Link>
      <Link href={links.market} style={chip('var(--green)')}><IconStore size={12} /> Рынки рядом</Link>
      <Link href={links.stations} style={chip('var(--green)')}><IconSearch size={12} /> Поиск по станциям</Link>
      <Link href={links.architect} style={chip('var(--orange)')}><IconConstruction size={12} /> Архитектор</Link>
      <a href={links.external.edsm} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>EDSM <IconExternalLink size={10} /></a>
      {links.external.spansh && <a href={links.external.spansh} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>Spansh <IconExternalLink size={10} /></a>}
      <a href={links.external.raven} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>Raven <IconExternalLink size={10} /></a>
      <a href={links.external.inara} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>Inara <IconExternalLink size={10} /></a>
    </nav>
  );
}

function ColonisationSection({ overview }: { overview: SystemOverview }) {
  const { progress, architect, plans, known } = overview.colonisation;
  if (!known && !architect && plans.length === 0) return null;
  const tone = progress.status === 'done' ? 'var(--green)' : progress.status === 'building' ? 'var(--orange)' : 'var(--cyan)';
  return (
    <Section
      icon={<IconChart size={18} />}
      title="Колонизация — все источники"
      action={<Link href={overview.links.architect} style={chip('var(--orange)')}><IconConstruction size={12} /> Открыть в Архитекторе</Link>}
    >
      <p style={{ ...muted, marginTop: 0 }}>
        Тот же расчёт, что в «Проектах систем»: кэш Raven Colonial, площадки из журналов пилотов (Colonial Helper, загрузка на сайте, CAPI) и план архитектора.
      </p>
      <div style={grid}>
        <Fact name="Прогресс">
          <span style={{ fontSize: 26, fontWeight: 700, color: tone }}>{progress.progress == null ? '—' : `${number(progress.progress, 2)}%`}</span>
        </Fact>
        <Fact name="Статус"><span style={{ color: tone }}>{SYSTEM_STATUS_LABEL[progress.status] ?? progress.status}</span></Fact>
        <Fact name="Площадки">{progress.sites.length ? `${progress.sitesComplete} готово · ${progress.sitesActive} в работе` : '—'}</Fact>
        {progress.totalTons > 0 && <Fact name="Тоннаж">{number(progress.doneTons)} / {number(progress.totalTons)} т</Fact>}
        {progress.remaining != null && <Fact name="Осталось привезти">{number(progress.remaining)} т</Fact>}
        <Fact name="Архитектор">{architect ? `${architect.name}${architect.isViewer ? ' (вы)' : ''}` : 'не назначен'}</Fact>
      </div>
      {progress.sites.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>Площадки</div>
          {progress.sites.slice(0, 12).map((site) => (
            <div key={site.key} style={row}>
              <span>{site.name}{site.body ? <span style={muted}> · {site.body}</span> : null}</span>
              <span style={{ color: site.complete ? 'var(--green)' : 'var(--orange)', fontFamily: mono }}>
                {site.complete ? 'готово' : site.progress == null ? '—' : `${number(site.progress, 1)}%`}
                <span style={muted}> · {site.source === 'both' ? 'Raven + журнал' : site.source === 'raven' ? 'Raven' : 'журнал'}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {progress.needs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>Что ещё нужно</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {progress.needs.slice(0, 12).map((need) => (
              <span key={need.key} style={{ ...chip('var(--line)'), color: 'var(--text)' }}>{need.label}: {number(need.remaining)} т</span>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <Link href={overview.links.market} style={{ color: 'var(--green)', fontSize: 12 }}>Где купить рядом → Атлас «Рынок»</Link>
          </div>
        </div>
      )}
      {plans.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>Планы системы</div>
          {plans.map((plan) => (
            <div key={plan.id} style={row}>
              <span>
                {plan.title}
                <span style={muted}> · {plan.authorName}{plan.byArchitect ? ' (архитектор)' : ''}{plan.own ? ' · ваш' : ''}{plan.visibility !== 'public' ? ' · черновик' : ''}</span>
              </span>
              <span style={{ fontFamily: mono, ...muted }}>{plan.siteCount} площ. · {number(plan.haulTons)} т</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ProjectsSection({ overview }: { overview: SystemOverview }) {
  const { squadron, architect } = overview.projects;
  const { route, hub } = overview.ring;
  if (!squadron.length && !architect.length && !route && !hub) return null;
  return (
    <Section icon={<IconProjects size={18} />} title="Проекты и кольцо">
      {(route || hub) && (
        <div style={{ ...grid, marginBottom: 12 }}>
          {hub && <Fact name="Хаб кольца">{hub.name || 'Хаб'}{hub.segment != null ? <span style={muted}> · сегмент {hub.segment}</span> : null}</Fact>}
          {route && <Fact name="Маршрут кольца">№ {route.order}{route.progress != null ? ` · ${number(route.progress)}%` : ''}</Fact>}
          <Fact name="Карта кольца"><Link href="/map" style={{ color: 'var(--cyan)' }}>Открыть карту</Link> · <Link href="/systems" style={{ color: 'var(--cyan)' }}>системы</Link></Fact>
        </div>
      )}
      {squadron.length > 0 && (
        <div style={{ marginBottom: architect.length ? 14 : 0 }}>
          <div style={label}>Проекты эскадрилий</div>
          {squadron.map((project) => (
            <div key={`sq-${project.id}`} style={row}>
              <span>
                <Link href={`/projects/${project.id}`} style={{ color: project.color || 'var(--text)' }}>{project.name}</Link>
                {project.squadron && (
                  <span style={muted}> · <Link href={`/squadrons/${project.squadron.id}`} style={{ color: 'var(--muted)' }}>{project.squadron.tag ? `[${project.squadron.tag}] ` : ''}{project.squadron.name ?? 'эскадрилья'}</Link></span>
                )}
              </span>
              <span style={{ fontFamily: mono }}>{SYSTEM_STATUS_LABEL[project.systemStatus] ?? project.systemStatus}</span>
            </div>
          ))}
        </div>
      )}
      {architect.length > 0 && (
        <div>
          <div style={label}>Ваши «Проекты систем»</div>
          {architect.map((project) => (
            <div key={`ap-${project.id}`} style={row}>
              <span>
                <Link href={`/architect/projects/${project.id}`} style={{ color: project.color || 'var(--text)' }}>{project.name}</Link>
                <span style={muted}> · {STATUS_LABELS[project.status as ProjectStatus] ?? project.status}</span>
              </span>
              <span style={{ fontFamily: mono }}>
                {STAGE_LABELS[project.stage as SystemStage] ?? project.stage}
                {project.progress != null ? <span style={muted}> · проект {number(project.progress, 1)}%</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function StationsSection({ overview }: { overview: SystemOverview }) {
  const { items } = overview.stations;
  if (!items.length) return null;
  const stations = items.filter((station) => !station.carrier);
  const carriers = items.length - stations.length;
  return (
    <Section
      icon={<IconStore size={18} />}
      title={`Станции (${stations.length})`}
      action={<Link href={overview.links.stations} style={chip('var(--green)')}><IconSearch size={12} /> Поиск по станциям</Link>}
    >
      {stations.slice(0, 20).map((station) => (
        <div key={station.key} style={row}>
          <span>
            {station.name}
            <span style={muted}>
              {station.type ? ` · ${station.type}` : ''}
              {station.distanceLs != null ? ` · ${number(station.distanceLs)} св. с.` : ''}
              {station.engineers.length ? ` · инженеры: ${station.engineers.join(', ')}` : ''}
            </span>
          </span>
          <span style={{ ...muted, fontFamily: mono, textAlign: 'right' }}>
            {(['market', 'outfitting', 'shipyard'] as const)
              .filter((kind) => station.inventories[kind])
              .map((kind) => ({ market: 'рынок', outfitting: 'модули', shipyard: 'верфь' })[kind])
              .join(' · ') || 'без товаров'}
            {' · '}{SOURCE_LABEL[station.source] ?? station.source} {when(station.observedAt)}
          </span>
        </div>
      ))}
      {carriers > 0 && <p style={{ ...muted, marginBottom: 0 }}>Ещё {carriers} авианосц(а/ев) с рынком — в разделе «Авианосцы» ниже и в поиске станций.</p>}
    </Section>
  );
}

function FactionsSection({ overview }: { overview: SystemOverview }) {
  const detail = overview.factions;
  if (!detail) return null;
  return (
    <Section
      icon={<IconShieldHalf size={18} />}
      title="Минорные фракции"
      action={<Link href={overview.links.factions} style={chip('var(--cyan)')}><IconAtlas size={12} /> На карте фракций</Link>}
    >
      <div style={grid}>
        <Fact name="Контролирует">{detail.controlling ?? '—'}</Fact>
        <Fact name="Принадлежность">{allegianceLabel(detail.allegiance)}</Fact>
        <Fact name="Правительство">{governmentLabel(detail.government)}</Fact>
        <Fact name="Экономика">{economyLabel(detail.economy)}{detail.secondEconomy ? ` / ${economyLabel(detail.secondEconomy)}` : ''}</Fact>
        <Fact name="Безопасность">{securityLabel(detail.security)}</Fact>
        <Fact name="Население">{number(detail.population)}</Fact>
      </div>
      {detail.factions.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {detail.factions.map((faction) => (
            <div key={faction.id} style={row}>
              <span>
                {faction.name}
                <span style={muted}> · {allegianceLabel(faction.allegiance)}{faction.isPlayer ? ' · игроков' : ''}</span>
              </span>
              <span style={{ fontFamily: mono }}>
                {faction.influence == null ? '—' : `${number(faction.influence * 100, 1)}%`}
                {faction.activeStates.length ? <span style={muted}> · {faction.activeStates.map((state) => stateLabel(state)).join(', ')}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      <p style={{ ...muted, marginBottom: 0 }}>
        Наблюдение: {when(detail.observedAt)} · {BGS_SOURCE_LABEL[detail.source as BgsSource] ?? detail.source}
      </p>
    </Section>
  );
}

function PowerplaySection({ overview }: { overview: SystemOverview }) {
  const pp = overview.powerplay;
  if (!pp) return null;
  const color = pp.power ? powerColor(pp.power) : 'var(--muted)';
  const state = pp.state as PowerplayState;
  return (
    <Section
      icon={<IconPower size={18} />}
      title="PowerPlay"
      action={<Link href={overview.links.powerplay} style={chip('var(--cyan)')}><IconAtlas size={12} /> На карте PowerPlay</Link>}
    >
      <div style={grid}>
        <Fact name="Держава">
          <span style={{ color }}>{pp.power ? powerLabel(pp.power) : 'не определена'}</span>
          {!pp.power && (
            <div style={muted}>
              Дамп EDSM перечисляет у системы несколько держав и не говорит, какая владелец; его уточнит журнал пилота или EDDN
            </div>
          )}
        </Fact>
        <Fact name="Состояние">{POWERPLAY_STATE_LABEL[state] ?? pp.state}<div style={muted}>{POWERPLAY_STATE_ZONE[state] ?? ''}</div></Fact>
        {pp.controlProgress != null && <Fact name="Шкала контроля">{number(pp.controlProgress * 100, 1)}%</Fact>}
        {pp.reinforcement != null && <Fact name="Подкрепление">{number(pp.reinforcement)}</Fact>}
        {pp.undermining != null && <Fact name="Подрыв">{number(pp.undermining)}</Fact>}
        {(pp.powers.length > 1 || (!pp.power && pp.powers.length > 0)) && (
          <Fact name={pp.power ? 'Державы в системе' : 'Претенденты'}>{pp.powers.map((power) => powerLabel(power)).join(', ')}</Fact>
        )}
      </div>
      <p style={{ ...muted, marginBottom: 0 }}>Наблюдение: {when(pp.observedAt)} · {SOURCE_LABEL[pp.source] ?? pp.source}</p>
    </Section>
  );
}

function CarriersSection({ overview }: { overview: SystemOverview }) {
  const { carriers } = overview;
  if (!carriers.length) return null;
  return (
    <Section icon={<IconAnchor size={18} />} title={`Авианосцы (${carriers.length})`}>
      {carriers.map((carrier) => (
        <div key={carrier.id} style={row}>
          <span>
            <span style={{ fontFamily: mono }}>{carrier.callsign ?? carrier.id}</span>
            {carrier.name ? ` «${carrier.name}»` : ''}
            <span style={muted}>
              {' · '}{CARRIER_RELATION_LABEL[carrier.relation]}
              {carrier.owner ? ` · ${carrier.owner}` : ''}
              {carrier.squadron?.tag ? ` · [${carrier.squadron.tag}]` : ''}
              {carrier.body ? ` · ${carrier.body}` : ''}
            </span>
          </span>
          <span style={{ ...muted, fontFamily: mono, textAlign: 'right' }}>
            {carrier.jump ? `прыжок → ${carrier.jump.system}` : carrier.docking ?? ''}
            {carrier.estimated ? ' · по расписанию' : ''}
          </span>
        </div>
      ))}
    </Section>
  );
}

function CommunitySection({ overview }: { overview: SystemOverview }) {
  const { goals, deliveries, scans } = overview.community;
  if (!goals.length && deliveries.tons <= 0 && scans.bodies <= 0) return null;
  return (
    <Section icon={<IconUsers size={18} />} title="Сообщество">
      <div style={grid}>
        {deliveries.tons > 0 && <Fact name="Привезено на стройки">{number(deliveries.tons)} т<div style={muted}>{number(deliveries.pilots)} пилот(ов) · последняя {when(deliveries.lastAt)}</div></Fact>}
        {scans.bodies > 0 && <Fact name="Сканы тел">{number(scans.bodies)}<div style={muted}>обновлены {when(scans.updatedAt)}</div></Fact>}
        <Fact name="Рейтинги"><Link href="/leaderboard" style={{ color: 'var(--cyan)' }}>Лидерборд</Link></Fact>
      </div>
      {goals.map((goal) => (
        <div key={goal.id} style={row}>
          <span>
            <Link href="/cg" style={{ color: 'var(--text)' }}>{goal.title}</Link>
            <span style={muted}>{goal.station ? ` · ${goal.station}` : ''}{goal.colonisation ? ' · колонизация' : ''}</span>
          </span>
          <span style={{ ...muted, fontFamily: mono }}>
            {goal.complete ? 'завершена' : `ярус ${goal.tier ?? '—'}/${goal.tierMax ?? '—'} · до ${when(goal.expiresAt)}`}
          </span>
        </div>
      ))}
    </Section>
  );
}

function FreshnessSection({ overview }: { overview: SystemOverview }) {
  if (!overview.freshness.length && !overview.warnings.length) return null;
  return (
    <Section icon={<IconDatabase size={18} />} title="Источники данных">
      <div style={grid}>
        {overview.freshness.map((item) => (
          <Fact key={item.source} name={item.label}>{when(item.at)}</Fact>
        ))}
      </div>
      {overview.warnings.map((warning) => (
        <p key={warning} style={{ ...muted, color: 'var(--orange)', marginBottom: 0 }}>{warning}</p>
      ))}
    </Section>
  );
}

/** Все разделы сводки по порядку; пустые разделы не рисуются. */
export default function SystemOverviewSections({ overview, showColonisation = true }: { overview: SystemOverview; showColonisation?: boolean }) {
  return (
    <div data-testid="system-overview">
      {showColonisation && <ColonisationSection overview={overview} />}
      <ProjectsSection overview={overview} />
      <FactionsSection overview={overview} />
      <PowerplaySection overview={overview} />
      <StationsSection overview={overview} />
      <CarriersSection overview={overview} />
      <CommunitySection overview={overview} />
      <FreshnessSection overview={overview} />
    </div>
  );
}
