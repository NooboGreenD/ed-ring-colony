'use client';

import { useMemo, useState } from 'react';
import { BUILD_CLASS_LABELS_RU, ECONOMY_LABELS_RU, PAD_LABELS_RU, PRE_REQS, installationLinks, installationName } from '@/lib/architect/catalogue';
import { ECONOMY_MARKET } from '@/lib/architect/economy';
import { useI18n } from '@/lib/i18n/I18nContext';
import { architectLabel } from '@/lib/i18n/architectLabels';
import {
  commodityLabel,
  formatTons,
  getInstallation,
  listInstallations,
  orbitalLimit,
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
  /** Начальный фильтр расположения — когда каталог открыт из раздела «наземные»/«орбитальные». */
  initialLocation?: 'any' | 'orbital' | 'surface';
}

type LocationFilter = 'any' | 'orbital' | 'surface';
type TierFilter = 0 | 1 | 2 | 3;

const TIER_LABELS: Record<TierFilter, string> = { 0: 'ipk.tierAny', 1: 'T1', 2: 'T2', 3: 'T3' };

export default function InstallationPicker({ body, plan, onPick, onClose, initialLocation = 'any' }: InstallationPickerProps) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState<LocationFilter>(initialLocation);
  const [tier, setTier] = useState<TierFilter>(0);
  const [expanded, setExpanded] = useState<string>('');

  const surfaceLimit = predictSurfaceSlots(body);
  const usedSurface = plan.sites.filter(
    (site) => site.bodyName === body.name && getInstallation(site.installationId)?.location === 'surface',
  ).length;
  const orbitalSlots = orbitalLimit(body, plan);
  const usedOrbital = plan.sites.filter(
    (site) => site.bodyName === body.name && getInstallation(site.installationId)?.location === 'orbital',
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
      return right.installation.score - left.installation.score
        || installationName(left.installation, locale).localeCompare(installationName(right.installation, locale));
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
                {t('ipk.title')}
              </div>
              <div style={{ fontSize: 18, color: 'var(--text)' }}>{body.name}</div>
            </div>
            <button type="button" onClick={onClose} style={buttonStyle}>{t('ipk.close')}</button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
            {body.subType && body.subType !== 'Неизвестно'
              ? body.subType
              : <span style={{ color: 'var(--orange)' }}>{t('ipk.unknownClass')}</span>}
            {body.kind === 'planet' || body.kind === 'moon' ? (
              <>
                {' · '}
                {surfaceLimit > 0
                  ? t('ipk.surfaceSlots', { used: usedSurface, limit: surfaceLimit })
                  : t('ipk.noSurfaceSlots')}
              </>
            ) : t('ipk.starOrbitalOnly')}
            {' · '}{orbitalSlots === null
              ? t('ipk.orbitalUnlimited', { used: usedOrbital })
              : t('ipk.orbitalSlots', { used: usedOrbital, limit: orbitalSlots })}
          </div>
        </div>

        <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('ipk.searchPlaceholder')}
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
                {value === 'any' ? t('ipk.filterAll') : value === 'orbital' ? t('ipk.filterOrbital') : t('ipk.filterSurface')}
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
                {t(TIER_LABELS[value])}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 12px 16px' }}>
          {rows.length === 0 && (
            <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>{t('ipk.nothingFound')}</div>
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
  const { t, locale } = useI18n();
  const preReq = installation.preReq ? PRE_REQS[installation.preReq] : null;
  const links = installationLinks(installation.id);
  const market = ECONOMY_MARKET[installation.influence];
  const cargo = Object.entries(installation.cargo).sort((left, right) => right[1] - left[1]);
  const primary = installation.primary;
  const primaryCargo = primary
    ? Object.entries(primary.cargo).sort((left, right) => right[1] - left[1])
    : [];
  const primaryTons = primaryCargo.reduce((sum, [, tons]) => sum + tons, 0);

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 4, marginBottom: 6, background: 'var(--bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px' }}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={t('ipk.detailsAria')}
          style={{ ...buttonStyle, padding: '2px 8px' }}
        >
          {expanded ? '−' : '+'}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: 'var(--text)', fontSize: 14 }}>
            {installationName(installation, locale)}
            <span style={{ color: 'var(--muted)', fontSize: 12 }}> · {installation.id}</span>
            {primary ? (
              <span
                title={primary.note}
                style={{ marginLeft: 6, fontSize: 11, color: 'var(--orange)', border: '1px solid var(--orange)', borderRadius: 3, padding: '0 5px' }}
              >
                {t('ipk.canBePrimary')}
              </span>
            ) : null}
          </div>
          <div style={{ color: 'var(--muted)', fontSize: 11 }}>
            {architectLabel('buildClass', installation.buildClass, BUILD_CLASS_LABELS_RU[installation.buildClass], t)} · T{installation.tier}
            {installation.pad !== 'none' ? t('ipk.pad', { pad: architectLabel('pad', installation.pad, PAD_LABELS_RU[installation.pad], t) }) : ''}
            {installation.needs.count > 0 ? t('ipk.needs', { count: installation.needs.count, tier: installation.needs.tier }) : ''}
            {installation.gives.count > 0 ? t('ipk.gives', { count: installation.gives.count, tier: installation.gives.tier }) : ''}
            {preReq ? t('ipk.preReq', { label: architectLabel('preReq', installation.preReq!, preReq.label, t) }) : ''}
            {installation.influence !== 'none' ? t('ipk.economy', { label: architectLabel('economy', installation.influence, ECONOMY_LABELS_RU[installation.influence], t) }) : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right', color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
          {formatTons(installation.haulTons)}
          {primary ? <div style={{ fontSize: 11, color: 'var(--orange)' }}>{t('ipk.primary', { value: `${primary.approximate ? '≈ ' : ''}${formatTons(primaryTons)}` })}</div> : null}
          <div style={{ fontSize: 11 }}>{t('ipk.score', { score: installation.score })}</div>
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
          {t('ipk.addToPlan')}
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
            {t('ipk.locationLine', { name: installation.nameEn, group: installation.group, location: installation.location === 'surface' ? t('ipk.surface') : t('ipk.orbital') })}
          </div>

          {(links.requires.length > 0 || links.enables.length > 0 || links.requiredBy.length > 0 || market.produces.length > 0) && (
            <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11 }}>
              {links.requires.length > 0 && (
                <div style={{ color: 'var(--muted)' }}>
                  {t('ipk.requiresPredecessor')} <span style={{ color: 'var(--text)' }}>{links.requires.map((req) => architectLabel('preReq', req.preReq, req.label, t)).join(' / ')}</span>
                </div>
              )}
              {links.enables.length > 0 && (
                <div style={{ color: 'var(--cyan)' }}>{t('ipk.enables')} {links.enables.map((enable) => architectLabel('unlock', enable.id, enable.label, t)).join('; ')}</div>
              )}
              {links.requiredBy.length > 0 && (
                <div style={{ color: 'var(--muted)' }}>
                  {t('ipk.requiredFor')} <span style={{ color: 'var(--text)' }}>{links.requiredBy.map((ref) => installationName(ref, locale)).join(', ')}</span>
                </div>
              )}
              {market.produces.length > 0 && (
                <div style={{ color: 'var(--muted)' }}>
                  <span style={{ color: 'var(--green)' }}>{t('ipk.marketSells')}</span> {market.produces.join(', ')}
                </div>
              )}
              {market.imports.length > 0 && (
                <div style={{ color: 'var(--muted)' }}>
                  <span style={{ color: 'var(--cyan)' }}>{t('ipk.marketImports')}</span> {market.imports.join(', ')}
                </div>
              )}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 16px', fontSize: 12 }}>
            {cargo.map(([key, tons]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: 'var(--text)' }}>{commodityLabel(key)}</span>
                <span style={{ color: 'var(--muted)' }}>{formatTons(tons)}</span>
              </div>
            ))}
          </div>
          {primary && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--line)' }}>
              <div style={{ fontSize: 11, color: 'var(--orange)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>
                {t('ipk.primaryMaterials', { estimate: primary.approximate ? t('ipk.estimate') : '', tons: formatTons(primaryTons) })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>{primary.note}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 16px', fontSize: 12 }}>
                {primaryCargo.map(([key, tons]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ color: 'var(--text)' }}>{commodityLabel(key)}</span>
                    <span style={{ color: 'var(--muted)' }}>{formatTons(tons)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
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
