'use client';

import type { CarrierView } from '@/lib/fleetCarriers';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Private, ledger-backed goods; never derive this inventory from market orders. */
export function CarrierBankPanel({ carrier }: { carrier: Pick<CarrierView, 'type' | 'relation' | 'cargo'> | null }) {
  const { t, locale } = useI18n();
  if (!carrier || carrier.type !== 'SquadronCarrier' || carrier.relation !== 'squadron' || !carrier.cargo) return null;
  const cargo = carrier.cargo;
  const nf = new Intl.NumberFormat(locale);
  return (
    <section className="ccd-panel" data-testid="squadron-bank">
      <h2>{t('fc.sectionBank')}</h2>
      <p style={{ color: '#9ca3af', fontSize: 12 }}>{t('fc.bankTrackedHint')}</p>
      {cargo.items.length ? (
        <div className="table-scroll"><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr>
            <th style={{ textAlign: 'left' }}>{t('fc.colGood')}</th>
            <th style={{ textAlign: 'right' }}>{t('fc.colTons')}</th>
          </tr></thead>
          <tbody>{cargo.items.map(item => (
            <tr key={item.commodity} style={{ borderTop: '1px solid #2d3033' }}>
              <td style={{ padding: '6px 0' }}>{item.name}</td>
              <td style={{ textAlign: 'right', color: '#e67e22' }}>{nf.format(item.quantity)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <p>{t('fc.cargoNotTracked')}</p>}
      <p style={{ color: '#9ca3af', fontSize: 12 }}>{t('fc.trackedTotal', { count: nf.format(cargo.trackedTotal) })}</p>
      {cargo.updatedAt && <time dateTime={cargo.updatedAt} style={{ color: '#9ca3af', fontSize: 12 }}>
        {t('fc.dataFrom', { time: new Date(cargo.updatedAt).toLocaleString(locale), ago: '' })}
      </time>}
    </section>
  );
}
