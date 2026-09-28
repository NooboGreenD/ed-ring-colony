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

interface SignKeyConfig {
  id: string;
  publicKey: string;
}

interface StoreInfo {
  root: string;
  ready: boolean;
  versions: number;
  publishConfigured: boolean;
  publishTokenSource: 'env' | 'config' | 'none';
  keyIds: string[];
  envKeyIds: string[];
  configKeys: SignKeyConfig[];
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

  // Настройка канала
  const [showConfig, setShowConfig] = useState(false);
  const [keyId, setKeyId] = useState('');
  const [keyPublic, setKeyPublic] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  // Секрет, который показывается ровно один раз (приватный ключ / токен).
  const [secret, setSecret] = useState<{ title: string; value: string; note: string } | null>(null);

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

  interface ConfigResponse {
    ok?: boolean;
    error?: string;
    store?: StoreInfo;
    generated?: { id: string; publicKey: string; privateKey: string };
    generatedToken?: string;
  }

  const configAction = useCallback(async (
    payload: Record<string, unknown>,
    okMessage: string,
  ): Promise<ConfigResponse | null> => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const response = await authFetch('/api/admin/uploader/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as ConfigResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.store) setStore(data.store);
      setMessage(okMessage);
      return data;
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось сохранить настройки');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const addKey = useCallback(async () => {
    const data = await configAction(
      { action: 'addKey', id: keyId.trim(), publicKey: keyPublic.trim() },
      `Ключ «${keyId.trim()}» добавлен`,
    );
    if (data?.ok) {
      setKeyId('');
      setKeyPublic('');
    }
  }, [configAction, keyId, keyPublic]);

  const generateKey = useCallback(async () => {
    const data = await configAction(
      { action: 'generateKey', id: keyId.trim() || undefined },
      'Пара ключей сгенерирована. Сохраните приватный ключ — он больше не покажется.',
    );
    if (data?.generated) {
      setKeyId('');
      setKeyPublic('');
      setSecret({
        title: `Приватный ключ «${data.generated.id}»`,
        value: data.generated.privateKey,
        note: 'Положите его в секрет CI UPLOADER_SIGN_KEY (и UPLOADER_SIGN_KEY_ID = '
          + `${data.generated.id}). Публичный ключ уже сохранён на сервере. `
          + 'Приватный на сервере не хранится — если потеряете, сгенерируйте новый.',
      });
    }
  }, [configAction, keyId]);

  const removeKey = useCallback(async (id: string) => {
    if (!window.confirm(`Удалить ключ подписи «${id}»?\n\nЕсли им подписаны опубликованные версии, сервер перестанет их проверять.`)) return;
    await configAction({ action: 'removeKey', id }, `Ключ «${id}» удалён`);
  }, [configAction]);

  const saveToken = useCallback(async () => {
    const data = await configAction(
      { action: 'setPublishToken', token: tokenInput.trim() },
      'Токен публикации сохранён',
    );
    if (data?.ok) setTokenInput('');
  }, [configAction, tokenInput]);

  const generateToken = useCallback(async () => {
    const data = await configAction(
      { action: 'generatePublishToken' },
      'Токен публикации сгенерирован. Скопируйте его — он больше не покажется.',
    );
    if (data?.generatedToken) {
      setTokenInput('');
      setSecret({
        title: 'Токен публикации',
        value: data.generatedToken,
        note: 'Положите его в секрет CI UPLOADER_PUBLISH_TOKEN. На сервере хранится только для сравнения и наружу больше не отдаётся.',
      });
    }
  }, [configAction]);

