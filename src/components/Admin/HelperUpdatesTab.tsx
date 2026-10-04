'use client';

import { useCallback, useEffect, useState } from 'react';

import { IconAlert, IconCheckCircle, IconRefresh, IconXCircle } from '@/components/Icons';
import type { HelperReleaseJob } from '@/types/helperRelease';
import { authFetch } from '@/lib/supabaseClient';

/**
 * Админка → «Обновления Helper»: что сейчас получают пилоты.
 *
 * Сервер сам собирает и подписывает пакет из выбранного каталога: внешний CI
 * не нужен. Здесь же загружается редкая базовая сборка, выбирается канал и
 * выполняется откат. Все версии остаются на диске, поэтому смена указателя
 * канала мгновенна, а Helper применяет её обычным обновлением.
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
  hasPrivate: boolean;
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
  serverSigningConfigured: boolean;
}

interface VersionsResponse {
  ok?: boolean;
  error?: string;
  store?: StoreInfo;
  channels?: Record<string, { version: string; released_at: string }>;
  versions?: VersionRow[];
  job?: HelperReleaseJob | null;
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

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${String(seconds % 60).padStart(2, '0')} с`;
}

function jobKindLabel(kind: HelperReleaseJob['kind']): string {
  if (kind === 'launcher') return 'Базовая сборка EXE';
  if (kind === 'promote') return 'Переключение канала';
  return 'Публикация модулей Helper';
}

function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.replace(/^v/i, '').split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
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
  const [privateKeyInput, setPrivateKeyInput] = useState('');

  // Автономная публикация с сервера.
  const [releaseVersion, setReleaseVersion] = useState('');
  const [releaseChannel, setReleaseChannel] = useState('stable');
  const [releaseNotes, setReleaseNotes] = useState('');
  const [releaseSource, setReleaseSource] = useState<'server' | 'upload'>('server');
  const [releasePromote, setReleasePromote] = useState(true);
  const [releaseFiles, setReleaseFiles] = useState<File[]>([]);
  const [launcherVersion, setLauncherVersion] = useState('1.0.0');
  const [launcherFile, setLauncherFile] = useState<File | null>(null);
  // Секрет, который показывается ровно один раз (приватный ключ / токен).
  const [secret, setSecret] = useState<{ title: string; value: string; note: string } | null>(null);
  // Публикация выполняется как серверная задача. Состояние и журнал лежат на
  // диске, поэтому перезагрузка вкладки не превращает процесс в «видимость».
  const [releaseJob, setReleaseJob] = useState<HelperReleaseJob | null>(null);
  const [processLogOpen, setProcessLogOpen] = useState(true);

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

  const loadReleaseJob = useCallback(async (id?: string) => {
    try {
      const query = id ? `?job=${encodeURIComponent(id)}` : '';
      const response = await authFetch(`/api/admin/uploader/release${query}`, { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.job) {
        setReleaseJob(data.job);
        setProcessLogOpen(true);
      }
      return data.job ?? null;
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось получить журнал процесса');
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadReleaseJob();
  }, [loadReleaseJob, refresh]);

  useEffect(() => {
    if (!releaseJob?.active) return;
    const timer = window.setInterval(() => void loadReleaseJob(releaseJob.id), 900);
    return () => window.clearInterval(timer);
  }, [loadReleaseJob, releaseJob?.active, releaseJob?.id]);

  useEffect(() => {
    if (!releaseJob || releaseJob.active) return;
    if (releaseJob.state === 'succeeded') {
      setError('');
      setMessage(releaseJob.kind === 'launcher'
        ? `ColonialHelper.exe ${releaseJob.version ?? ''} опубликован на сервере`
        : releaseJob.kind === 'promote'
          ? `Канал «${CHANNEL_LABELS[releaseJob.channel ?? ''] ?? releaseJob.channel ?? 'Helper'}» переведён на ${releaseJob.version ?? 'версию'}`
          : `Версия ${releaseJob.version ?? ''} опубликована${releaseJob.channel ? ` в канал «${CHANNEL_LABELS[releaseJob.channel] ?? releaseJob.channel}»` : ''}`);
      void refresh();
    } else if (releaseJob.error) {
      setMessage('');
      setError(releaseJob.error);
    }
  }, [refresh, releaseJob]);

  const cancelRelease = useCallback(async () => {
    if (!releaseJob?.active) return;
    if (!window.confirm('Остановить текущий процесс? Уже записанные данные останутся в хранилище, канал не будет переключён.')) return;
    try {
      const response = await authFetch(`/api/admin/uploader/release?job=${encodeURIComponent(releaseJob.id)}`, { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.job) setReleaseJob(data.job);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось остановить процесс');
    }
  }, [releaseJob]);

  const copySecret = useCallback(async () => {
    if (!secret) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(secret.value);
      } else {
        const input = document.createElement('textarea');
        input.value = secret.value;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
        input.remove();
      }
      setMessage('Скопировано в буфер обмена');
    } catch {
      setError('Браузер не разрешил доступ к буферу. Скопируйте значение вручную.');
    }
  }, [secret]);

  const promote = useCallback(async (channel: string, version: string) => {
    if (releaseJob?.active) {
      setError('Дождитесь завершения текущей операции Helper');
      return;
    }
    const current = channels[channel]?.version ?? '';
    const back = Boolean(current && compareVersions(current, version) > 0);
    const question = back
      ? `Вернуть канал «${CHANNEL_LABELS[channel] ?? channel}» с ${current} на ${version}?\n\n`
        + 'Пилоты получат её при следующей проверке обновлений как обычное обновление.'
      : `Перевести канал «${CHANNEL_LABELS[channel] ?? channel}» на версию ${version}?`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const response = await authFetch('/api/admin/uploader/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, version, async: true }),
      });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok || !data.job) throw new Error(data.error || `HTTP ${response.status}`);
      setReleaseJob(data.job);
      setProcessLogOpen(true);
      setMessage(`Перевод канала «${CHANNEL_LABELS[channel] ?? channel}» запущен — журнал ниже`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось перевести канал');
    } finally {
      setBusy(false);
    }
  }, [channels, releaseJob]);

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
        note: 'Сохраните резервную копию в защищённом месте. Пара уже записана в закрытом '
          + 'хранилище сервера и будет использоваться для автономной подписи релизов. '
          + 'Важно: базовая сборка Helper должна доверять этому публичному ключу.',
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
        note: 'Нужен только старым внешним скриптам. Публикация из панели использует админскую сессию.',
      });
    }
  }, [configAction]);

  const clearToken = useCallback(async () => {
    if (!window.confirm('Очистить токен внешней публикации?')) return;
    await configAction({ action: 'clearPublishToken' }, 'Токен публикации очищен');
  }, [configAction]);

  const importPrivateKey = useCallback(async () => {
    const data = await configAction(
      { action: 'importPrivateKey', id: keyId.trim(), privateKey: privateKeyInput.trim() },
      `Приватный ключ «${keyId.trim()}» сохранён на сервере`,
    );
    if (data?.ok) {
      setKeyId('');
      setPrivateKeyInput('');
    }
  }, [configAction, keyId, privateKeyInput]);

  const publishRelease = useCallback(async () => {
    if (releaseJob?.active) {
      setError('Дождитесь завершения текущей операции Helper');
      return;
    }
    if (!releaseVersion.trim() || (releaseSource === 'upload' && releaseFiles.length === 0)) return;
    const action = releasePromote ? 'подготовить и сразу включить' : 'только подготовить';
    if (!window.confirm(`${action} версию ${releaseVersion} для канала «${CHANNEL_LABELS[releaseChannel]}»?`)) return;
    setBusy(true);
    setError('');
    setMessage('Сервер считает хеши, подписывает и собирает пакет…');
    try {
      const form = new FormData();
      form.set('kind', 'bundle');
      form.set('version', releaseVersion.trim());
      form.set('channel', releaseChannel);
      form.set('notes', releaseNotes);
      form.set('minLauncher', '1.0.0');
      form.set('source', releaseSource);
      form.set('promote', String(releasePromote));
      form.set('async', 'true');
      const paths: string[] = [];
      for (const file of releaseFiles) {
        form.append('files', file, file.name);
        paths.push((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
      }
      form.set('paths', JSON.stringify(paths));
      const response = await authFetch('/api/admin/uploader/release', { method: 'POST', body: form });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok || !data.job) throw new Error(data.error || `HTTP ${response.status}`);
      setReleaseJob(data.job);
      setProcessLogOpen(true);
      setMessage(`Процесс подготовки версии ${releaseVersion} запущен — прогресс и лог ниже`);
      setReleaseVersion('');
      setReleaseNotes('');
      setReleaseFiles([]);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось опубликовать версию');
      setMessage('');
    } finally {
      setBusy(false);
    }
  }, [releaseChannel, releaseFiles, releaseJob, releaseNotes, releasePromote, releaseSource, releaseVersion]);

  const downloadLauncherBuildKit = useCallback(async () => {
    if (!launcherVersion.trim()) return;
    setBusy(true);
    setError('');
    setMessage('Подготавливаю комплект первой Windows-сборки…');
    try {
      const response = await authFetch(`/api/admin/uploader/build-kit?version=${encodeURIComponent(launcherVersion.trim())}`, { cache: 'no-store' });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `ColonialHelper-build-${launcherVersion.trim().replace(/^v/i, '')}.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
      setMessage('Комплект скачан. Распакуйте его на Windows и запустите BUILD-WINDOWS.bat, затем загрузите готовый EXE ниже.');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось подготовить комплект сборки');
      setMessage('');
    } finally {
      setBusy(false);
    }
  }, [launcherVersion]);

  const publishLauncher = useCallback(async () => {
    if (releaseJob?.active) {
      setError('Дождитесь завершения текущей операции Helper');
      return;
    }
    if (!launcherFile || !launcherVersion.trim()) return;
    setBusy(true);
    setError('');
    setMessage('Загрузка базовой сборки на сервер…');
    try {
      const form = new FormData();
      form.set('kind', 'launcher');
      form.set('platform', 'win64');
      form.set('version', launcherVersion.trim());
      form.set('launcher', launcherFile, launcherFile.name);
      form.set('async', 'true');
      const response = await authFetch('/api/admin/uploader/release', { method: 'POST', body: form });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok || !data.job) throw new Error(data.error || `HTTP ${response.status}`);
      setReleaseJob(data.job);
      setProcessLogOpen(true);
      setMessage(`Загрузка ColonialHelper.exe ${launcherVersion} запущена — журнал ниже`);
      setLauncherFile(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'Не удалось загрузить exe');
      setMessage('');
    } finally {
      setBusy(false);
    }
  }, [launcherFile, launcherVersion, releaseJob]);

  const releaseBusy = busy || releaseJob?.active === true;

  return (
    <div>
      <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        Обновления Colonial Helper
        <button className="btn btn-cyan" style={{ fontSize: 12 }} onClick={() => void refresh()}>
          <IconRefresh size={12} /> Обновить
        </button>
      </h2>
      <p style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6, maxWidth: 780 }}>
        Автономный канал на этом сервере: пилот скачивает только изменившиеся модули
        (обычно десятки килобайт), а базовый exe меняется редко. Сборка, подпись,
        публикация и откат управляются здесь — GitHub и Actions не участвуют.
      </p>

      {error && (
        <p style={{ color: '#e74c3c', fontSize: 13 }}><IconAlert size={12} /> {error}</p>
      )}
      {message && (
        <p style={{ color: '#2ecc71', fontSize: 13 }}><IconCheckCircle size={12} /> {message}</p>
      )}

      {releaseJob && (() => {
        const duration = releaseJob.stats.durationMs > 0
          ? releaseJob.stats.durationMs
          : releaseJob.startedAt
            ? Math.max(0, Date.now() - Date.parse(releaseJob.startedAt))
            : 0;
        const stateColor = releaseJob.state === 'succeeded'
          ? '#2ecc71'
          : releaseJob.state === 'failed'
            ? '#e74c3c'
            : releaseJob.state === 'aborted'
              ? '#f1c40f'
              : '#38bdf8';
        return (
          <section style={{ background: '#101820', border: `1px solid ${stateColor}`, borderRadius: 10, padding: 16, marginBottom: 16, boxShadow: '0 10px 30px rgba(0,0,0,.16)' }} aria-label="Прогресс и журнал процесса Helper">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>Журнал процесса</div>
                <h3 style={{ margin: '4px 0 3px', color: '#f3f4f6', fontSize: 16 }}>{jobKindLabel(releaseJob.kind)}</h3>
                <div style={{ color: '#9ca3af', fontSize: 12 }}>
                  {releaseJob.version ? `Версия ${releaseJob.version}` : 'Операция Helper'}
                  {releaseJob.channel ? ` · ${CHANNEL_LABELS[releaseJob.channel] ?? releaseJob.channel}` : ''}
                  {' · '}ID <code>{releaseJob.id.slice(0, 8)}</code>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: stateColor, fontWeight: 700, fontSize: 12 }}>
                  {releaseJob.state === 'queued' ? 'в очереди' : releaseJob.state === 'running' ? 'выполняется' : releaseJob.state === 'succeeded' ? 'завершено' : releaseJob.state === 'aborted' ? 'остановлено' : 'ошибка'}
                </span>
                {releaseJob.active && (
                  <button className="btn" style={{ fontSize: 11, borderColor: '#e74c3c', color: '#fca5a5' }} onClick={() => void cancelRelease()}>
                    <IconXCircle size={12} /> Остановить
                  </button>
                )}
                <button className="btn" style={{ fontSize: 11 }} onClick={() => void loadReleaseJob(releaseJob.id)}>
                  <IconRefresh size={11} /> Обновить лог
                </button>
                <button className="btn" style={{ fontSize: 11 }} onClick={() => setProcessLogOpen((open) => !open)}>
                  {processLogOpen ? 'Скрыть журнал' : 'Показать журнал'}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#d1d5db', fontSize: 12, marginBottom: 5 }}>
                <span>{releaseJob.stageLabel} · {releaseJob.message || 'обработка…'}</span>
                <strong style={{ color: stateColor }}>{Math.round(releaseJob.percent)}%</strong>
              </div>
              <div role="progressbar" aria-label="Прогресс операции Helper" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(releaseJob.percent)} style={{ height: 10, borderRadius: 999, background: '#26323c', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(0, Math.min(100, releaseJob.percent))}%`, height: '100%', background: stateColor, borderRadius: 999, transition: 'width .35s ease' }} />
              </div>
            </div>

            {releaseJob.error && (
              <div style={{ marginTop: 10, color: '#fca5a5', fontSize: 12, background: 'rgba(127,29,29,.25)', borderRadius: 6, padding: '8px 10px' }}>
                <IconAlert size={12} /> {releaseJob.error}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))', gap: 8, marginTop: 12 }}>
              {[
                ['Файлов', releaseJob.stats.files || '—'],
                ['Хешировано', releaseJob.stats.hashedFiles ? `${releaseJob.stats.hashedFiles}/${releaseJob.stats.files}` : '—'],
                ['Объём', formatBytes(releaseJob.stats.totalBytes)],
                ['Новых blobs', releaseJob.stats.storedBlobs || 0],
                ['ZIP', formatBytes(releaseJob.stats.archiveBytes)],
                ['Время', formatDuration(duration)],
              ].map(([label, value]) => (
                <div key={label} style={{ background: '#17232d', border: '1px solid #26323c', borderRadius: 7, padding: '8px 9px' }}>
                  <div style={{ color: '#7f8b96', fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ color: '#e5e7eb', fontSize: 13, fontWeight: 700, marginTop: 3 }}>{value}</div>
                </div>
              ))}
            </div>

            {processLogOpen && (
              <div style={{ marginTop: 12, background: '#081016', border: '1px solid #26323c', borderRadius: 7, overflow: 'hidden' }}>
                <div style={{ padding: '7px 10px', color: '#7f8b96', fontSize: 11, borderBottom: '1px solid #26323c' }}>
                  Последние события · {releaseJob.log.length} строк
                </div>
                <div role="log" aria-live="polite" style={{ maxHeight: 210, overflowY: 'auto', padding: '6px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.65 }}>
                  {releaseJob.log.length === 0 && <div style={{ color: '#7f8b96' }}>Журнал пока пуст.</div>}
                  {releaseJob.log.map((entry, index) => (
                    <div key={`${entry.at}-${index}`} style={{ color: entry.level === 'error' ? '#fca5a5' : entry.level === 'success' ? '#86efac' : entry.level === 'warning' ? '#fde68a' : '#b7c6d1' }}>
                      <span style={{ color: '#53616d' }}>{new Date(entry.at).toLocaleTimeString('ru-RU')}</span>{' '}{entry.line}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        );
      })()}

      {store && (
        <div style={{ background: '#1e2124', border: '1px solid #2d3033', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div>
              <div style={{ color: '#9ca3af' }}>Хранилище: <code>{store.root}</code> — {store.ready ? 'готово' : 'каталога ещё нет (появится при первой публикации)'}</div>
              <div style={{ color: store.serverSigningConfigured ? '#2ecc71' : '#f1c40f' }}>
                Серверная подпись: {store.serverSigningConfigured
                  ? 'готова — релизы можно выпускать из этой панели'
                  : 'НЕ настроена — создайте или импортируйте приватный ключ'}
              </div>
              <div style={{ color: store.keyIds.length ? '#9ca3af' : '#f1c40f' }}>
                Ключи подписи: {store.keyIds.length ? store.keyIds.join(', ') : 'не настроены'}
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
              onClick={() => void copySecret()}
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
              Сервер проверяет этими ключами манифесты. Для автономной публикации у одного ключа
              должна быть приватная часть. Она хранится в <code>config.json</code> тома с правами 0600
              и никогда не возвращается через API.
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
                      <td style={{ padding: '4px 6px' }}>
                        {key.hasPrivate ? <span style={{ color: '#2ecc71' }}>серверная пара</span> : 'только публичный'}
                      </td>
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
              <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void generateKey()} title="Сервер сохранит пару и покажет приватный ключ для резервной копии">
                Создать серверную пару
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <input
                value={privateKeyInput}
                onChange={(event) => setPrivateKeyInput(event.target.value)}
                placeholder="Приватный seed существующего ключа (base64)"
                type="password"
                autoComplete="off"
                style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', flex: 1, minWidth: 280, fontFamily: 'ui-monospace, monospace' }}
              />
              <button className="btn" style={{ fontSize: 12 }} disabled={busy || !keyId.trim() || !privateKeyInput.trim()} onClick={() => void importPrivateKey()}>
                Импортировать приватный ключ для указанного ID
              </button>
            </div>
          </div>

          {/* --- Токен публикации (необязательная совместимость) --- */}
          <div style={{ borderTop: '1px solid #2d3033', paddingTop: 12, marginTop: 16 }}>
            <strong>Внешняя публикация (необязательно)</strong>
            <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
              Токен нужен только для совместимости с внешним скриптом через
              <code> /api/admin/uploader/publish</code>. Публикация из этой панели работает по
              админской сессии и токена не требует. Текущий статус:{' '}
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

      <div style={{ background: '#1a1c1f', border: '1px solid #e67e22', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 6px', color: '#e67e22' }}>Опубликовать новую версию на сервере</h3>
        <p style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.6, marginTop: 0 }}>
          В обычном режиме сервер сам берёт актуальный Helper из своей установки, подставляет номер
          версии, считает SHA-256, подписывает манифест и формирует готовый ZIP. Загружать файлы или
          запускать сборочные скрипты вручную не требуется. Версия после создания неизменяема.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '140px 190px minmax(240px, 1fr)', gap: 8, marginBottom: 8 }}>
          <input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="2.13.1" style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }} />
          <select value={releaseChannel} onChange={(event) => setReleaseChannel(event.target.value)} style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }}>
            <option value="stable">Стабильный</option>
            <option value="beta">Тестовый</option>
          </select>
          <select value={releaseSource} onChange={(event) => setReleaseSource(event.target.value as 'server' | 'upload')} style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }}>
            <option value="server">Исходники с этого сервера (рекомендуется)</option>
            <option value="upload">Загрузить другой каталог uploader</option>
          </select>
        </div>
        {releaseSource === 'upload' && (
          <div style={{ background: '#141619', border: '1px solid #2d3033', borderRadius: 6, padding: 10, marginBottom: 8 }}>
            <input
              type="file"
              multiple
              {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
              onChange={(event) => {
                const excluded = new Set(['build_exe.py', 'build_bundle.py', 'launcher.py', 'updater.py']);
                const selected = Array.from(event.target.files ?? []).filter((file) => {
                  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
                  const parts = relative.replace(/\\/g, '/').split('/');
                  const name = parts.at(-1) || file.name;
                  return parts.length <= 2 && name.endsWith('.py') && !excluded.has(name);
                });
                setReleaseFiles(selected);
              }}
              style={{ color: '#9ca3af', fontSize: 12 }}
            />
            <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 8 }}>выбрано файлов: {releaseFiles.length}</span>
          </div>
        )}
        <textarea value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder="Что изменилось в этой версии" style={{ width: '100%', minHeight: 68, background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb', resize: 'vertical', marginBottom: 8 }} />
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', color: '#d1d5db', fontSize: 12, marginBottom: 10 }}>
          <input type="checkbox" checked={releasePromote} onChange={(event) => setReleasePromote(event.target.checked)} />
          Сразу переключить выбранный канал на новую версию
        </label>
        {busy && <progress style={{ width: '100%', height: 8, marginBottom: 8 }} />}
        <button
          className="btn btn-cyan"
          disabled={releaseBusy || !store?.serverSigningConfigured || !releaseVersion.trim() || (releaseSource === 'upload' && releaseFiles.length === 0)}
          onClick={() => void publishRelease()}
        >
          {releasePromote ? 'Сформировать ZIP и выпустить обновление' : 'Сформировать ZIP без публикации в канал'}
        </button>
        {!store?.serverSigningConfigured && <span style={{ color: '#f1c40f', fontSize: 12, marginLeft: 10 }}>Сначала настройте серверную пару ключей.</span>}

        <div style={{ borderTop: '1px solid #2d3033', marginTop: 16, paddingTop: 12 }}>
          <strong>Базовая сборка ColonialHelper.exe</strong>
          <p style={{ color: '#9ca3af', fontSize: 12, margin: '4px 0 8px' }}>
            Первичный EXE скачивается пилотом один раз, после чего получает небольшие пакетные обновления.
            Сервер Linux готовит комплект с актуальным кодом и ключами, а сам Windows EXE собирается на доверенной Windows-машине.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 9 }}>
            <input value={launcherVersion} onChange={(event) => setLauncherVersion(event.target.value)} placeholder="1.0.0" aria-label="Версия базовой сборки" style={{ width: 120, background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }} />
            <button className="btn btn-cyan" disabled={releaseBusy || !launcherVersion.trim() || !store?.serverSigningConfigured} onClick={() => void downloadLauncherBuildKit()}>
              Создать первичный EXE — скачать комплект
            </button>
            <span style={{ color: '#6b7280', fontSize: 11 }}>В ZIP: BUILD-WINDOWS.bat и инструкция</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingTop: 9, borderTop: '1px dashed #2d3033' }}>
            <input type="file" accept=".exe,application/vnd.microsoft.portable-executable" onChange={(event) => setLauncherFile(event.target.files?.[0] ?? null)} style={{ color: '#9ca3af', fontSize: 12 }} />
            <button className="btn" disabled={releaseBusy || !launcherFile || !launcherVersion.trim()} onClick={() => void publishLauncher()}>Загрузить готовый EXE на сервер</button>
          </div>
        </div>
      </div>

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
          Версий пока нет. Настройте серверную пару ключей и опубликуйте первую версию формой выше.
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
                <th style={{ padding: '6px 8px' }}>Файл скачивания</th>
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
                    <td style={{ padding: '6px 8px' }}>
                      <a
                        className="btn"
                        style={{ fontSize: 11, display: 'inline-block', textDecoration: 'none' }}
                        href={`/api/uploader/bundle/${encodeURIComponent(row.version)}.zip`}
                        download
                      >
                        Скачать ZIP
                      </a>
                    </td>
                    <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-cyan"
                        style={{ fontSize: 11, opacity: inStable ? 0.5 : 1 }}
                        disabled={releaseBusy || inStable}
                        onClick={() => void promote('stable', row.version)}
                      >
                        {inStable ? 'в стабильном' : 'в стабильный'}
                      </button>
                      <button
                        className="btn btn-cyan"
                        style={{ fontSize: 11, opacity: inBeta ? 0.5 : 1 }}
                        disabled={releaseBusy || inBeta}
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
