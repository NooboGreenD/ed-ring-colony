'use client';

import { useI18n } from '@/lib/i18n/I18nContext';
import { useMemo, useState } from 'react';
import { BUILD_CLASS_LABELS_RU, ECONOMY_LABELS_RU, PAD_LABELS_RU, PRE_REQS, installationLinks, installationName } from '@/lib/architect/catalogue';
import { architectLabel } from '@/lib/i18n/architectLabels';
import { economyBodyFit } from '@/lib/architect/economy';
import {
  canBePrimary,
  formatTons,
  getInstallation,
  listInstallations,
  placementCheck,
} from '@/lib/architect/planner';
import type { SitePatch } from '@/lib/architect/planner';
import { economyFitText, placementCheckTexts } from '@/lib/i18n/planText';
import type {
  ArchitectBody,
  ArchitectPlan,
  PlannedSite,
  PlannedSiteStatus,
} from '@/lib/architect/types';

interface SiteEditorProps {
  site: PlannedSite;
  plan: ArchitectPlan;
  bodies: ArchitectBody[];
  onSave: (siteId: string, patch: SitePatch) => void;
  onClose: () => void;
  onDelete?: (siteId: string) => void;
}

const STATUS_ORDER: PlannedSiteStatus[] = ['plan', 'building', 'complete'];
const STATUS_LABELS: Record<PlannedSiteStatus, string> = { plan: 'sed.stPlan', building: 'sed.stBuilding', complete: 'sed.stComplete' };

/**
 * Редактирование постройки, уже добавленной в план: тип, тело, статус,
 * роль основного порта и заметка. Правки проверяются на месте — кнопка
 * «Сохранить» не даст положить постройку туда, где она невозможна.
 */
