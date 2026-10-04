'use client';

/**
 * Что в верфи продаётся за Merc Coin.
 *
 * Обновление «Operations» принесло отдельную валюту: жетоны наёмника. За них
 * у обычных продавцов берут предзаряженные модули, а у инженеров — несколько
 * чертежей. Цены в кредитах тут ни при чём, поэтому в общей смете их нет —
 * список живёт отдельным блоком, а в сборке такие модули помечаются значком.
 *
 * Данные собраны вручную (`src/lib/outfitting/merccoin.ts`): официального
 * справочника цен в жетонах нет, часть значений — отчёты сообщества.
 */

import React, { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { groupName } from '@/lib/outfitting/i18n';
import { MERC_COIN_ITEMS, type MercCoinEntry } from '@/lib/outfitting/merccoin';
import type { OutfittingData } from '@/lib/outfitting/types';
import { IconChevronDown, IconChevronRight, IconCoins } from '@/components/Icons';
import { LABEL, MONO, PANEL } from './styles';

function groupLabel(data: OutfittingData, locale: string, entry: MercCoinEntry): string {
  const group = entry.ref ? entry.ref.split(':')[0] : entry.groups?.[0];
  if (!group) return '';
  if (!data.groups[group]) return group;
  return groupName(locale, group);
}

export default function MercCoinPanel({ data }: { data: OutfittingData }) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ ...PANEL, marginTop: 12, padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          color: '#fbbf24',
          cursor: 'pointer',
          padding: '9px 12px',
          textAlign: 'left',
        }}
      >
        {open ? <IconChevronDown size={13} color="#fbbf24" /> : <IconChevronRight size={13} color="#fbbf24" />}
        <IconCoins size={13} color="#fbbf24" />
        <span style={{ ...LABEL, color: '#fbbf24', marginBottom: 0 }}>{t('outfitting.merc.title')}</span>
        <span style={{ fontSize: 10.5, color: 'var(--muted)', marginLeft: 'auto', fontFamily: MONO }}>
          {MERC_COIN_ITEMS.length}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: '1px solid var(--line)' }}>
          {MERC_COIN_ITEMS.map((entry) => {
            const absent = !entry.ref && entry.kind !== 'blueprint';
            const upgrade = entry.upgrade
              ? ([2, 3, 4, 5] as const)
                .map((grade) => entry.upgrade?.[grade])
                .filter((value): value is number => typeof value === 'number')
                .join(' / ')
              : '';
            return (
              <div
                key={entry.id}
                style={{
                  padding: '7px 12px',
                  borderBottom: '1px solid var(--line)',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  opacity: absent ? 0.65 : 1,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: '#f8fafc', fontFamily: MONO }}>
                    {entry.name}
                    {entry.sizes ? <span style={{ color: 'var(--muted)' }}> · {entry.sizes}</span> : null}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1 }}>
                    {entry.kind === 'blueprint'
                      ? t('outfitting.merc.kind.blueprint')
                      : t('outfitting.merc.kind.module')}
                    {groupLabel(data, locale, entry) ? ` · ${groupLabel(data, locale, entry)}` : ''}
                  </div>
                  {upgrade && (
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 1, fontFamily: MONO }}>
                      {t('outfitting.merc.upgrade', { value: `${upgrade} MC` })}
                    </div>
                  )}
                  {entry.noteKey && (
                    <div style={{ fontSize: 10.5, color: '#f0b37e', marginTop: 2, lineHeight: 1.4 }}>
                      {t(entry.noteKey)}
                    </div>
                  )}
                  {absent && (
                    <div style={{ fontSize: 10.5, color: '#f0b37e', marginTop: 2, lineHeight: 1.4 }}>
                      {t('outfitting.merc.note.absent')}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 11.5,
                    color: entry.coins ? '#fbbf24' : 'var(--muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.coins
                    ? t('outfitting.merc.coins', { value: entry.coins })
                    : t('outfitting.merc.unknown')}
                </div>
              </div>
            );
          })}

          <p style={{ fontSize: 10, color: 'var(--muted)', lineHeight: 1.5, padding: '8px 12px', margin: 0 }}>
            {t('outfitting.merc.note')}
          </p>
        </div>
      )}
    </div>
  );
}
