'use client';

import { useEffect, useState } from 'react';
import AtlasRouteFinder from './AtlasRouteFinder';
import { fromSlef } from '@/lib/outfitting/exchange';
import { issueText } from '@/lib/i18n/exchangeText';
import { computeStats } from '@/lib/outfitting/calc';
import { profileAt } from '@/lib/outfitting/analysis';
import type { OutfittingData } from '@/lib/outfitting/types';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';
import { useI18n } from '@/lib/i18n/I18nContext';

type ShipStateResponse = {
  state: null | {
    loadout: Record<string, any> | null;
    current_system: string | null;
    fuel_level: number | null;
    cargo_count: number | null;
    received_at: string;
    loadout_at: string | null;
  };
};

type PlannerState =
  | { status: 'loading'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; from: string; range: number; description: string; issues: string[] };

export default function AtlasShipRouteFinder({ initialTo = '', onRouteFound }: { initialTo?: string; onRouteFound: (route: RoutePoint[]) => void }) {
  const { t, locale } = useI18n();
  const [planner, setPlanner] = useState<PlannerState>({ status: 'loading', message: t('atlas.ui.shipLoading') });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [stateResponse, catalogResponse] = await Promise.all([
          fetch('/api/cmdr/ship-state', { cache: 'no-store' }),
          fetch('/data/outfitting.json', { cache: 'force-cache' }),
        ]);
        const stateData = await stateResponse.json().catch(() => ({})) as ShipStateResponse & { error?: string };
        if (!stateResponse.ok) throw new Error(stateResponse.status === 401
          ? t('atlas.ui.shipSignIn')
          : stateData.error || t('atlas.ui.shipStateError'));
        if (!catalogResponse.ok) throw new Error(t('atlas.ui.shipyardError'));
        const data = await catalogResponse.json() as OutfittingData;
        const state = stateData.state;
        if (!state?.loadout) throw new Error(t('atlas.ui.shipNoLoadout'));
        const imported = fromSlef(data, state.loadout, { strict: true });
        if (!imported.build) throw new Error(imported.issues.map((issue) => issueText(issue, locale)).join('; ') || t('atlas.ui.shipBuildError'));
        const stats = computeStats(data, imported.build);
        const cargo = Math.max(0, Number(state.cargo_count) || 0);
        const fuel = Math.max(0, Number(state.fuel_level) || 0);
        const profile = profileAt(data, imported.build, stats, cargo, fuel);
        if (!(profile.jumpRange > 0)) throw new Error(t('atlas.ui.shipRangeError'));
        const unknownIssues = imported.issues.filter((issue) => issue.level !== 'error').map((issue) => issueText(issue, locale));
        if (unknownIssues.length > 0) {
          throw new Error(t('atlas.ui.shipUnknownLoadout', { issues: unknownIssues.slice(0, 5).join(' · ') }));
        }
        const shipName = data.ships[imported.build.ship]?.properties.name || imported.build.ship;
        const loadoutDate = state.loadout_at ? new Date(state.loadout_at) : null;
        const dateLabel = loadoutDate && Number.isFinite(loadoutDate.getTime())
          ? loadoutDate.toLocaleString(locale)
          : t('atlas.ui.timeUnknown');
        const description = t('atlas.ui.shipDescription', {
          ship: shipName,
          range: profile.jumpRange.toFixed(2),
          fuel: fuel.toFixed(1),
          cargo,
          date: dateLabel,
        });
        if (!cancelled) setPlanner({
          status: 'ready',
          from: state.current_system || '',
          range: profile.jumpRange,
          description,
          issues: unknownIssues.slice(0, 8),
        });
      } catch (error) {
        if (!cancelled) setPlanner({ status: 'error', message: error instanceof Error ? error.message : t('atlas.ui.shipReadError') });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [t, locale]);

  if (planner.status === 'loading') return <div className="atlas-search-panel"><h3>{t('atlas.tabShip')}</h3><p className="atlas-muted">{planner.message}</p></div>;
  if (planner.status === 'error') return <div className="atlas-search-panel"><h3>{t('atlas.tabShip')}</h3><p className="atlas-warning">{planner.message}</p><p className="atlas-muted">{t('atlas.ui.shipCheckHint')}</p></div>;

  return <AtlasRouteFinder
    key={`${planner.from}|${initialTo}|${planner.range.toFixed(3)}`}
    onRouteFound={onRouteFound}
    mode="ship"
    initialFrom={planner.from}
    initialTo={initialTo}
    maxJumpRange={planner.range}
    rangeDescription={planner.description}
    rangeIssues={planner.issues}
  />;
}
