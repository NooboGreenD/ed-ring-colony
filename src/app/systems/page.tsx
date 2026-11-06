'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { toast } from '@/components/ui/Toaster';
import { IconRocket, IconRingPlanet, IconGlobe, IconChevronUp, IconChevronDown, IconSearch, IconCheck, IconMapPin, IconSun, IconLock, IconExternalLink } from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';

type Resource = {
  name: string;
  key?: string;
  required?: number | null;
  provided?: number | null;
  remaining?: number;
  exact?: boolean;
};
type Project = {
  buildId: string;
  buildName: string;
  buildType: string | null;
  complete: boolean;
  progress: number;
  bodyName: string | null;
  totalRequired?: number | null;
  totalProvided?: number | null;
  totalRemaining?: number;
  resources: Resource[];
};
type DeliveryStat = { system_name: string; total_delivered: number; unique_cmdrs: number; top_commodity: string };
type ProgressRow = {
  system_name: string;
  hub_name?: string;
  status?: string;
  progress: number | null;
  updated_at: string | null;
  found?: boolean;
  error?: string;
  siteName?: string | null;
  architectName?: string | null;
  projects?: Project[];
  resources?: Resource[];
  totalRequired?: number | null;
  totalProvided?: number | null;
  totalRemaining?: number;
  data?: {
    siteName?: string | null;
    architectName?: string | null;
    projects?: Project[];
    resources?: Resource[];
    totalRequired?: number | null;
    totalProvided?: number | null;
    totalRemaining?: number;
  } | null;
};

/* ── EDSM Types ── */
type EdsmSystem = {
  id: number;
  name: string;
  coords: { x: number; y: number; z: number } | null;
  distance: number | null;
  bodyCount: number | null;
  requirePermit: boolean;
  permitName: string | null;
  starLabel?: string | null;
};

type EdsmStar = {
  id: number;
  name: string;
  bodyId: number;
  type: string;
  subType: string;
  spectralClass?: string;
  luminosity?: string;
  absoluteMagnitude?: number;
  solarMasses?: number;
  solarRadius?: number;
  age?: number;
  surfaceTemperature?: number;
  distanceToArrival?: number;
  belts?: any[];
  parents?: any[];
};

type EdsmPlanet = {
  id: number;
  name: string;
  bodyId: number;
  type: string;
  subType: string;
  distanceToArrival?: number;
  isLandable?: boolean;
  gravity?: number;
  earthMasses?: number;
  radius?: number;
  surfaceTemperature?: number;
  surfacePressure?: number;
  volcanismType?: string;
  atmosphereType?: string;
  atmosphereComposition?: Record<string, number>;
  solidComposition?: Record<string, number>;
  terraformingState?: string;
  orbitalPeriod?: number;
  semiMajorAxis?: number;
  orbitalEccentricity?: number;
  orbitalInclination?: number;
  argOfPeriapsis?: number;
  rotationalPeriod?: number;
  rotationalPeriodTidallyLocked?: boolean;
  axialTilt?: number;
  materials?: Record<string, number>;
  rings?: any[];
  reserveLevel?: string;
  parents?: any[];
};

type EdsmSystemDetail = {
  name: string;
  id: number;
  id64: number | null;
  coords: { x: number; y: number; z: number } | null;
  distanceToSol: number | null;
  bodyCount: number | null;
  requirePermit: boolean;
  permitName: string | null;
  information: any;
  primaryStar: any;
  stars: EdsmStar[];
  planets: EdsmPlanet[];
  edsmUrl: string;
};

type Tab = 'hubs' | 'route' | 'deliveries' | 'search';

/* ── Body grouping helpers ── */
function sortByArrival<T extends { distanceToArrival?: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => (a.distanceToArrival ?? Infinity) - (b.distanceToArrival ?? Infinity));
}

function groupPlanetsByType(planets: EdsmPlanet[]): Record<string, EdsmPlanet[]> {
  const groups: Record<string, EdsmPlanet[]> = {};
  for (const p of planets) {
    const key = p.subType || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }
  // Sort each group by distance
  for (const k of Object.keys(groups)) {
    groups[k] = sortByArrival(groups[k]);
  }
  return groups;
}