export default function SiteEditor({ site, plan, bodies, onSave, onClose, onDelete }: SiteEditorProps) {
  const { t, locale } = useI18n();
  const [installationId, setInstallationId] = useState(site.installationId);
  const [bodyName, setBodyName] = useState(site.bodyName);
  const [status, setStatus] = useState<PlannedSiteStatus>(site.status);
  const [primary, setPrimary] = useState(Boolean(site.primary));
  const [note, setNote] = useState(site.note ?? '');
  const [query, setQuery] = useState('');

  const bodiesByName = useMemo(() => new Map(bodies.map((body) => [body.name, body])), [bodies]);
  const targetBody = bodiesByName.get(bodyName) ?? null;
  // Проверяем «как будто этой записи нет»: сама запись своему телу не мешает.
  const planWithoutSite = useMemo(
    () => ({ ...plan, sites: plan.sites.filter((entry) => entry.id !== site.id) }),
    [plan, site.id],
  );

  const installation = getInstallation(installationId);
  const capable = canBePrimary(installationId);
  const effectivePrimary = capable && primary;

  const rows = useMemo(() => {
    const filtered = listInstallations({ query });
    return filtered
      .map((entry) => ({ entry, check: placementCheck(targetBody, entry.id, planWithoutSite) }))
      .sort((left, right) => {
        if (left.check.ok !== right.check.ok) return left.check.ok ? -1 : 1;
        return right.entry.score - left.entry.score
          || installationName(left.entry, locale).localeCompare(installationName(right.entry, locale));
      });
  }, [query, targetBody, planWithoutSite]);

  const chosenCheck = installation ? placementCheck(targetBody, installationId, planWithoutSite) : null;
  const chosenTexts = chosenCheck ? placementCheckTexts(chosenCheck, t) : null;
  const errors = chosenTexts?.errors ?? [t('sed.unknownSite')];
  const warnings = chosenTexts?.warnings ?? [];
  // Соответствие экономики выбранному телу и связи постройки с остальными.
  const economyFit = installation && installation.influence !== 'none' && targetBody && targetBody.kind !== 'star'
    ? economyBodyFit(installation.influence, targetBody)
    : null;
  const links = installation ? installationLinks(installationId) : null;
  const installedIds = useMemo(() => new Set(plan.sites.map((entry) => entry.installationId)), [plan.sites]);
  const primaryCargo = effectivePrimary ? installation?.primary : null;
  const regularTons = installation?.haulTons ?? 0;
  const effectiveTons = primaryCargo
    ? Object.values(primaryCargo.cargo).reduce((sum, tons) => sum + tons, 0)
    : regularTons;

  const bodyOptions = useMemo(() => {
    const names = bodies.map((body) => body.name);
    if (bodyName && !names.includes(bodyName)) names.unshift(bodyName);
    return names;
  }, [bodies, bodyName]);

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
          width: 'min(880px, 100%)', maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 4,
        }}
      >
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
                {t('sed.editTitle')}
              </div>
              <div style={{ fontSize: 18, color: 'var(--text)' }}>
                {installationName(installation, locale) || site.installationId}
                {site.primary ? <span style={{ color: 'var(--orange)', fontSize: 14 }}> {t('sed.primaryPort')}</span> : null}
              </div>
            </div>
            <button type="button" onClick={onClose} style={buttonStyle}>{t('sed.close')}</button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '12px 18px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            <label style={{ ...fieldLabel, flex: '1 1 200px' }}>
              {t('sed.body')}
              <select
                value={bodyName}
                onChange={(event) => setBodyName(event.target.value)}
                style={inputStyle}
              >
                {bodyOptions.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <div style={{ ...fieldLabel, flex: '0 0 auto' }}>
              {t('sed.status')}
              <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                {STATUS_ORDER.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatus(value)}
                    style={{ ...chipStyle, ...(status === value ? chipActive : {}) }}
                  >
                    {t(STATUS_LABELS[value])}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('sed.searchPlaceholder')}
              aria-label={t('sed.searchAria')}
              style={{ ...inputStyle, width: '100%', marginBottom: 8 }}
            />
            <div style={{ border: '1px solid var(--line)', borderRadius: 4, maxHeight: 260, overflowY: 'auto' }}>
              {rows.map(({ entry, check }) => {
                const selected = entry.id === installationId;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setInstallationId(entry.id);
                      if (!canBePrimary(entry.id)) setPrimary(false);
                    }}
                    style={{
                      ...selectRowStyle,
                      ...(selected ? selectRowActive : {}),
                      ...(check.errors.length > 0 && !selected ? { opacity: 0.55 } : {}),
                    }}
                  >
                    <span style={{ minWidth: 0, textAlign: 'left' }}>
                      <span style={{ display: 'block', color: 'var(--text)', fontSize: 13 }}>
                        {installationName(entry, locale)}
                        {entry.primary ? <span style={{ color: 'var(--orange)', fontSize: 11 }}> ★</span> : null}
                        <span style={{ color: 'var(--muted)', fontSize: 11 }}> · {entry.id}</span>
                      </span>
                      <span style={{ display: 'block', color: 'var(--muted)', fontSize: 11 }}>
                        {architectLabel('buildClass', entry.buildClass, BUILD_CLASS_LABELS_RU[entry.buildClass], t)} · T{entry.tier}
                        {' · '}
                        {entry.location === 'surface' ? t('sed.surface') : t('sed.orbital')}
                        {entry.pad !== 'none' ? t('sed.pad', { pad: architectLabel('pad', entry.pad, PAD_LABELS_RU[entry.pad], t) }) : ''}
                        {check.errors.length > 0 ? ` · ${placementCheckTexts(check, t).errors[0]}` : ''}
                      </span>
                    </span>
                    <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {formatTons(entry.haulTons)}
                    </span>
                  </button>
                );
              })}
              {rows.length === 0 && (
                <div style={{ padding: 16, color: 'var(--muted)', fontSize: 13 }}>{t('sed.nothingFound')}</div>
              )}
            </div>
          </div>

          {installation && (
            <div style={{ border: '1px solid var(--line)', borderRadius: 4, padding: '10px 12px', background: 'var(--bg)' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {installation.needs.count > 0 ? t('sed.needs', { count: installation.needs.count, tier: installation.needs.tier }) : t('sed.noPoints')}
                  {installation.gives.count > 0 ? t('sed.gives', { count: installation.gives.count, tier: installation.gives.tier }) : ''}
                  {installation.preReq && PRE_REQS[installation.preReq] ? t('sed.predecessor', { label: architectLabel('preReq', installation.preReq, PRE_REQS[installation.preReq].label, t) }) : ''}
                  {t('sed.economy', { label: architectLabel('economy', installation.influence, ECONOMY_LABELS_RU[installation.influence], t) })}
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>
                  {formatTons(effectiveTons)}
                  {primaryCargo ? <span style={{ color: 'var(--orange)', fontSize: 11 }}> {t('sed.primarySuffix')}</span> : null}
                </div>
              </div>

              {capable && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={primary}
                    onClick={() => setPrimary((value) => !value)}
                    style={{
                      ...chipStyle,
                      ...(primary
                        ? { borderColor: 'var(--orange)', color: 'var(--orange)' }
                        : {}),
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    {primary ? t('sed.primaryPort') : t('sed.makePrimary')}
                  </button>
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                    {primary
                      ? t('sed.primaryNote', { effective: formatTons(effectiveTons), regular: formatTons(regularTons), estimate: primaryCargo?.approximate ? t('sed.estimateNote') : '', note: installation.primary?.note ?? '' })
                      : t('sed.primaryHint')}
                  </div>
                </div>
              )}

              {(economyFit || (links && (links.requires.length > 0 || links.enables.length > 0 || links.requiredBy.length > 0))) && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {economyFit && economyFit.level !== 'neutral' && (
                    <div style={{ fontSize: 11, color: economyFit.level === 'boost' ? 'var(--green)' : 'var(--orange)', lineHeight: 1.5 }}>
                      {economyFit.level === 'boost' ? '▲ ' : '▽ '}{economyFitText(economyFit, t)}
                    </div>
                  )}
                  {links && links.requires.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                      {t('sed.needsPredecessor')}{' '}
                      {links.requires.map((req) => {
                        const ok = req.options.some((option) => installedIds.has(option.id));
                        return (
                          <span key={req.preReq} style={{ color: ok ? 'var(--green)' : 'var(--red)' }}>
                            {ok ? '✓ ' : '✗ '}{req.label}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {links && links.enables.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--cyan)', lineHeight: 1.5 }}>
                      {t('sed.enables')} {links.enables.map((enable) => enable.label).join('; ')}
                    </div>
                  )}
                  {links && links.requiredBy.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                      {t('sed.requiredFor')} {links.requiredBy.map((ref) => installationName(ref, locale)).join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {errors.length > 0 && errors[0] !== t('sed.unknownSite') && (
            <div style={{ color: 'var(--red)', fontSize: 12 }}>
              {errors.map((message) => <div key={message}>• {message}</div>)}
            </div>
          )}
          {errors.length === 0 && warnings.length > 0 && (
            <div style={{ color: 'var(--orange)', fontSize: 12 }}>
              {warnings.map((message) => <div key={message}>• {message}</div>)}
            </div>
          )}

          <label style={fieldLabel}>
            {t('sed.note')}
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t('sed.notePlaceholder')}
              maxLength={300}
              style={{ ...inputStyle, width: '100%' }}
            />
          </label>
        </div>

        <div style={{ padding: '10px 18px', borderTop: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(site.id)}
              style={{ ...buttonStyle, borderColor: 'var(--red)', color: 'var(--red)', marginRight: 'auto' }}
            >
              {t('sed.deleteSite')}
            </button>
          )}
          <button type="button" onClick={onClose} style={buttonStyle}>{t('sed.cancel')}</button>
          <button
            type="button"
            disabled={errors.length > 0}
            onClick={() => onSave(site.id, {
              installationId,
              bodyName,
              status,
              note: note.trim() ? note.trim() : null,
              primary: effectivePrimary,
            })}
            style={{
              ...buttonStyle,
              ...(errors.length > 0
                ? { opacity: 0.4, cursor: 'not-allowed' }
                : { borderColor: 'var(--orange)', color: 'var(--orange)' }),
            }}
          >
            {t('sed.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

const buttonStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--line)',
  color: 'var(--muted)',
  padding: '6px 12px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
};

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
  padding: '7px 10px',
  borderRadius: 3,
  fontSize: 13,
  marginTop: 4,
};

const fieldLabel: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontSize: 11,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: 1,
  minWidth: 0,
};

const selectRowStyle: React.CSSProperties = {
  display: 'flex',
  width: '100%',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  padding: '7px 10px',
  background: 'transparent',
  borderWidth: 0,
  borderBottomWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  cursor: 'pointer',
};

const selectRowActive: React.CSSProperties = {
  background: 'var(--panel)',
  boxShadow: 'inset 2px 0 0 var(--orange)',
};
