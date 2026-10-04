'use client';

/**
 * Обмен сборками с coriolis.io, EDSY, Inara и игрой.
 *
 * Слева — выгрузка: ссылка верфи, ссылка Coriolis и текст SLEF. Справа —
 * поле, куда можно вставить что угодно из перечисленного; разбор сам
 * определяет формат и показывает отчёт, что именно перенеслось, а что нет.
 */

import React, { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { coriolisUrl, parseImport, toSlef, nativeUrl } from '@/lib/outfitting/exchange';
import type { ImportIssue } from '@/lib/outfitting/exchange';
import type { OutfittingData, ShipBuild } from '@/lib/outfitting/types';
import { IconAlert, IconCopy, IconExternalLink, IconX } from '@/components/Icons';
import { LABEL, MONO, PANEL, button } from './styles';

interface ExchangePanelProps {
  data: OutfittingData;
  build: ShipBuild;
  onImport: (build: ShipBuild) => void;
  onClose: () => void;
}

function IssueList({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {issues.map((issue, index) => (
        <div
          key={`${issue.level}-${index}`}
          style={{
            fontSize: 10.5,
            lineHeight: 1.4,
            color: issue.level === 'error' ? 'var(--red)' : '#f0b37e',
            display: 'flex',
            gap: 5,
            alignItems: 'flex-start',
          }}
        >
          <IconAlert size={11} color={issue.level === 'error' ? 'var(--red)' : '#f0b37e'} />
          <span>{issue.text}</span>
        </div>
      ))}
    </div>
  );
}

function CopyField({
  title,
  value,
  href,
  onCopied,
  copyLabel,
  openLabel,
}: {
  title: string;
  value: string;
  href?: string;
  onCopied: () => void;
  copyLabel: string;
  openLabel: string;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...LABEL, marginBottom: 4, color: 'var(--orange)' }}>{title}</div>
      <textarea
        readOnly
        value={value}
        rows={value.length > 200 ? 6 : 2}
        onFocus={(event) => event.currentTarget.select()}
        style={{
          width: '100%',
          fontFamily: MONO,
          fontSize: 10.5,
          margin: 0,
          resize: 'vertical',
          background: 'rgba(0,0,0,0.3)',
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button
          type="button"
          style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px' }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              onCopied();
            } catch {
              // Буфер недоступен — текст и так виден в поле, выделять его умеет сам пользователь.
            }
          }}
        >
          <IconCopy size={11} />
          {copyLabel}
        </button>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...button(false), display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', textDecoration: 'none' }}
          >
            <IconExternalLink size={11} />
            {openLabel}
          </a>
        )}
      </div>
    </div>
  );
}

export default function ExchangePanel({ data, build, onImport, onClose }: ExchangePanelProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [status, setStatus] = useState('');

  const coriolis = useMemo(() => coriolisUrl(data, build), [data, build]);
  // Версию приложения принимающая сторона пишет в заголовок SLEF; если её
  // не задали при сборке, честнее отдать «dev», чем выдуманный номер.
  const slef = useMemo(
    () => toSlef(data, build, process.env.NEXT_PUBLIC_APP_VERSION || 'dev'),
    [data, build],
  );
  const own = useMemo(
    () => nativeUrl(typeof window === 'undefined' ? '' : window.location.origin, build),
    [build],
  );

  const applyImport = () => {
    const result = parseImport(data, text);
    setIssues(result.issues);
    if (result.build) {
      onImport(result.build);
      setStatus(t('outfitting.exchange.ok'));
    } else {
      setStatus('');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        zIndex: 80,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 20,
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          ...PANEL,
          width: 'min(900px, 100%)',
          marginTop: 30,
          padding: 16,
          background: 'var(--bg)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 15, letterSpacing: 1, color: 'var(--orange)' }}>
            {t('outfitting.exchange.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{ ...button(false), padding: '4px 8px', display: 'flex', alignItems: 'center' }}
          >
            <IconX size={13} />
          </button>
        </div>

        <p style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5, marginTop: 8 }}>
          {t('outfitting.exchange.hint')}
        </p>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 4 }}>
          <div style={{ flex: '1 1 380px', minWidth: 280 }}>
            <div style={{ ...LABEL, color: 'var(--text)', fontSize: 11 }}>
              {t('outfitting.exchange.export')}
            </div>

            <CopyField
              title={t('outfitting.exchange.native')}
              value={own}
              onCopied={() => setStatus(t('outfitting.exchange.copied'))}
              copyLabel={t('outfitting.exchange.copy')}
              openLabel={t('outfitting.exchange.open')}
            />

            <CopyField
              title={t('outfitting.exchange.coriolis')}
              value={coriolis}
              href={coriolis}
              onCopied={() => setStatus(t('outfitting.exchange.copied'))}
              copyLabel={t('outfitting.exchange.copy')}
              openLabel={t('outfitting.exchange.open')}
            />

            <CopyField
              title={t('outfitting.exchange.slef')}
              value={slef.text}
              onCopied={() => setStatus(t('outfitting.exchange.copied'))}
              copyLabel={t('outfitting.exchange.copy')}
              openLabel={t('outfitting.exchange.open')}
            />
            <IssueList issues={slef.issues} />
          </div>

          <div style={{ flex: '1 1 380px', minWidth: 280 }}>
            <div style={{ ...LABEL, color: 'var(--text)', fontSize: 11 }}>
              {t('outfitting.exchange.import')}
            </div>
            <p style={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1.5, margin: '6px 0' }}>
              {t('outfitting.exchange.edsyHint')}
            </p>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('outfitting.exchange.paste')}
              rows={12}
              style={{
                width: '100%',
                fontFamily: MONO,
                fontSize: 10.5,
                margin: 0,
                resize: 'vertical',
                background: 'rgba(0,0,0,0.3)',
              }}
            />
            <button
              type="button"
              disabled={!text.trim()}
              onClick={applyImport}
              style={{
                ...button(Boolean(text.trim())),
                marginTop: 6,
                padding: '6px 10px',
                opacity: text.trim() ? 1 : 0.5,
              }}
            >
              {t('outfitting.exchange.apply')}
            </button>
            <IssueList issues={issues} />
          </div>
        </div>

        {status && (
          <div
            style={{
              marginTop: 10,
              fontSize: 11,
              color: 'var(--green)',
              background: 'rgba(46,204,113,0.1)',
              border: '1px solid rgba(46,204,113,0.3)',
              borderRadius: 3,
              padding: '5px 9px',
            }}
          >
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