function planetTypeColor(subType: string): string {
  const map: Record<string, string> = {
    'Earth-like world': '#22c55e',
    'Water world': '#3b82f6',
    'Ammonia world': '#a855f7',
    'Gas giant': '#e67e22',
    'Class I gas giant': '#f39c12',
    'Class II gas giant': '#f39c12',
    'Class III gas giant': '#d35400',
    'Class IV gas giant': '#d35400',
    'Class V gas giant': '#d35400',
    'Helium rich gas giant': '#e74c3c',
    'Helium gas giant': '#e74c3c',
    'High metal content world': '#60a5fa',
    'Metal-rich body': '#fbbf24',
    'Rocky body': '#9ca3af',
    'Rocky ice world': '#93c5fd',
    'Icy body': '#bfdbfe',
    'Ice world': '#bfdbfe',
  };
  for (const [k, v] of Object.entries(map)) {
    if (subType.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '#9ca3af';
}

function bodyStats(planets: EdsmPlanet[]) {
  const landable = planets.filter((p) => p.isLandable).length;
  const withRings = planets.filter((p) => p.rings && p.rings.length > 0).length;
  const withAtmo = planets.filter((p) => p.atmosphereType && p.atmosphereType !== 'No atmosphere').length;
  const terraformable = planets.filter((p) => p.terraformingState && p.terraformingState !== 'Not terraformable').length;
  return { landable, withRings, withAtmo, terraformable };
}

function PlanetCard({ planet }: { planet: EdsmPlanet }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const color = planetTypeColor(planet.subType);

  return (
    <div style={{
      background: '#1e2124',
      border: '1px solid #2d3033',
      borderLeft: `3px solid ${color}`,
      borderRadius: 6,
      padding: '10px 12px',
    }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: '#eeeeee', fontSize: 13 }}>{planet.name}</span>
          {planet.isLandable && (
            <span style={{
              fontSize: 10, color: '#22c55e',
              background: 'rgba(34,197,94,0.12)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              <IconRocket size={12} /> {t('sys.landableBadge')}
            </span>
          )}
          {planet.rings && planet.rings.length > 0 && (
            <span style={{
              fontSize: 10, color: '#fbbf24',
              background: 'rgba(251,191,36,0.12)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              <IconRingPlanet size={12} /> {t('sys.ringsBadge')}
            </span>
          )}
          {planet.terraformingState && planet.terraformingState !== 'Not terraformable' && (
            <span style={{
              fontSize: 10, color: '#3b82f6',
              background: 'rgba(59,130,246,0.12)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              <IconGlobe size={12} /> {planet.terraformingState}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
            {planet.distanceToArrival != null ? `${planet.distanceToArrival.toFixed(1)} ${t('sys.ls')}` : '—'}
          </span>
          <span style={{ fontSize: 11, color: '#6b7280' }}>{expanded ? <IconChevronUp size={10} /> : <IconChevronDown size={10} />}</span>
        </div>
      </div>

      {/* Quick stats row (always visible) */}
      <div style={{
        display: 'flex',
        gap: 16,
        marginTop: 6,
        flexWrap: 'wrap',
        fontSize: 11,
        color: '#9ca3af',
      }}>
        {planet.gravity != null && (
          <span>g: <strong style={{ color: '#eeeeee' }}>{planet.gravity.toFixed(2)}</strong></span>
        )}
        {planet.surfaceTemperature != null && (
          <span>{t('sys.shortT')} <strong style={{ color: '#eeeeee' }}>{planet.surfaceTemperature.toFixed(0)} K</strong></span>
        )}
        {planet.earthMasses != null && (
          <span>{t('sys.shortM')} <strong style={{ color: '#eeeeee' }}>{planet.earthMasses.toFixed(3)} M⊕</strong></span>
        )}
        {planet.radius != null && (
          <span>{t('sys.shortR')} <strong style={{ color: '#eeeeee' }}>{planet.radius.toFixed(0)} {t('sys.km')}</strong></span>
        )}
        {planet.atmosphereType && planet.atmosphereType !== 'No atmosphere' && (
          <span>{t('sys.shortAtm')} <strong style={{ color: '#eeeeee' }}>{planet.atmosphereType}</strong></span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #2d3033' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '4px 16px',
            fontSize: 12,
          }}>
            {planet.earthMasses != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.mass')}</span><span style={{ color: '#eeeeee' }}>{planet.earthMasses.toFixed(4)} M⊕</span></>
            )}
            {planet.radius != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.radius')}</span><span style={{ color: '#eeeeee' }}>{planet.radius.toFixed(1)} {t('sys.km')}</span></>
            )}
            {planet.gravity != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.gravity')}</span><span style={{ color: '#eeeeee' }}>{planet.gravity.toFixed(2)} g</span></>
            )}
            {planet.surfaceTemperature != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.temperature')}</span><span style={{ color: '#eeeeee' }}>{planet.surfaceTemperature.toFixed(1)} K</span></>
            )}
            {planet.surfacePressure != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.pressure')}</span><span style={{ color: '#eeeeee' }}>{planet.surfacePressure.toFixed(2)} {t('sys.atm')}</span></>
            )}
            {planet.distanceToArrival != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.distToArrival')}</span><span style={{ color: '#eeeeee' }}>{planet.distanceToArrival.toFixed(1)} {t('sys.ls')}</span></>
            )}
            {planet.orbitalPeriod != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.orbitalPeriod')}</span><span style={{ color: '#eeeeee' }}>{planet.orbitalPeriod.toFixed(2)} {t('sys.days')}</span></>
            )}
            {planet.semiMajorAxis != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.semiMajorAxis')}</span><span style={{ color: '#eeeeee' }}>{(planet.semiMajorAxis / 149597870.7).toFixed(3)} {t('sys.au')}</span></>
            )}
            {planet.orbitalEccentricity != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.eccentricity')}</span><span style={{ color: '#eeeeee' }}>{planet.orbitalEccentricity.toFixed(4)}</span></>
            )}
            {planet.orbitalInclination != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.inclination')}</span><span style={{ color: '#eeeeee' }}>{planet.orbitalInclination.toFixed(2)}°</span></>
            )}
            {planet.rotationalPeriod != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.rotationPeriod')}</span><span style={{ color: '#eeeeee' }}>{planet.rotationalPeriod.toFixed(2)} {t('sys.days')} {planet.rotationalPeriodTidallyLocked ? t('sys.tidallyLocked') : ''}</span></>
            )}
            {planet.axialTilt != null && (
              <><span style={{ color: '#6b7280' }}>{t('sys.axialTilt')}</span><span style={{ color: '#eeeeee' }}>{planet.axialTilt.toFixed(2)}°</span></>
            )}
          </div>

          {planet.atmosphereType && planet.atmosphereType !== 'No atmosphere' && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{t('sys.atmosphere')} </span>
              <span style={{ fontSize: 12, color: '#eeeeee' }}>{planet.atmosphereType}</span>
              {planet.atmosphereComposition && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {Object.entries(planet.atmosphereComposition)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`)
                    .join(', ')}
                </div>
              )}
            </div>
          )}

          {planet.volcanismType && planet.volcanismType !== 'No volcanism' && (
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{t('sys.volcanism')} </span>
              <span style={{ fontSize: 12, color: '#e74c3c' }}>{planet.volcanismType}</span>
            </div>
          )}

          {planet.materials && Object.keys(planet.materials).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{t('sys.materials')} </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 2 }}>
                {Object.entries(planet.materials)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <span key={k} style={{ fontSize: 11, color: '#9ca3af' }}>
                      {k} <strong style={{ color: '#eeeeee' }}>{(v * 100).toFixed(1)}%</strong>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {planet.rings && planet.rings.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{t('sys.ringsLabel')} </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                {planet.rings.map((ring: any, i: number) => (
                  <span key={i} style={{
                    fontSize: 11,
                    color: '#fbbf24',
                    background: 'rgba(251,191,36,0.1)',
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}>
                    {ring.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {planet.solidComposition && Object.keys(planet.solidComposition).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{t('sys.composition')} </span>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>
                {Object.entries(planet.solidComposition)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`)
                  .join(', ')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SystemsPage() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('search');
  const [hubs, setHubs] = useState<{ system_name: string; name: string; status: string }[]>([]);
  const [current, setCurrent] = useState('');
  const [info, setInfo] = useState<ProgressRow | null>(null);
  const [hubRows, setHubRows] = useState<ProgressRow[]>([]);
  const [routeRows, setRouteRows] = useState<ProgressRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingHubs, setLoadingHubs] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeQuery, setRouteQuery] = useState('');
  const [deliveryStats, setDeliveryStats] = useState<DeliveryStat[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);

  /* ── EDSM Search State ── */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EdsmSystem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSystem, setSelectedSystem] = useState<EdsmSystemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [searchSource, setSearchSource] = useState<'catalog' | 'edsm' | null>(null);

  useEffect(() => {
    const loadHubs = async () => {
      const { data } = await supabase
        .from('hubs')
        .select('system_name,name,status')
        .order('segment_order');
      setHubs(data ?? []);
    };
    loadHubs();
  }, []);

  useEffect(() => {
    setLoadingHubs(true);
    fetch('/api/systems/progress')
      .then((r) => r.json())
      .then((json) => setHubRows(Array.isArray(json.systems) ? json.systems : []))
      .catch(() => setHubRows([]))
      .finally(() => setLoadingHubs(false));
  }, []);

  useEffect(() => {
    setLoadingRoute(true);
    fetch('/api/systems/progress?scope=route')
      .then((r) => r.json())
      .then((json) => setRouteRows(Array.isArray(json.systems) ? json.systems : []))
      .catch(() => setRouteRows([]))
      .finally(() => setLoadingRoute(false));
  }, []);

  useEffect(() => {
    const loadStats = async () => {
      setLoadingDeliveries(true);
      try {
        const { data, error } = await supabase.rpc('get_route_delivery_stats');
        if (!error && Array.isArray(data)) setDeliveryStats(data);
        else setDeliveryStats([]);
      } catch {
        setDeliveryStats([]);
      } finally {
        setLoadingDeliveries(false);
      }
    };
    loadStats();
  }, []);

  const listRows = tab === 'hubs' ? hubRows : routeRows;

  useEffect(() => {
    if (!current) {
      setInfo(null);
      return;
    }
    const cached = listRows.find((r) => r.system_name === current);
    if (cached) setInfo(cached);
    setLoading(true);
    fetch('/api/systems/progress?name=' + encodeURIComponent(current))
      .then((r) => r.json())
      .then((data) => setInfo(data))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [current, listRows]);

  // A direct system lookup returns the Raven payload at the top level, while
  // list rows carry the cached payload under `data`. Support both shapes.
  const resources: Resource[] = Array.isArray(info?.resources)
    ? info.resources
    : Array.isArray(info?.data?.resources)
      ? info.data.resources
      : [];
  const projects: Project[] = Array.isArray(info?.projects)
    ? info.projects
    : Array.isArray(info?.data?.projects)
      ? info.data.projects
      : [];
  const totalRequired = info?.totalRequired ?? info?.data?.totalRequired ?? null;
  const totalProvided = info?.totalProvided ?? info?.data?.totalProvided ?? null;
  const totalRemaining = info?.totalRemaining ?? info?.data?.totalRemaining ?? 0;
  const systemProgress = typeof info?.progress === 'number' && Number.isFinite(info.progress)
    ? Math.min(100, Math.max(0, info.progress))
    : null;
  const siteName = info?.siteName ?? info?.data?.siteName ?? null;
  const architectName = info?.architectName ?? info?.data?.architectName ?? null;
  const hasExactAmounts = (resource: Resource): resource is Resource & { required: number; provided: number } =>
    resource.exact === true
    && typeof resource.required === 'number'
    && typeof resource.provided === 'number';
  const pct = (resource: Resource): number | null => {
    if (!hasExactAmounts(resource) || resource.required <= 0) return null;
    return Math.min(100, Math.round((resource.provided / resource.required) * 100));
  };

  const bySystem = useMemo(() => {
    const m = new Map<string, ProgressRow>();
    for (const r of listRows) m.set(r.system_name, r);
    return m;
  }, [listRows]);

  const filteredRoute = useMemo(() => {
    const q = routeQuery.trim().toLowerCase();
    if (!q) return routeRows;
    return routeRows.filter((r) => r.system_name.toLowerCase().includes(q));
  }, [routeRows, routeQuery]);

  const routeStats = useMemo(() => {
    const withPct = routeRows.filter((r) => r.progress != null);
    const avg =
      withPct.length > 0
        ? Math.round(
            (withPct.reduce((s, r) => s + (r.progress ?? 0), 0) / withPct.length) * 10,
          ) / 10
        : null;
    const done = withPct.filter((r) => (r.progress ?? 0) >= 100).length;
    return { avg, done, known: withPct.length };
  }, [routeRows]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setCurrent('');
    setInfo(null);
  };

  /* ── EDSM Search ── */
  const doSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q || q.length < 2) {
      toast?.(t('sys.errMinChars'), 'error');
      return;
    }
    setSearchLoading(true);
    setSelectedSystem(null);
    try {
      const local = await fetch(`/api/galaxy/systems/search?q=${encodeURIComponent(q)}&limit=20`);
      const localData = await local.json().catch(() => ({ results: [] }));
      if (local.ok && Array.isArray(localData.results) && localData.results.length > 0) {
        setSearchSource('catalog');
        setSearchResults(localData.results.map((row: any, index: number) => ({
          id: index + 1,
          name: row.name,
          coords: { x: Number(row.x), y: Number(row.y), z: Number(row.z) },
          distance: row.distance_from_sols ?? null,
          bodyCount: null,
          requirePermit: !!row.needs_permit,
          permitName: row.needs_permit ? 'Permit' : null,
          starLabel: row.main_star || row.star_type || null,
        })));
        setSearchHistory((prev) => [q, ...prev.filter((h) => h !== q)].slice(0, 10));
        return;
      }
      setSearchSource('edsm');
      const res = await fetch(`/api/edsm/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) {
        toast?.(data.error || t('sys.errSearch'), 'error');
        setSearchResults([]);
        return;
      }
      setSearchResults(data.systems || []);
      setSearchHistory((prev) => {
        const next = [q, ...prev.filter((h) => h !== q)].slice(0, 10);
        return next;
      });
    } catch (err: any) {
      toast?.(err.message || t('sys.errSearch'), 'error');
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const loadSystemDetail = useCallback(async (name: string) => {
    setDetailLoading(true);
    setSelectedSystem(null);
    try {
      const url = `/api/edsm/system?name=${encodeURIComponent(name)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) {
        const msg = data.error || t('sys.errLoadSystem', { status: res.status });
        toast(msg, 'error');
        // Fallback: show basic info from search results
        const basic = searchResults.find((s) => s.name === name);
        if (basic) {
          setSelectedSystem({
            name: basic.name,
            id: basic.id,
            id64: null,
            coords: basic.coords,
            distanceToSol: basic.distance ?? null,
            bodyCount: basic.bodyCount,
            requirePermit: basic.requirePermit,
            permitName: basic.permitName,
            information: null,
            primaryStar: null,
            stars: [],
            planets: [],
            edsmUrl: `https://www.edsm.net/en/system/id/${basic.id}/name/${encodeURIComponent(basic.name)}`,
          } as EdsmSystemDetail);
        }
        return;
      }
      setSelectedSystem(data);
    } catch (err: any) {
      toast(err.message || t('sys.errLoad'), 'error');
      // Fallback: show basic info from search results
      const basic = searchResults.find((s) => s.name === name);
      if (basic) {
        setSelectedSystem({
          name: basic.name,
          id: basic.id,
          id64: null,
          coords: basic.coords,
          distanceToSol: basic.distance ?? null,
          bodyCount: basic.bodyCount,
          requirePermit: basic.requirePermit,
          permitName: basic.permitName,
          information: null,
          primaryStar: null,
          stars: [],
          planets: [],
          edsmUrl: `https://www.edsm.net/en/system/id/${basic.id}/name/${encodeURIComponent(basic.name)}`,
        } as EdsmSystemDetail);
      }
    } finally {
      setDetailLoading(false);
    }
  }, [searchResults]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') doSearch();
  };

  return (
    <main className="card" style={{ width: "100%" }}>
      <h1>{t('sys.title')}</h1>
      <p style={{ color: '#9ca3af', fontSize: 14 }}>
        {t('sys.introBefore')}{' '}
        <a href="https://ravencolonial.com" target="_blank" rel="noreferrer" style={{ color: '#e67e22' }}>
          Raven Colonial
        </a>
        {t('sys.introBetween')}{' '}
        <a href="https://www.edsm.net" target="_blank" rel="noreferrer" style={{ color: '#e67e22' }}>
          EDSM
        </a>
        {t('sys.introAfter')}
      </p>

      <div className="tabs">
        <button className={tab === 'search' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('search')}>
          <IconSearch size={14} /> {t('sys.tabSearch')}
        </button>
        <button className={tab === 'hubs' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('hubs')}>
          {t('sys.tabHubs')}
        </button>
        <button className={tab === 'route' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('route')}>
          {t('sys.tabRoute')} ({routeRows.length})
        </button>
        <button className={tab === 'deliveries' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('deliveries')}>
          {t('sys.tabDeliveries')}
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          TAB: EDSM Search
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'search' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              style={{ flex: 1, minWidth: 200 }}
              placeholder={t('sys.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <button
              onClick={doSearch}
              disabled={searchLoading || searchQuery.trim().length < 2}
              className="btn btn-cyan"
            >
              {searchLoading ? t('sys.searching') : t('sys.find')}
            </button>
          </div>

          {searchHistory.length > 0 && (
            <div style={{ marginBottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>{t('sys.history')}</span>
              {searchHistory.map((h) => (
                <button
                  key={h}
                  onClick={() => { setSearchQuery(h); }}
                  style={{
                    fontSize: 11,
                    padding: '3px 10px',
                    background: '#2d3033',
                    border: '1px solid #3a3d40',
                    borderRadius: 4,
                    color: '#9ca3af',
                    cursor: 'pointer',
                  }}
                >
                  {h}
                </button>
              ))}
            </div>
          )}

          {/* Результаты поиска */}
          {searchResults.length > 0 && !selectedSystem && (
            <div className="table-scroll" style={{ marginBottom: 20 }}>
              <table>
                <thead>
                  <tr>
                    <th>{t('sys.colSystem')}</th>
                    <th>{t('sys.colCoords')}</th>
                    <th>{t('sys.colToSol')}</th>
                    <th>{t('sys.colBodies')}</th>
                    <th>{t('sys.colPermit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => loadSystemDetail(s.name)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <span style={{ color: '#eeeeee', fontWeight: 600 }}>{s.name}</span>
                      </td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                        {s.coords
                          ? `${s.coords.x.toFixed(2)}, ${s.coords.y.toFixed(2)}, ${s.coords.z.toFixed(2)}`
                          : '—'}
                      </td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                        {s.distance != null ? `${s.distance.toFixed(2)} ${t('sys.ly')}` : '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {s.bodyCount ?? s.starLabel ?? '—'}
                      </td>
                      <td>
                        {s.requirePermit ? (
                          <span style={{ color: '#e74c3c', fontSize: 12 }}>⚠ {s.permitName || t('sys.permitRequired')}</span>
                        ) : (
                          <span style={{ color: '#22c55e', fontSize: 12 }}><IconCheck size={12} color='#22c55e' /> {t('sys.no')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                {t('sys.found', { count: searchResults.length })}
                {searchSource === 'catalog' ? t('sys.foundInCatalog') : searchSource === 'edsm' ? t('sys.foundInEdsm') : ''}.
                {t('sys.clickRow')}
              </p>
            </div>
          )}

          {searchResults.length === 0 && !searchLoading && searchQuery.trim().length >= 2 && (
            <p style={{ color: '#9ca3af' }}>{t('sys.nothingFound')}</p>
          )}

          {/* Детальная карточка системы */}
          {detailLoading && (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{
                width: 32, height: 32,
                border: '3px solid #3a3d40',
                borderTop: '3px solid #e67e22',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
                margin: '0 auto 12px',
              }} />
              {t('sys.loadingSystem')}
            </div>
          )}

          {selectedSystem && (
            <div>
              {/* Навигация назад */}
              <button
                onClick={() => setSelectedSystem(null)}
                style={{ fontSize: 12, marginBottom: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                {t('sys.backToResults')}
              </button>

              {/* Заголовок системы */}
              <div style={{
                background: '#1e2124',
                border: '1px solid #2d3033',
                borderRadius: 8,
                padding: 16,
                marginBottom: 16,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h2 style={{ margin: 0, color: '#eeeeee', fontSize: 22 }}>{selectedSystem.name}</h2>
                    <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                      {selectedSystem.coords && (
                        <span style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
                          <IconMapPin size={12} /> {selectedSystem.coords.x.toFixed(2)}, {selectedSystem.coords.y.toFixed(2)}, {selectedSystem.coords.z.toFixed(2)}
                        </span>
                      )}
                      {selectedSystem.distanceToSol != null && (
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>
                          <IconSun size={12} /> {t('sys.toSol')} <strong style={{ color: '#e67e22' }}>{selectedSystem.distanceToSol.toLocaleString(locale)} {t('sys.ly')}</strong>
                        </span>
                      )}
                      {selectedSystem.bodyCount != null && (
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>
                          🪐 {t('sys.bodies')} <strong style={{ color: '#eeeeee' }}>{selectedSystem.bodyCount}</strong>
                        </span>
                      )}
                      {selectedSystem.requirePermit && (
                        <span style={{ fontSize: 12, color: '#e74c3c' }}>
                          <IconLock size={12} /> {t('sys.permitLabel')} {selectedSystem.permitName || t('sys.permitRequired')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <a
                      href={`/system/${encodeURIComponent(selectedSystem.name)}`}
                      className="btn btn-orange"
                      style={{ fontSize: 11, padding: '6px 14px' }}
                    >
                      {t('sys.card')}
                    </a>
                    <a
                      href={selectedSystem.edsmUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-cyan"
                      style={{ fontSize: 11, padding: '6px 14px' }}
                    >
                      EDSM <IconExternalLink size={10} />
                    </a>
                    <a
                      href={`https://ravencolonial.com/#sys=${encodeURIComponent(selectedSystem.name)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-orange"
                      style={{ fontSize: 11, padding: '6px 14px' }}
                    >
                      RavenColonial <IconExternalLink size={10} />
                    </a>
                  </div>
                </div>
              </div>

              {/* ── System Summary ── */}
              {(selectedSystem.stars.length > 0 || selectedSystem.planets.length > 0) && (
                <div style={{
                  background: '#1e2124',
                  border: '1px solid #2d3033',
                  borderRadius: 8,
                  padding: 14,
                  marginBottom: 16,
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                }}>
                  <div style={{ textAlign: 'center', minWidth: 80 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#f39c12' }}>{selectedSystem.stars.length}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{t('sys.starsCount')}</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: 80 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#60a5fa' }}>{selectedSystem.planets.length}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>{t('sys.planetsBodies')}</div>
                  </div>
                  {(() => {
                    const stats = bodyStats(selectedSystem.planets);
                    return (
                      <>
                        {stats.landable > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#22c55e' }}>{stats.landable}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{t('sys.landableCount')}</div>
                          </div>
                        )}
                        {stats.withAtmo > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#a855f7' }}>{stats.withAtmo}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{t('sys.withAtmosphere')}</div>
                          </div>
                        )}
                        {stats.withRings > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#fbbf24' }}>{stats.withRings}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{t('sys.withRings')}</div>
                          </div>
                        )}
                        {stats.terraformable > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#3b82f6' }}>{stats.terraformable}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{t('sys.terraformable')}</div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* ── Stars Table ── */}
              {selectedSystem.stars.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', color: '#f39c12', margin: '0 0 10px 0' }}>
                    {t('sys.starsSection', { count: selectedSystem.stars.length })}
                  </h3>
                  <div className="table-scroll">
                    <table style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>{t('sys.colName')}</th>
                          <th>{t('sys.colClass')}</th>
                          <th>{t('sys.colMassSun')}<IconSun size={12} /></th>
                          <th>{t('sys.colRadiusSun')}<IconSun size={12} /></th>
                          <th>{t('sys.colTempK')}</th>
                          <th>{t('sys.colAge')}</th>
                          <th>{t('sys.colDistToArrival')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortByArrival(selectedSystem.stars).map((star) => (
                          <tr key={star.id}>
                            <td style={{ fontWeight: 600, color: '#eeeeee' }}>{star.name}</td>
                            <td>
                              <span style={{
                                color: '#f39c12',
                                background: 'rgba(243,156,18,0.12)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                fontSize: 11,
                              }}>
                                {star.spectralClass || '—'}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.solarMasses?.toFixed(3) ?? '—'}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.solarRadius?.toFixed(3) ?? '—'}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.surfaceTemperature?.toLocaleString(locale) ?? '—'}</td>
                            <td>{star.age != null ? `${star.age.toFixed(1)} ${t('sys.bn')}` : '—'}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.distanceToArrival?.toFixed(1) ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Planets by Type ── */}
              {selectedSystem.planets.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', color: '#60a5fa', margin: '0 0 10px 0' }}>
                    {t('sys.planetsSection', { count: selectedSystem.planets.length })}
                  </h3>
                  {(() => {
                    const groups = groupPlanetsByType(selectedSystem.planets);
                    const groupKeys = Object.keys(groups).sort();
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {groupKeys.map((typeName) => {
                          const planets = groups[typeName];
                          const color = planetTypeColor(typeName);
                          return (
                            <div key={typeName}>
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginBottom: 8,
                              }}>
                                <span style={{
                                  width: 10, height: 10, borderRadius: '50%',
                                  background: color,
                                  display: 'inline-block',
                                }} />
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#eeeeee' }}>
                                  {typeName}
                                </span>
                                <span style={{ fontSize: 11, color: '#6b7280' }}>({planets.length})</span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {planets.map((planet) => (
                                  <PlanetCard key={planet.id} planet={planet} />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}

              {selectedSystem.stars.length === 0 && selectedSystem.planets.length === 0 && (
                <p style={{ color: '#9ca3af', textAlign: 'center', padding: 20 }}>
                  {t('sys.noBodies')}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: Hubs
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'hubs' && (
        <>
          {loadingHubs && <p>{t('sys.loadingHubs')}</p>}
          {hubs.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{t('sys.colHub')}</th>
                  <th>{t('sys.colSystem')}</th>
                  <th>{t('sys.colStatus')}</th>
                  <th>{t('sys.colProgress')}</th>
                </tr>
              </thead>
              <tbody>
                {hubs.map((h) => {
                  const row = bySystem.get(h.system_name);
                  const p = row?.progress;
                  return (
                    <tr
                      key={h.system_name}
                      onClick={() => setCurrent(h.system_name)}
                      style={{
                        cursor: 'pointer',
                        background: current === h.system_name ? 'rgba(255,157,46,0.12)' : undefined,
                      }}
                    >
                      <td>{h.name}</td>
                      <td>
                        <a
                          href={`https://ravencolonial.com/#sys=${encodeURIComponent(h.system_name)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#e67e22", textDecoration: "none" }}
                          title={t('sys.openInRaven')}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {h.system_name} <IconExternalLink size={10} />
                        </a>
                      </td>
                      <td>{h.status}</td>
                      <td>{p == null ? (row && !row.found ? t('sys.noData') : '…') : p + '%'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <select value={current} onChange={(e) => setCurrent(e.target.value)} style={{ marginTop: 16 }}>
            <option value="">{t('sys.chooseSystem')}</option>
            {hubs.map((h) => (
              <option key={h.system_name} value={h.system_name}>
                {h.name} ({h.system_name})
              </option>
            ))}
          </select>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: Route
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'route' && (
        <>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>
            {t('sys.routeHint')}
          </p>
          {loadingRoute && <p>{t('sys.loadingRoute')}</p>}
          <p style={{ color: '#9ca3af', fontSize: 13 }}>
            {t('sys.total', { count: routeRows.length })}
            {routeStats.known > 0 ? t('sys.withData', { count: routeStats.known }) : ''}
            {routeStats.done > 0 ? t('sys.doneCount', { count: routeStats.done }) : ''}
            {routeStats.avg != null ? t('sys.avgProgress', { value: routeStats.avg }) : ''}
          </p>
          <input
            style={{ width: '100%', maxWidth: 420 }}
            placeholder={t('sys.searchByName')}
            value={routeQuery}
            onChange={(e) => setRouteQuery(e.target.value)}
          />
          {filteredRoute.length === 0 && !loadingRoute ? (
            <p>{t('sys.listEmpty')}</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{t('sys.colSystem')}</th>
                    <th>{t('sys.colProgress')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoute.map((r) => {
                    const p = r.progress;
                    const n = routeRows.findIndex((x) => x.system_name === r.system_name) + 1;
                    return (
                      <tr
                        key={r.system_name}
                        onClick={() => setCurrent(r.system_name)}
                        style={{
                          cursor: 'pointer',
                          background: current === r.system_name ? 'rgba(255,157,46,0.12)' : undefined,
                        }}
                      >
                        <td>{n}</td>
                        <td>
                          <a
                            href={`https://ravencolonial.com/#sys=${encodeURIComponent(r.system_name)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#e67e22", textDecoration: "none" }}
                            title={t('sys.openInRaven')}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.system_name} <IconExternalLink size={10} />
                          </a>
                        </td>
                        <td>{p == null ? t('sys.noData') : p + '%'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: Deliveries
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'deliveries' && (
        <>
          <h3>{t('sys.deliveriesTitle')}</h3>
          {loadingDeliveries && <p>{t('sys.loadingStats')}</p>}
          {deliveryStats.length === 0 && !loadingDeliveries ? (
            <p>{t('sys.noDeliveries')}</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('sys.colSystem')}</th>
                    <th>{t('sys.colTons')}</th>
                    <th>{t('sys.colPilots')}</th>
                    <th>{t('sys.colTopCommodity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveryStats.map((s) => (
                    <tr key={s.system_name}>
                      <td>
                        <a
                          href={`https://ravencolonial.com/#sys=${encodeURIComponent(s.system_name)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#e67e22", textDecoration: "none" }}
                        >
                          {s.system_name} <IconExternalLink size={10} />
                        </a>
                      </td>
                      <td>{Number(s.total_delivered).toLocaleString(locale)}</td>
                      <td>{s.unique_cmdrs}</td>
                      <td>{s.top_commodity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          Detail panel for Hubs / Route tabs
         ═══════════════════════════════════════════════════════════ */}
      {!current && tab !== 'deliveries' && tab !== 'search' && <p>{t('sys.chooseForBuild')}</p>}
      {current && loading && !info && <p>{t('sys.loading')}</p>}
      {info && tab !== 'deliveries' && tab !== 'search' && (
        <div>
          <h2>
            {info.system_name}
            {siteName ? ' — ' + siteName : ''}
          </h2>
          {architectName && (
            <p style={{ color: '#9ca3af' }}>{t('sys.architect', { name: architectName })}</p>
          )}
          {info.error && <p style={{ color: '#e74c3c' }}>{info.error}</p>}
          <div style={{ background: '#323538', borderRadius: 8, height: 22 }}>
            <div
              style={{
                width: systemProgress == null ? '100%' : systemProgress + '%',
                background: systemProgress == null ? '#3a3d40' : '#22c55e',
                height: '100%',
                borderRadius: 8,
                transition: 'width 0.5s',
                textAlign: 'center',
                color: systemProgress == null ? '#9ca3af' : '#052e16',
                fontSize: 13,
                lineHeight: '22px',
                fontWeight: 700,
              }}
            >
              {systemProgress == null ? '—' : `${systemProgress}%`}
            </div>
          </div>
          {typeof totalRequired === 'number' && typeof totalProvided === 'number' && (
            <p style={{ color: '#d1d5db', fontSize: 13 }}>
              {t('sys.delivered')} <strong>{totalProvided.toLocaleString(locale)} / {totalRequired.toLocaleString(locale)} {t('sys.tons')}</strong>
              {' · '}{t('sys.remaining')} {Number(totalRemaining).toLocaleString(locale)} {t('sys.tons')}
            </p>
          )}
          {info.updated_at && (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>
              {t('sys.updatedSource', { when: new Date(info.updated_at).toLocaleString(locale) })}
            </p>
          )}

          {projects.length > 1 && (
            <>
              <h3>{t('sys.sites')}</h3>
              <table>
                <thead>
                  <tr>
                    <th>{t('sys.colName')}</th>
                    <th>{t('sys.colType')}</th>
                    <th>{t('sys.colBody')}</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.buildId || p.buildName}>
                      <td>{p.buildName}</td>
                      <td>{p.buildType ?? '—'}</td>
                      <td>{p.bodyName ?? '—'}</td>
                      <td>{p.complete ? t('sys.ready') : typeof p.progress === 'number' ? `${p.progress}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {resources.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>{t('sys.colResource')}</th>
                  <th>{t('sys.colDelivered')}</th>
                  <th>{t('sys.colNeeded')}</th>
                  <th>{t('sys.colRemaining')}</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((resource) => {
                  const exact = hasExactAmounts(resource);
                  const progress = pct(resource);
                  return (
                    <tr key={resource.key || resource.name}>
                      <td>{resource.name}</td>
                      <td>{exact ? resource.provided.toLocaleString(locale) : '—'}</td>
                      <td>{exact ? resource.required.toLocaleString(locale) : '—'}</td>
                      <td>{Number(resource.remaining ?? 0).toLocaleString(locale)}</td>
                      <td>{progress == null ? '—' : `${progress}%`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            current &&
            !loading && (
              <p>
                {t('sys.noResources')}
              </p>
            )
          )}
        </div>
      )}
    </main>
  );
}


