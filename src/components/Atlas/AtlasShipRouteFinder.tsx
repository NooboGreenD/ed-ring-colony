'use client';

import { useEffect, useState } from 'react';
import AtlasRouteFinder from './AtlasRouteFinder';
import { fromSlef } from '@/lib/outfitting/exchange';
import { computeStats } from '@/lib/outfitting/calc';
import { profileAt } from '@/lib/outfitting/analysis';
import type { OutfittingData } from '@/lib/outfitting/types';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';

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
  const [planner, setPlanner] = useState<PlannerState>({ status: 'loading', message: 'Загружаем состояние корабля Colonial Helper…' });

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
          ? 'Войдите на сайт, чтобы использовать синхронизированный корабль Helper.'
          : stateData.error || 'Не удалось загрузить состояние корабля.');
        if (!catalogResponse.ok) throw new Error('Не удалось загрузить каталог верфи.');
        const data = await catalogResponse.json() as OutfittingData;
        const state = stateData.state;
        if (!state?.loadout) throw new Error('Colonial Helper ещё не передал игровой Loadout. Запустите Helper и войдите в игру, чтобы он синхронизировал корабль.');
        const imported = fromSlef(data, state.loadout, { strict: true });
        if (!imported.build) throw new Error(imported.issues.map((issue) => issue.text).join('; ') || 'Не удалось распознать игровую сборку.');
        const stats = computeStats(data, imported.build);
        const cargo = Math.max(0, Number(state.cargo_count) || 0);
        const fuel = Math.max(0, Number(state.fuel_level) || 0);
        const profile = profileAt(data, imported.build, stats, cargo, fuel);
        if (!(profile.jumpRange > 0)) throw new Error('Не удалось рассчитать дальность. Проверьте, что на корабле установлен FSD и есть топливо.');
        const unknownIssues = imported.issues.filter((issue) => issue.level !== 'error').map((issue) => issue.text);
        if (unknownIssues.length > 0) {
          throw new Error(`Не могу безопасно построить маршрут: часть Loadout не распознана, и масса сборки будет неполной. ${unknownIssues.slice(0, 5).join(' · ')}`);
        }
        const shipName = data.ships[imported.build.ship]?.properties.name || imported.build.ship;
        const loadoutDate = state.loadout_at ? new Date(state.loadout_at) : null;
        const dateLabel = loadoutDate && Number.isFinite(loadoutDate.getTime()) ? loadoutDate.toLocaleString() : 'время неизвестно';
        const description = `${shipName} · ${profile.jumpRange.toFixed(2)} св. л. при ${fuel.toFixed(1)} т топлива и ${cargo} т груза · Loadout ${dateLabel}`;
        if (!cancelled) setPlanner({
          status: 'ready',
          from: state.current_system || '',
          range: profile.jumpRange,
          description,
          issues: unknownIssues.slice(0, 8),
        });
      } catch (error) {
        if (!cancelled) setPlanner({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось прочитать состояние корабля.' });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (planner.status === 'loading') return <div className="atlas-search-panel"><h3>Маршрут корабля</h3><p className="atlas-muted">{planner.message}</p></div>;
  if (planner.status === 'error') return <div className="atlas-search-panel"><h3>Маршрут корабля</h3><p className="atlas-warning">{planner.message}</p><p className="atlas-muted">Проверьте соединение Colonial Helper с сайтом и обновите состояние корабля после события Loadout в игровом журнале.</p></div>;

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
