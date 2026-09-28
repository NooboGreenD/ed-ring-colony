'use client';

import { useCallback, useEffect, useState } from 'react';

import { IconAlert, IconCheckCircle, IconRefresh } from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';

/**
 * Админка → «Обновления Helper»: что сейчас получают пилоты.
 *
 * Публикует версии CI, а не человек, поэтому здесь только две вещи, которые
 * действительно нужны руками: посмотреть, что лежит в канале, и вернуть канал
 * назад, если релиз оказался неудачным. Откат тут мгновенный — все прошлые
 * версии остаются на диске, и программа ставит предыдущую обычным
 * обновлением, без переустановки.
 */

interface VersionRow {
  version: string;
  channel: string;
  released_at: string;
  files: number;
  bytes: number;
  min_launcher: string;
  signed: boolean;
}

interface StoreInfo {
  root: string;
  ready: boolean;
  versions: number;
  publishConfigured: boolean;
  keyIds: string[];
}

interface VersionsResponse {
  ok?: boolean;
  error?: string;
  store?: StoreInfo;
  channels?: Record<string, { version: string; released_at: string }>;
  versions?: VersionRow[];
}

const CHANNEL_LABELS: Record<string, string> = {
  stable: 'Стабильный',
  beta: 'Тестовый (arena/**)',
};

function formatDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export default function HelperUpdatesTab() {
  const [store, setStore] = useState<StoreInfo | null>(null);
  const [channels, setChannels] = useState<Record<string, { version: string; released_at: string }>>({});
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch('/api/admin/uploader/versions', { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStore(data.store ?? null);
      setChannels(data.channels ?? {});
      setVersions(data.versions ?? []);
      setError('');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось получить список версий');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const promote = useCallback(async (channel: string, version: string) => {
    const current = channels[channel]?.version ?? '';
    const back = current && current > version;
    const question = back
      ? `Вернуть канал «${CHANNEL_LABELS[channel] ?? channel}» с ${current} на ${version}?\n\n`
        + 'Пилоты получат её при следующей проверке обновлений как обычное обновление.'
      : `Перевести канал «${CHANNEL_LABELS[channel] ?? channel}» на версию ${version}?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await authFetch('/api/admin/uploader/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, version }),
      });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMessage(`Канал «${CHANNEL_LABELS[channel] ?? channel}» переведён на ${version}`);
      await refresh();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось перевести канал');
    } finally {
      setBusy(false);
    }
  }, [channels, refresh]);

  return (
    <div>
      <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        Обновления Colonial Helper
        <button className="btn btn-cyan" style={{ fontSize: 12 }} onClick={() => void refresh()}>
          <IconRefresh size={12} /> Обновить
        </button>
      </h2>
      <p style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6, maxWidth: 780 }}>
        Программа обновляется пакетом кода: пилот скачивает только изменившиеся модули
        (обычно десятки килобайт), а 22-мегабайтный exe остаётся прежним. Версии публикует
        CI после тестов; здесь их видно и можно вернуть канал назад.
      </p>

      {error && (
        <p style={{ color: '#e74c3c', fontSize: 13 }}><IconAlert size={12} /> {error}</p>
      )}
      {message && (
        <p style={{ color: '#2ecc71', fontSize: 13 }}><IconCheckCircle size={12} /> {message}</p>
      )}

      {store && (
        <div style={{ background: '#1e2124', border: '1px solid #2d3033', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13 }}>
          <div style={{ color: '#9ca3af' }}>Хранилище: <code>{store.root}</code> — {store.ready ? 'готово' : 'каталога ещё нет (появится при первой публикации)'}</div>
          <div style={{ color: store.publishConfigured ? '#9ca3af' : '#f1c40f' }}>
            Токен публикации: {store.publishConfigured ? 'задан' : 'НЕ задан — CI не сможет опубликовать версию (UPLOADER_PUBLISH_TOKEN)'}
          </div>
          <div style={{ color: store.keyIds.length ? '#9ca3af' : '#f1c40f' }}>
            Ключи подписи: {store.keyIds.length ? store.keyIds.join(', ') : 'не настроены — сервер не проверяет подпись (UPLOADER_SIGN_PUBLIC_KEYS)'}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {Object.entries(channels).map(([channel, info]) => (
          <div key={channel} style={{ background: '#1e2124', border: '1px solid #2d3033', borderRadius: 8, padding: 14, minWidth: 240 }}>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>{CHANNEL_LABELS[channel] ?? channel}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e67e22' }}>{info.version || '—'}</div>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>{info.version ? formatDate(info.released_at) : 'ничего не опубликовано'}</div>
          </div>
        ))}
      </div>

      {versions.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>
          Версий пока нет. Первая появится после того, как workflow «Publish Colonial Helper bundle»
          отработает с заданными секретами.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>Версия</th>
                <th style={{ padding: '6px 8px' }}>Канал</th>
                <th style={{ padding: '6px 8px' }}>Опубликована</th>
                <th style={{ padding: '6px 8px' }}>Файлов</th>
                <th style={{ padding: '6px 8px' }}>Размер</th>
                <th style={{ padding: '6px 8px' }}>Подпись</th>
                <th style={{ padding: '6px 8px' }}>Перевести канал</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((row) => {
                const inStable = channels.stable?.version === row.version;
                const inBeta = channels.beta?.version === row.version;
                return (
                  <tr key={row.version} style={{ borderTop: '1px solid #2d3033' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'ui-monospace, monospace' }}>{row.version}</td>
                    <td style={{ padding: '6px 8px' }}>{CHANNEL_LABELS[row.channel] ?? row.channel}</td>
                    <td style={{ padding: '6px 8px', color: '#9ca3af' }}>{formatDate(row.released_at)}</td>
                    <td style={{ padding: '6px 8px' }}>{row.files}</td>
                    <td style={{ padding: '6px 8px' }}>{formatBytes(row.bytes)}</td>
                    <td style={{ padding: '6px 8px', color: row.signed ? '#2ecc71' : '#e74c3c' }}>
                      {row.signed ? 'есть' : 'нет'}
                    </td>
                    <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-cyan"
                        style={{ fontSize: 11, opacity: inStable ? 0.5 : 1 }}
                        disabled={busy || inStable}
                        onClick={() => void promote('stable', row.version)}
                      >
                        {inStable ? 'в стабильном' : 'в стабильный'}
                      </button>
                      <button
                        className="btn btn-cyan"
                        style={{ fontSize: 11, opacity: inBeta ? 0.5 : 1 }}
                        disabled={busy || inBeta}
                        onClick={() => void promote('beta', row.version)}
                      >
                        {inBeta ? 'в тестовом' : 'в тестовый'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
