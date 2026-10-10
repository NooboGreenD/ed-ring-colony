'use client';

/**
 * Выбор переборки (брони корпуса) — то же окно, что и для модулей, только
 * список один: у каждого корабля свои пять (или шесть) переборок с ценой и
 * массой. Инженерия — тот же `ArmourEngineering`, что и раньше: чертёж,
 * уровень и экспериментальный эффект.
 *
 * Так броня перестала быть отдельной сеткой в панели корпуса: она стала
 * первым слотом раздела «Основные модули» и выбирается по общему правилу.
 */

import React, { useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { moduleSpecValues, specName } from '@/lib/outfitting/specs';
import { effectiveModule } from '@/lib/outfitting/calc';
import type { OutfittingData, OutfittingModule, OutfittingShip, SlotModification } from '@/lib/outfitting/types';
import ArmourEngineering from './ArmourEngineering';
import { IconCheckCircle, IconShield, IconX } from '@/components/Icons';
import { LABEL, MONO, button, formatters } from './styles';
import { bulkheadName } from '@/lib/outfitting/i18n';

export default function BulkheadPicker({
  data,
  ship,
  bulkhead,
  modification,
  onPick,
  onModify,
  onClose,
}: {
  data: OutfittingData;
  ship: OutfittingShip;
  /** Индекс установленной переборки. */
  bulkhead: number;
  modification: SlotModification | null;
  onPick: (index: number) => void;
  onModify: (next: SlotModification | null) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const { num, credits } = formatters(locale);
  const [hovered, setHovered] = useState<number | null>(null);

  const specsOf = (index: number) => {
    const raw = ship.bulkheads[index] as unknown as OutfittingModule;
    const effective = effectiveModule(data, raw, index === bulkhead ? modification : null) ?? raw;
    return moduleSpecValues(effective as unknown as Record<string, unknown>, locale, num);
  };

  const installed = ship.bulkheads[bulkhead];

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4, 6, 9, 0.82)',
        backdropFilter: 'blur(4px)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          width: 'min(980px, 98vw)',
          height: 'min(760px, 90vh)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 45px rgba(0,0,0,0.65)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--line)',
            background: 'rgba(15, 23, 42, 0.65)',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span
              style={{
                fontFamily: MONO,
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--orange)',
                background: 'rgba(230,126,34,0.12)',
                border: '1px solid rgba(230,126,34,0.4)',
                borderRadius: 3,
                padding: '2px 8px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <IconShield size={12} color="var(--orange)" />
              {t('outfitting.bulkhead.title')}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text)', fontFamily: MONO }}>
              {installed ? bulkheadName(locale, installed.name) : '—'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t('outfitting.picker.close')}
            style={{
              background: 'transparent',
              border: '1px solid var(--line)',
              color: 'var(--muted)',
              borderRadius: 4,
              width: 28,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <IconX size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Список переборок корабля */}
          <div
            style={{
              flex: '1 1 320px',
              minWidth: 260,
              borderRight: '1px solid var(--line)',
              overflowY: 'auto',
              background: 'rgba(8, 12, 19, 0.3)',
            }}
          >
            {ship.bulkheads.map((entry, index) => {
              if (entry.archived) return null;
              const isActive = index === bulkhead;
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => onPick(index)}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered((previous) => (previous === index ? null : previous))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    width: '100%',
                    textAlign: 'left',
                    margin: 0,
                    padding: '8px 12px',
                    background: isActive
                      ? 'rgba(230,126,34,0.14)'
                      : hovered === index
                        ? 'rgba(255,255,255,0.04)'
                        : 'transparent',
                    border: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    borderLeft: `3px solid ${isActive ? 'var(--orange)' : 'transparent'}`,
                    color: 'var(--text)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    {isActive ? (
                      <IconCheckCircle size={12} color="var(--green)" />
                    ) : (
                      <span style={{ width: 12 }} />
                    )}
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontFamily: MONO, fontSize: 12, color: isActive ? '#fff' : '#e2e8f0' }}>
                        {bulkheadName(locale, entry.name)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--muted)', fontFamily: MONO }}>
                        {t('outfitting.bulkhead.hullBoost')}: +{num(entry.hullboost * 100, 0)} % ·{' '}
                        {t('outfitting.bulkhead.shortMass')}: {num(entry.mass, 0)} {t('outfitting.unit.t', { value: '' }).trim()}
                      </span>
                    </span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--orange)', fontFamily: MONO, whiteSpace: 'nowrap' }}>
                    {credits(entry.cost)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Параметры выбранной переборки и инженерия */}
          <div style={{ flex: '1 1 380px', minWidth: 300, overflowY: 'auto', background: 'rgba(10, 15, 24, 0.65)' }}>
            <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid var(--line)',
                  borderRadius: 4,
                  padding: '10px 12px',
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#f8fafc' }}>
                  {bulkheadName(locale, installed?.name)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {t('outfitting.bulkhead.intro')}
                </div>
              </div>

              <div>
                <div style={{ ...LABEL, fontSize: 10.5, marginBottom: 5 }}>
                  {t('outfitting.picker.tab.specs')}
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 4,
                    fontSize: 11,
                    fontFamily: MONO,
                  }}
                >
                  {specsOf(bulkhead).map((value) => (
                    <div
                      key={value.key}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 6,
                        background: 'rgba(255,255,255,0.03)',
                        padding: '3px 6px',
                        borderRadius: 2,
                      }}
                    >
                      <span style={{ color: 'var(--muted)' }}>{specName(locale, value.key)}</span>
                      <span style={{ whiteSpace: 'nowrap' }}>{value.display}</span>
                    </div>
                  ))}
                </div>
              </div>

              <ArmourEngineering
                data={data}
                modification={modification}
                onModify={onModify}
                t={t}
                locale={locale}
              />

              <button
                type="button"
                onClick={onClose}
                style={{ ...button(true), justifyContent: 'center', marginTop: 'auto' }}
              >
                {t('outfitting.bulkhead.done')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
