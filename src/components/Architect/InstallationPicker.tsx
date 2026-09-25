'use client';

import { useMemo, useState } from 'react';
import {
  BUILD_CLASS_LABELS_RU,
  PAD_LABELS_RU,
  PRE_REQS,
} from '@/lib/architect/catalogue';
import {
  commodityLabel,
  formatTons,
  getInstallation,
  listInstallations,
  placementCheck,
  predictSurfaceSlots,
} from '@/lib/architect/planner';
import type {
  ArchitectBody,
  ArchitectInstallation,
  ArchitectPlan,
} from '@/lib/architect/types';

interface InstallationPickerProps {
  body: ArchitectBody;
  plan: ArchitectPlan;
  onPick: (installationId: string) => void;
  onClose: () => void;
}

type LocationFilter = 'any' | 'orbital' | 'surface';
type TierFilter = 0 | 1 | 2 | 3;

const TIER_LABELS: Record<TierFilter, string> = { 0: 'все тиры', 1: 'T1', 2: 'T2', 3: 'T3' };

export default function InstallationPicker({ body, plan, onPick, onClose }: InstallationPickerProps) {
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState<LocationFilter>('any');
  const [tier, setTier] = useState<TierFilter>(0);
  const [expanded, setExpanded] = useState<string>('');

  const surfaceLimit = predictSurfaceSlots(body);
  const usedSurface = plan.sites.filter(
    (site) => site.bodyName === body.name && getInstallation(site.installationId)?.location === 'surface',
  ).length;

  const rows = useMemo(() => {
    const filtered = listInstallations({
      location: location === 'any' ? undefined : location,
      tier: tier === 0 ? undefined : tier,
      query,
    });
    // План без тела считаем «пустым»: проверка показывает, что именно мешает.
    const checked = filtered.map((installation) => ({
      installation,
      check: placementCheck(body, installation.id, plan),
    }));
    return checked.sort((left, right) => {
      if (left.check.ok !== right.check.ok) return left.check.ok ? -1 : 1;
      return right.installation.score - left.installation.score || left.installation.nameRu.localeCompare(right.installation.nameRu);
    });
  }, [body, plan, query, location, tier]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(920px, 100%)', maxHeight: '88vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 4,
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                Выбор постройки
              </div>
              <div style={{ fontSize: 18, color: 'var(--text)' }}>{body.name}</div>
            </div>
            <button type="button" onClick={onClose} style={buttonStyle}>Закрыть</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            {body.subType}
            {body.kind === 'planet' || body.kind === 'moon' ? (
              <>
                {' · '}
                {surfaceLimit > 0
                  ? `наземных слотов: ${usedSurface} из ${surfaceLimit}`
                  : 'наземных слотов нет'}
              </>
            ) : ' · звезда: только орбитальные постройки'}
          </div>
        </div>

        <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск: порт, ферма, consus…"
            style={{ ...inputStyle, flex: '1 1 220px' }}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            {(['any', 'orbital', 'surface'] as LocationFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setLocation(value)}
                style={{ ...chipStyle, ...(location === value ? chipActive : {}) }}
              >
                {value === 'any' ? 'всё' : value === 'orbital' ? 'орбита' : 'поверхность'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {([0, 1, 2, 3] as TierFilter[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTier(value)}
                style={{ ...chipStyle, ...(tier === value ? chipActive : {}) }}
              >
                {TIER_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 12px 16px' }}>
          {rows.length === 0 && (
            <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>Ничего не найдено.</div>
          )}
          {rows.map(({ installation, check }) => (
            <PickerRow
              key={installation.id}
              installation={installation}
              errors={check.errors}
              warnings={check.warnings}
              expanded={expanded === installation.id}
              onToggle={() => setExpanded(expanded === installation.id ? '' : installation.id)}
              onPick={() => onPick(installation.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function PickerRow({
  installation,
  errors,
  warnings,
  expanded,
  onToggle,
  onPick,
}: {
  installation: ArchitectInstallation;
  errors: string[];
  warnings: string[];
  expanded: boolean;
  onToggle: () => void;
  onPick: () => void;
}) {
  const preReq = installation.preReq ? PRE_REQS[installation.preReq] : null;
  const cargo = Object.entries(installation.cargo).sort((left, right) => right[1] - left[1]);

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, marginBottom: 6, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px' }}>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Подробности"
          style={{ ...buttonStyle, padding: '2px 8px' }}
        >
          {expanded ? '−' : '+'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text)', fontSize: 14 }}>
            {installation.nameRu}
            <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {installation.id}</span>
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {BUILD_CLASS_LABELS_RU[installation.buildClass]} · T{installation.tier}
            {installation.pad !== 'none' ? ` · площадка ${PAD_LABELS_RU[installation.pad]}` : ''}
            {installation.needs.count > 0 ? ` · нужно ${installation.needs.count} очк. T${installation.needs.tier}` : ''}
            {installation.gives.count > 0 ? ` · даёт ${installation.gives.count} очк. T${installation.gives.tier}` : ''}
            {preReq ? ` · нужен: ${preReq.label}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
          {formatTons(installation.haulTons)}
          <div style={{ fontSize: 11 }}>оценка +{installation.score}</div>
        </div>
        <button
          type="button"
          onClick={onPick}
          disabled={errors.length > 0}
          style={{
            ...buttonStyle,
            ...(errors.length > 0
              ? { opacity: 0.4, cursor: 'not-allowed' }
              : { borderColor: 'var(--orange)', color: 'var(--orange)' }),
          }}
        >
          В план
        </button>
      </div>
      {errors.length > 0 && (
        <div style={{ padding: '0 10px 8px', color: 'var(--red)', fontSize: 12 }}>
          {errors.map((message) => <div key={message}>• {message}</div>)}
        </div>
      )}
      {errors.length === 0 && warnings.length > 0 && (
        <div style={{ padding: '0 10px 8px', color: 'var(--orange)', fontSize: 12 }}>
          {warnings.map((message) => <div key={message}>• {message}</div>)}
        </div>
      )}
      {expanded && (
        <div style={{ padding: '0 10px 10px' }}>
          <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6 }}>
            {installation.nameEn} · {installation.group} · расположение: {installation.location === 'surface' ? 'поверхность' : 'орбита'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 16px', fontSize: 12 }}>
            {cargo.map(([key, tons]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: 'var(--text)' }}>{commodityLabel(key)}</span>
                <span style={{ color: 'var(--muted)' }}>{formatTons(tons)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line)',
  color: 'var(--muted)',
  padding: '4px 10px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
};

// Граница разбита на составляющие: рядом с `borderColor` из активного состояния
// шортхенд `border` вызывал предупреждение React о смешении свойств.
const chipStyle: React.CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--muted)',
  padding: '4px 10px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
};

const chipActive: React.CSSProperties = {
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  color: 'var(--text)',
  padding: '6px 10px',
  borderRadius: 3,
  fontSize: 13,
};