  const clearToken = useCallback(async () => {
    if (!window.confirm('Очистить токен публикации из настроек?\n\nCI не сможет публиковать версии, пока токен не задан (в настройках или в окружении).')) return;
    await configAction({ action: 'clearPublishToken' }, 'Токен публикации очищен');
  }, [configAction]);

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
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <div style={{ color: '#9ca3af' }}>Хранилище: <code>{store.root}</code> — {store.ready ? 'готово' : 'каталога ещё нет (появится при первой публикации)'}</div>
              <div style={{ color: store.publishConfigured ? '#9ca3af' : '#f1c40f' }}>
                Токен публикации: {store.publishConfigured
                  ? `задан (${store.publishTokenSource === 'env' ? 'из окружения' : 'в настройках'})`
                  : 'НЕ задан — CI не сможет опубликовать версию'}
              </div>
              <div style={{ color: store.keyIds.length ? '#9ca3af' : '#f1c40f' }}>
                Ключи подписи: {store.keyIds.length ? store.keyIds.join(', ') : 'не настроены — сервер не проверяет подпись'}
              </div>
            </div>
            <button
              className="btn btn-cyan"
              style={{ fontSize: 12, whiteSpace: 'nowrap' }}
              onClick={() => setShowConfig((value) => !value)}
            >
              {showConfig ? 'Скрыть настройку' : 'Настроить'}
            </button>
          </div>
        </div>
      )}

      {secret && (
        <div style={{ background: '#20140a', border: '1px solid #e67e22', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ color: '#e67e22' }}><IconAlert size={12} /> {secret.title} — показывается один раз</strong>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setSecret(null)}>Скрыть</button>
          </div>
          <code style={{ display: 'block', wordBreak: 'break-all', background: '#0c0c0c', padding: '8px 10px', borderRadius: 6, marginBottom: 8 }}>
            {secret.value}
          </code>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn btn-cyan"
              style={{ fontSize: 12 }}
              onClick={() => { void navigator.clipboard?.writeText(secret.value); setMessage('Скопировано в буфер обмена'); }}
            >
              Копировать
            </button>
            <span style={{ color: '#9ca3af', fontSize: 12 }}>{secret.note}</span>
          </div>
        </div>
      )}

      {store && showConfig && (
        <div style={{ background: '#1a1c1f', border: '1px solid #2d3033', borderRadius: 8, padding: 16, marginBottom: 16, fontSize: 13 }}>
          <h3 style={{ marginTop: 0, marginBottom: 6 }}>Настройка канала обновлений</h3>
          <p style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.6, marginTop: 0 }}>
            Настройки сохраняются в <code>config.json</code> внутри хранилища и складываются с переменными
            окружения. Значения, заданные в окружении сервера, отсюда изменить нельзя — они помечены
            как «из окружения».
          </p>

          {/* --- Ключи подписи --- */}
          <div style={{ borderTop: '1px solid #2d3033', paddingTop: 12, marginTop: 8 }}>
            <strong>Ключи подписи (ed25519)</strong>
            <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
              Публичные ключи, которыми сервер проверяет манифесты при публикации. Приватный ключ должен
              лежать только в секрете CI <code>UPLOADER_SIGN_KEY</code>.
            </p>

            {store.keyIds.length === 0 ? (
              <p style={{ color: '#f1c40f', fontSize: 12 }}>Ключей пока нет — сервер принимает подпись «как есть».</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 10 }}>
                <thead>
                  <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                    <th style={{ padding: '4px 6px' }}>ID</th>
                    <th style={{ padding: '4px 6px' }}>Публичный ключ</th>
                    <th style={{ padding: '4px 6px' }}>Источник</th>
                    <th style={{ padding: '4px 6px' }} />
                  </tr>
                </thead>
                <tbody>
                  {store.envKeyIds.map((id) => (
                    <tr key={`env-${id}`} style={{ borderTop: '1px solid #2d3033' }}>
                      <td style={{ padding: '4px 6px', fontFamily: 'ui-monospace, monospace' }}>{id}</td>
                      <td style={{ padding: '4px 6px', color: '#6b7280' }}>скрыт (в окружении)</td>
                      <td style={{ padding: '4px 6px' }}>из окружения</td>
                      <td style={{ padding: '4px 6px' }} />
                    </tr>
                  ))}
                  {store.configKeys.map((key) => (
                    <tr key={`cfg-${key.id}`} style={{ borderTop: '1px solid #2d3033' }}>
                      <td style={{ padding: '4px 6px', fontFamily: 'ui-monospace, monospace' }}>{key.id}</td>
                      <td style={{ padding: '4px 6px', fontFamily: 'ui-monospace, monospace', color: '#9ca3af', wordBreak: 'break-all' }}>
                        {key.publicKey.slice(0, 12)}…{key.publicKey.slice(-6)}
                      </td>
                      <td style={{ padding: '4px 6px' }}>настройки</td>
                      <td style={{ padding: '4px 6px' }}>
                        <button className="btn" style={{ fontSize: 11 }} disabled={busy} onClick={() => void removeKey(key.id)}>
                          Удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={keyId}
                onChange={(event) => setKeyId(event.target.value)}
                placeholder="ID (напр. k202609)"
                style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', width: 160 }}
              />
              <input
                value={keyPublic}
                onChange={(event) => setKeyPublic(event.target.value)}
                placeholder="Публичный ключ (base64, 32 байта)"
                style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', flex: 1, minWidth: 220, fontFamily: 'ui-monospace, monospace' }}
              />
              <button className="btn btn-cyan" style={{ fontSize: 12 }} disabled={busy || !keyId.trim() || !keyPublic.trim()} onClick={() => void addKey()}>
                Добавить
              </button>
              <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void generateKey()} title="Сервер сгенерирует пару и покажет приватный ключ один раз">
                Сгенерировать пару
              </button>
            </div>
          </div>

          {/* --- Токен публикации --- */}
          <div style={{ borderTop: '1px solid #2d3033', paddingTop: 12, marginTop: 16 }}>
            <strong>Токен публикации</strong>
            <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
              Им CI авторизуется на <code>/api/admin/uploader/publish</code>. Тот же токен должен лежать в
              секрете CI <code>UPLOADER_PUBLISH_TOKEN</code>. Текущий статус:{' '}
              {store.publishTokenSource === 'env' && <span>задан в окружении (здесь не меняется).</span>}
              {store.publishTokenSource === 'config' && <span style={{ color: '#2ecc71' }}>задан в настройках.</span>}
              {store.publishTokenSource === 'none' && <span style={{ color: '#f1c40f' }}>не задан.</span>}
            </p>
            {store.publishTokenSource !== 'env' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder="Свой токен (минимум 16 символов)"
                  style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', flex: 1, minWidth: 220, fontFamily: 'ui-monospace, monospace' }}
                />
                <button className="btn btn-cyan" style={{ fontSize: 12 }} disabled={busy || tokenInput.trim().length < 16} onClick={() => void saveToken()}>
                  Сохранить
                </button>
                <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void generateToken()}>
                  Сгенерировать
                </button>
                {store.publishTokenSource === 'config' && (
                  <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void clearToken()}>
                    Очистить
                  </button>
                )}
              </div>
            )}
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
