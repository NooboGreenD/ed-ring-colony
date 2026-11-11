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
} from '@/components/Icons';
import { allegianceLabel, economyLabel, governmentLabel, securityLabel, stateLabel, BGS_SOURCE_LABEL, type BgsSource } from '@/lib/bgs';
import { CARRIER_RELATION_LABEL } from '@/lib/carrierMap';
import { carrierCardHref, carrierCardTitle } from '@/lib/carrierCard';
import { CarrierGlyph } from '@/components/GalaxyMap/CarrierGlyph';
import { POWERPLAY_STATE_LABEL, POWERPLAY_STATE_ZONE, powerColor, powerLabel, type PowerplayState } from '@/lib/powerplay';
import { STAGE_LABELS, STATUS_LABELS, type ProjectStatus, type SystemStage } from '@/lib/architect/projects';
import type { TFn } from '@/lib/i18n/gameLabels';
import { ALLEGIANCE_KEYS, GOVERNMENT_KEYS, POWER_STATE_KEYS, POWER_STATE_ZONE_KEYS, STATE_KEYS, gameLabel } from '@/lib/i18n/gameLabels';
import { useI18n } from '@/lib/i18n/I18nContext';
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

const number = (locale: string, value: number | null | undefined, digits = 0) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString(locale, { maximumFractionDigits: digits })
    : '—';

