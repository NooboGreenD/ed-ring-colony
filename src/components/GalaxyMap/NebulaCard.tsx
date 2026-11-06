'use client';

/**
 * Карточка выбранной туманности на карте галактики.
 *
 * Показывает то, что известно про объект в игре: тип, расстояние от Sol,
 * координаты, систему внутри туманности (куда прыгать) и подсказку, если
 * данные о позиции приблизительные.
 */

import { IconExternalLink, IconMapPin, IconPlane } from '@/components/Icons';
import { NEBULA_KIND_LABELS, type GalaxyNebula } from '@/lib/galaxyNebulae';
import { useI18n } from '@/lib/i18n/I18nContext';
import { NEBULA_KIND_KEYS } from '@/lib/i18n/nebulaLabels';

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '?';
}

export function NebulaCard({
  nebula,
  onFocus,
  onClose,
}: {
  nebula: GalaxyNebula;
  onFocus: (nebula: GalaxyNebula) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.92)', backdropFilter: 'blur(8px)', border: `1px solid ${nebula.color}55`, borderRadius: 8, padding: 12, minWidth: 250, maxWidth: 330, pointerEvents: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: nebula.color, textShadow: `0 0 10px ${nebula.color}66` }}>
          {locale === 'ru' ? nebula.ru : nebula.name}
        </div>
        <button
          type="button"
          onClick={onClose}
          title={t('atlas.ui.close')}
          style={{ background: 'transparent', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 }}
        >
          ✕
        </button>
      </div>
      <div style={{ marginTop: 2, fontSize: 11, color: '#9ca3af' }}>{nebula.name}</div>

      <div style={{ marginTop: 6, fontSize: 12, color: '#e5e7eb' }}>
        {NEBULA_KIND_KEYS[nebula.kind] ? t(NEBULA_KIND_KEYS[nebula.kind]) : NEBULA_KIND_LABELS[nebula.kind]}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>
        <IconMapPin size={12} /> {formatCoordinate(nebula.x)}, {formatCoordinate(nebula.y)}, {formatCoordinate(nebula.z)}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>
        {t('card.nebulaToSol', { value: t('card.distanceLy', { value: nebula.distance.toFixed(0) }) })}
        {' · '}
        {t('card.nebulaDiameter', { value: t('card.distanceLy', { value: nebula.size }) })}
      </div>

      {nebula.refSystem && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#e67e22' }}>
          <IconPlane size={10} /> {t('card.nebulaInside', { name: nebula.refSystem })}
        </div>
      )}
      {nebula.note && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#9ca3af', lineHeight: 1.35 }}>{nebula.note}</div>
      )}
      <div style={{ marginTop: 6, fontSize: 10, color: '#6b7280' }}>
        {nebula.positionSource === 'game-system'
          ? t('card.nebulaPositionGame')
          : t('card.nebulaPositionCatalog')}
        {nebula.approx ? t('card.nebulaApprox') : ''}
      </div>

      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onFocus(nebula)}
          style={{ fontSize: 11, color: '#8bbcff', textDecoration: 'none', padding: '3px 8px', background: 'rgba(59,130,246,0.12)', borderRadius: 4, border: '1px solid rgba(59,130,246,0.35)', cursor: 'pointer' }}
        >
          {t('card.focusCamera')}
        </button>
        {nebula.refSystem && (
          <a
            href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(nebula.refSystem)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 11, color: '#3b82f6', textDecoration: 'none' }}
          >
            EDSM <IconExternalLink size={10} />
          </a>
        )}
        <a
          href={`https://www.edsm.net/en/galactic-mapping/listing?search=${encodeURIComponent(nebula.name)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'none' }}
        >
          GMP <IconExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