function when(locale: string, value: string | null | undefined): string {
  if (!value) return '—';
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

const SYSTEM_STATUS_LABEL: Record<string, string> = {
  planned: 'sysOv.statusPlanned',
  building: 'sysOv.statusBuilding',
  done: 'sysOv.statusDone',
  unknown: 'sysOv.statusUnknown',
};

const SOURCE_LABEL: Record<string, string> = {
  edsm: 'sysOv.srcEdsm',
  helper: 'Colonial Helper',
  web: 'sysOv.srcWeb',
  eddn: 'EDDN',
  'colonial-helper': 'Colonial Helper',
  spansh: 'Spansh',
};

/** Ключ справочника в перевод: латинские значения (EDDN, Spansh) остаются как есть. */
function sourceLabel(t: TFn, source: string): string {
  const key = SOURCE_LABEL[source];
  if (!key) return source;
  return key.includes('.') ? t(key) : key;
}

function statusLabel(t: TFn, status: string): string {
  const key = SYSTEM_STATUS_LABEL[status];
  return key ? t(key) : status;
}

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
  const { t } = useI18n();
  const { links } = overview;
  return (
    <nav aria-label={t('sysOv.linksAria')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
      <Link href={links.atlas} style={chip('var(--cyan)')}><IconAtlas size={12} /> {t('sysOv.linkAtlas')}</Link>
      <Link href={links.factions} style={chip('var(--cyan)')}><IconShieldHalf size={12} /> {t('sysOv.linkFactions')}</Link>
      <Link href={links.powerplay} style={chip('var(--cyan)')}><IconPower size={12} /> PowerPlay</Link>
      <Link href={links.nearby} style={chip('var(--cyan)')}><IconCompass size={12} /> {t('sysOv.linkNearby')}</Link>
      <Link href={links.market} style={chip('var(--green)')}><IconStore size={12} /> {t('sysOv.linkMarket')}</Link>
      <Link href={links.stations} style={chip('var(--green)')}><IconSearch size={12} /> {t('sysOv.linkStations')}</Link>
      <Link href={links.architect} style={chip('var(--orange)')}><IconConstruction size={12} /> {t('sysOv.linkArchitect')}</Link>
      <a href={links.external.edsm} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>EDSM <IconExternalLink size={10} /></a>
      {links.external.spansh && <a href={links.external.spansh} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>Spansh <IconExternalLink size={10} /></a>}
      <a href={links.external.raven} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>Raven <IconExternalLink size={10} /></a>
      <a href={links.external.inara} target="_blank" rel="noopener noreferrer" style={chip('var(--muted)')}>Inara <IconExternalLink size={10} /></a>
    </nav>
  );
}

function ColonisationSection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  const { progress, architect, plans, known } = overview.colonisation;
  if (!known && !architect && plans.length === 0) return null;
  const tone = progress.status === 'done' ? 'var(--green)' : progress.status === 'building' ? 'var(--orange)' : 'var(--cyan)';
  return (
    <Section
      icon={<IconChart size={18} />}
      title={t('sysOv.colonisationTitle')}
      action={<Link href={overview.links.architect} style={chip('var(--orange)')}><IconConstruction size={12} /> {t('sysOv.openInArchitect')}</Link>}
    >
      <p style={{ ...muted, marginTop: 0 }}>
        {t('sysOv.colonisationLead')}
      </p>
      <div style={grid}>
        <Fact name={t('sysOv.factProgress')}>
          <span style={{ fontSize: 26, fontWeight: 700, color: tone }}>{progress.progress == null ? '—' : `${number(locale, progress.progress, 2)}%`}</span>
        </Fact>
        <Fact name={t('sysOv.factStatus')}><span style={{ color: tone }}>{statusLabel(t, progress.status)}</span></Fact>
        <Fact name={t('sysOv.factSites')}>{progress.sites.length ? t('sysOv.sitesSummary', { done: progress.sitesComplete, active: progress.sitesActive }) : '—'}</Fact>
        {progress.totalTons > 0 && <Fact name={t('sysOv.factTonnage')}>{number(locale, progress.doneTons)} / {number(locale, progress.totalTons)} {t('sysOv.tonsUnit')}</Fact>}
        {progress.remaining != null && <Fact name={t('sysOv.factRemaining')}>{number(locale, progress.remaining)} {t('sysOv.tonsUnit')}</Fact>}
        <Fact name={t('sysOv.factArchitect')}>{architect ? `${architect.isViewer ? t('sysOv.architectSelf', { name: architect.name }) : architect.name}` : t('sysOv.architectNone')}</Fact>
      </div>
      {progress.sites.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>{t('sysOv.sitesLabel')}</div>
          {progress.sites.slice(0, 12).map((site) => (
            <div key={site.key} style={row}>
              <span>{site.name}{site.body ? <span style={muted}> · {site.body}</span> : null}</span>
              <span style={{ color: site.complete ? 'var(--green)' : 'var(--orange)', fontFamily: mono }}>
                {site.complete ? t('sysOv.siteDone') : site.progress == null ? '—' : `${number(locale, site.progress, 1)}%`}
                <span style={muted}> · {site.source === 'both' ? t('sysOv.sourceBoth') : site.source === 'raven' ? 'Raven' : t('sysOv.sourceJournal')}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {progress.needs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>{t('sysOv.needsLabel')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {progress.needs.slice(0, 12).map((need) => (
              <span key={need.key} style={{ ...chip('var(--line)'), color: 'var(--text)' }}>{need.label}: {number(locale, need.remaining)} {t('sysOv.tonsUnit')}</span>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <Link href={overview.links.market} style={{ color: 'var(--green)', fontSize: 12 }}>{t('sysOv.whereToBuy')}</Link>
          </div>
        </div>
      )}
      {plans.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={label}>{t('sysOv.plansLabel')}</div>
          {plans.map((plan) => (
            <div key={plan.id} style={row}>
              <span>
                {plan.title}
                <span style={muted}> · {plan.authorName}{plan.byArchitect ? t('sysOv.planByArchitect') : ''}{plan.own ? t('sysOv.planOwn') : ''}{plan.visibility !== 'public' ? t('sysOv.planDraft') : ''}</span>
              </span>
              <span style={{ fontFamily: mono, ...muted }}>{t('sysOv.planLine', { sites: plan.siteCount, tons: number(locale, plan.haulTons) })}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ProjectsSection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  const { squadron, architect } = overview.projects;
  const { route, hub } = overview.ring;
  if (!squadron.length && !architect.length && !route && !hub) return null;
  return (
    <Section icon={<IconProjects size={18} />} title={t('sysOv.projectsTitle')}>
      {(route || hub) && (
        <div style={{ ...grid, marginBottom: 12 }}>
          {hub && <Fact name={t('sysOv.factRingHub')}>{hub.name || t('sysOv.hubFallback')}{hub.segment != null ? <span style={muted}>{t('sysOv.hubSegment', { segment: hub.segment })}</span> : null}</Fact>}
          {route && <Fact name={t('sysOv.factRingRoute')}>{t('sysOv.routeNumber', { order: route.order })}{route.progress != null ? ` · ${number(locale, route.progress)}%` : ''}</Fact>}
          <Fact name={t('sysOv.factRingMap')}><Link href="/map" style={{ color: 'var(--cyan)' }}>{t('sysOv.openMap')}</Link> · <Link href="/systems" style={{ color: 'var(--cyan)' }}>{t('sysOv.systemsLink')}</Link></Fact>
        </div>
      )}
      {squadron.length > 0 && (
        <div style={{ marginBottom: architect.length ? 14 : 0 }}>
          <div style={label}>{t('sysOv.sqProjectsLabel')}</div>
          {squadron.map((project) => (
            <div key={`sq-${project.id}`} style={row}>
              <span>
                <Link href={`/projects/${project.id}`} style={{ color: project.color || 'var(--text)' }}>{project.name}</Link>
                {project.squadron && (
                  <span style={muted}> · <Link href={`/squadrons/${project.squadron.id}`} style={{ color: 'var(--muted)' }}>{project.squadron.tag ? `[${project.squadron.tag}] ` : ''}{project.squadron.name ?? t('sysOv.squadronFallback')}</Link></span>
                )}
              </span>
              <span style={{ fontFamily: mono }}>{statusLabel(t, project.systemStatus)}</span>
            </div>
          ))}
        </div>
      )}
      {architect.length > 0 && (
        <div>
          <div style={label}>{t('sysOv.ownProjectsLabel')}</div>
          {architect.map((project) => (
            <div key={`ap-${project.id}`} style={row}>
              <span>
                <Link href={`/architect/projects/${project.id}`} style={{ color: project.color || 'var(--text)' }}>{project.name}</Link>
                <span style={muted}> · {STATUS_LABELS[project.status as ProjectStatus] ? t(STATUS_LABELS[project.status as ProjectStatus]) : project.status}</span>
              </span>
              <span style={{ fontFamily: mono }}>
                {STAGE_LABELS[project.stage as SystemStage] ? t(STAGE_LABELS[project.stage as SystemStage]) : project.stage}
                {project.progress != null ? <span style={muted}>{t('sysOv.projectProgress', { percent: number(locale, project.progress, 1) })}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function StationsSection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  const { items } = overview.stations;
  if (!items.length) return null;
  const stations = items.filter((station) => !station.carrier);
  const carriers = items.length - stations.length;
  return (
    <Section
      icon={<IconStore size={18} />}
      title={t('sysOv.stationSection', { count: stations.length })}
      action={<Link href={overview.links.stations} style={chip('var(--green)')}><IconSearch size={12} /> {t('sysOv.linkStations')}</Link>}
    >
      {stations.slice(0, 20).map((station) => (
        <div key={station.key} style={row}>
          <span>
            {station.name}
            <span style={muted}>
              {station.type ? ` · ${station.type}` : ''}
              {station.distanceLs != null ? t('sysOv.lsUnit', { value: number(locale, station.distanceLs) }) : ''}
              {station.engineers.length ? t('sysOv.stationEngineers', { names: station.engineers.join(', ') }) : ''}
            </span>
          </span>
          <span style={{ ...muted, fontFamily: mono, textAlign: 'right' }}>
            {(['market', 'outfitting', 'shipyard'] as const)
              .filter((kind) => station.inventories[kind])
              .map((kind) => t({ market: 'sysOv.market', outfitting: 'sysOv.outfitting', shipyard: 'sysOv.shipyard' }[kind]))
              .join(' · ') || t('sysOv.noGoods')}
            {' · '}{sourceLabel(t, station.source)} {when(locale, station.observedAt)}
          </span>
        </div>
      ))}
      {carriers > 0 && <p style={{ ...muted, marginBottom: 0 }}>{t('sysOv.carriersMore', { count: carriers })}</p>}
    </Section>
  );
}

function FactionsSection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  const detail = overview.factions;
  if (!detail) return null;
  return (
    <Section
      icon={<IconShieldHalf size={18} />}
      title={t('sysOv.factionsTitle')}
      action={<Link href={overview.links.factions} style={chip('var(--cyan)')}><IconAtlas size={12} /> {t('sysOv.factionsOnMap')}</Link>}
    >
      <div style={grid}>
        <Fact name={t('sysOv.factControlling')}>{detail.controlling ?? '—'}</Fact>
        <Fact name={t('sysOv.factAllegiance')}>{gameLabel(t, ALLEGIANCE_KEYS, detail.allegiance, allegianceLabel(detail.allegiance))}</Fact>
        <Fact name={t('sysOv.factGovernment')}>{gameLabel(t, GOVERNMENT_KEYS, detail.government, governmentLabel(detail.government))}</Fact>
        <Fact name={t('sysOv.factEconomy')}>{economyLabel(detail.economy)}{detail.secondEconomy ? ` / ${economyLabel(detail.secondEconomy)}` : ''}</Fact>
        <Fact name={t('sysOv.factSecurity')}>{securityLabel(detail.security)}</Fact>
        <Fact name={t('sysOv.factPopulation')}>{number(locale, detail.population)}</Fact>
      </div>
      {detail.factions.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {detail.factions.map((faction) => (
            <div key={faction.id} style={row}>
              <span>
                {faction.name}
                <span style={muted}> · {gameLabel(t, ALLEGIANCE_KEYS, faction.allegiance, allegianceLabel(faction.allegiance))}{faction.isPlayer ? t('sysOv.playerFaction') : ''}</span>
              </span>
              <span style={{ fontFamily: mono }}>
                {faction.influence == null ? '—' : `${number(locale, faction.influence * 100, 1)}%`}
                {faction.activeStates.length ? <span style={muted}> · {faction.activeStates.map((state) => gameLabel(t, STATE_KEYS, state, stateLabel(state))).join(', ')}</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}
      <p style={{ ...muted, marginBottom: 0 }}>
        {t('sysOv.observed', { when: when(locale, detail.observedAt), source: BGS_SOURCE_LABEL[detail.source as BgsSource] ?? detail.source })}
      </p>
    </Section>
  );
}

function PowerplaySection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  const pp = overview.powerplay;
  if (!pp) return null;
  const color = pp.power ? powerColor(pp.power) : 'var(--muted)';
  const state = pp.state as PowerplayState;
  return (
    <Section
      icon={<IconPower size={18} />}
      title="PowerPlay"
      action={<Link href={overview.links.powerplay} style={chip('var(--cyan)')}><IconAtlas size={12} /> {t('sysOv.ppOnMap')}</Link>}
    >
      <div style={grid}>
        <Fact name={t('sysOv.factPower')}>
          <span style={{ color }}>{pp.power ? powerLabel(pp.power) : t('sysOv.powerUnknown')}</span>
          {!pp.power && (
            <div style={muted}>
              {t('sysOv.ppUnknownHint')}
            </div>
          )}
        </Fact>
        <Fact name={t('sysOv.factState')}>{gameLabel(t, POWER_STATE_KEYS, pp.state, POWERPLAY_STATE_LABEL[state] ?? pp.state)}<div style={muted}>{gameLabel(t, POWER_STATE_ZONE_KEYS, pp.state, POWERPLAY_STATE_ZONE[state] ?? '')}</div></Fact>
        {pp.controlProgress != null && <Fact name={t('sysOv.factControlScale')}>{number(locale, pp.controlProgress * 100, 1)}%</Fact>}
        {pp.reinforcement != null && <Fact name={t('sysOv.factReinforcement')}>{number(locale, pp.reinforcement)}</Fact>}
        {pp.undermining != null && <Fact name={t('sysOv.factUndermining')}>{number(locale, pp.undermining)}</Fact>}
        {(pp.powers.length > 1 || (!pp.power && pp.powers.length > 0)) && (
          <Fact name={pp.power ? t('sysOv.factPowersInSystem') : t('sysOv.factContenders')}>{pp.powers.map((power) => powerLabel(power)).join(', ')}</Fact>
        )}
      </div>
      <p style={{ ...muted, marginBottom: 0 }}>{t('sysOv.observed', { when: when(locale, pp.observedAt), source: sourceLabel(t, pp.source) })}</p>
    </Section>
  );
}

/**
 * Авианосцы системы: кто стоит, у какого тела и что о нём известно.
 *
 * Носители сгруппированы по телу — в игре их находят по телу, а не по
 * алфавиту: «у A 2b» читается сразу, а список из двадцати позывных подряд —
 * нет. Тело знает и учёт сайта (`fleet_carriers.body_name`), и реестр EDDN
 * (`carrier_directory.body_name`); если его не передавали, носитель попадает
 * в группу «тело не указано», а не теряется.
 *
 * Каждая строка ведёт в карточку носителя (`/carriers/<MarketID>`): там его
 * статистика прыжков, службы и всё остальное, что знает сайт. Ссылка на
 * страницу системы тут была бы бесполезна — читатель уже на ней.
 */
function CarriersSection({ overview }: { overview: SystemOverview }) {
  const { t } = useI18n();
  const { carriers } = overview;
  if (!carriers.length) return null;
  // Группы по телу: тело — заголовок, внутри носители по алфавиту.
  const groups = new Map<string, typeof carriers>();
  for (const carrier of carriers) {
    const body = carrier.body?.trim() || '';
    const key = body.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(carrier);
    else groups.set(key, [carrier]);
  }
  const ordered = Array.from(groups.entries()).sort((left, right) => {
    // Носители у известного тела идут первыми, «тело не указано» — в конце.
    if (!left[0] !== !right[0]) return left[0] ? -1 : 1;
    return left[1][0].body!.localeCompare(right[1][0].body!, 'ru');
  });
  const withBody = carriers.filter((carrier) => Boolean(carrier.body?.trim())).length;
  return (
    <Section icon={<CarrierGlyph size={18} color="currentColor" />} title={t('sysOv.carriersSection', { count: carriers.length })}>
      <p style={{ ...muted, marginTop: 0 }}>
        {t('sysOv.carriersBodies', { withBody, total: carriers.length })}
      </p>
      {ordered.map(([key, list]) => (
        <div key={key || 'unknown'} style={{ marginBottom: 10 }}>
          <div style={{ ...label, marginBottom: 4 }}>
            {key
              ? t('sysOv.carriersAtBody', { body: list[0].body!.trim() })
              : t('sysOv.carriersNoBody')}
          </div>
          {list.map((carrier) => {
            const href = carrierCardHref(carrier.id);
            const label = carrierCardTitle(carrier);
            const facts = [
              carrier.relation === 'own' ? t('sysOv.carrierOwn')
                : carrier.relation === 'squadron' ? t('sysOv.carrierSquadron')
                  : CARRIER_RELATION_LABEL[carrier.relation],
              carrier.owner ? carrier.owner : (carrier.ownerHidden ? t('sysOv.carrierOwnerHidden') : ''),
              carrier.squadron?.tag ? `[${carrier.squadron.tag}]` : '',
              carrier.origin === 'eddn' ? t('sysOv.carrierEddn') : '',
              carrier.services.length ? t('sysOv.carrierServices', { count: carrier.services.length }) : '',
            ].filter(Boolean);
            return (
              <div key={carrier.id} style={row}>
                <span style={{ minWidth: 0 }}>
                  {href ? (
                    <Link href={href} style={{ color: 'var(--text)', textDecoration: 'none', borderBottom: '1px dashed var(--line)' }}>
                      {label}
                    </Link>
                  ) : <span style={{ color: 'var(--text)' }}>{label}</span>}
                  {carrier.name && carrier.callsign ? (
                    <span style={{ ...muted, fontFamily: mono }}>{` · ${carrier.callsign}`}</span>
                  ) : null}
                  <span style={muted}>{facts.length ? ` · ${facts.join(' · ')}` : ''}</span>
                </span>
                <span style={{ ...muted, fontFamily: mono, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {carrier.decommission ? t('sysOv.carrierDecommission') : null}
                  {carrier.jump ? t('sysOv.carrierJump', { system: carrier.jump.system }) : carrier.docking ?? ''}
                  {carrier.estimated ? t('sysOv.carrierScheduled') : ''}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </Section>
  );
}

function CommunitySection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  const { goals, deliveries, scans } = overview.community;
  if (!goals.length && deliveries.tons <= 0 && scans.bodies <= 0) return null;
  return (
    <Section icon={<IconUsers size={18} />} title={t('sysOv.communityTitle')}>
      <div style={grid}>
        {deliveries.tons > 0 && <Fact name={t('sysOv.factDelivered')}>{number(locale, deliveries.tons)} {t('sysOv.tonsUnit')}<div style={muted}>{t('sysOv.deliveredPilots', { pilots: number(locale, deliveries.pilots), when: when(locale, deliveries.lastAt) })}</div></Fact>}
        {scans.bodies > 0 && <Fact name={t('sysOv.factScans')}>{number(locale, scans.bodies)}<div style={muted}>{t('sysOv.scansUpdated', { when: when(locale, scans.updatedAt) })}</div></Fact>}
        <Fact name={t('sysOv.factRatings')}><Link href="/leaderboard" style={{ color: 'var(--cyan)' }}>{t('sysOv.leaderboard')}</Link></Fact>
      </div>
      {goals.map((goal) => (
        <div key={goal.id} style={row}>
          <span>
            <Link href="/cg" style={{ color: 'var(--text)' }}>{goal.title}</Link>
            <span style={muted}>{goal.station ? ` · ${goal.station}` : ''}{goal.colonisation ? t('sysOv.goalColonisation') : ''}</span>
          </span>
          <span style={{ ...muted, fontFamily: mono }}>
            {goal.complete ? t('sysOv.goalComplete') : t('sysOv.goalTier', { tier: goal.tier ?? '—', max: goal.tierMax ?? '—', when: when(locale, goal.expiresAt) })}
          </span>
        </div>
      ))}
    </Section>
  );
}

function FreshnessSection({ overview }: { overview: SystemOverview }) {
  const { t, locale } = useI18n();
  if (!overview.freshness.length && !overview.warnings.length) return null;
  return (
    <Section icon={<IconDatabase size={18} />} title={t('sysOv.sourcesTitle')}>
      <div style={grid}>
        {overview.freshness.map((item) => (
          <Fact key={item.source} name={item.label}>{when(locale, item.at)}</Fact>
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
