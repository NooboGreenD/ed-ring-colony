'use client';

import { useCallback, useEffect, useState, type ReactElement } from 'react';

import { IconAlert, IconCheckCircle, IconRefresh, IconXCircle } from '@/components/Icons';
import type { HelperReleaseJob } from '@/types/helperRelease';
import { uploadLauncherInChunks } from '@/lib/launcherChunkUpload';
import { uploadSetupInChunks, type SetupInfo } from '@/lib/setupChunkUpload';
import { useI18n, type TranslationParams } from '@/lib/i18n/I18nContext';
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
  signed_key: string;
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
  /** Ключ следующего релиза и доверие ему со стороны установленных программ. */
  serverSigningKeyId: string;
  serverSigningClientTrusted: boolean;
  /** Ключи, зашитые в TRUSTED_KEYS установленных программ. */
  clientTrustedKeys: Record<string, string>;
}

interface VersionsResponse {
  ok?: boolean;
  error?: string;
  store?: StoreInfo;
  channels?: Record<string, { version: string; released_at: string }>;
  versions?: VersionRow[];
  job?: HelperReleaseJob | null;
}

/** Подписи каналов: в значении лежит ключ словаря, а не готовый текст. */
const CHANNEL_LABELS: Record<string, string> = {
  stable: 'helper.channelStable',
  beta: 'helper.channelBeta',
};

/** Подпись функции перевода: словари модуля не видят контекст React. */
type TFn = (key: string, params?: TranslationParams) => string;

function channelLabel(channel: string | null | undefined, t: TFn): string {
  if (!channel) return t('helper.channelFallback');
  const key = CHANNEL_LABELS[channel];
  return key ? t(key) : channel;
}

function formatDate(value: string, locale: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '—';
  return new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes: number, t: TFn): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} ${t('mon.unitB')}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} ${t('mon.unitKB')}`;
  return `${(bytes / 1024 / 1024).toFixed(1)} ${t('mon.unitMB')}`;
}

function formatDuration(milliseconds: number, t: TFn): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} ${t('mon.unitSecond')}`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} ${t('mon.unitMinute')} ${String(seconds % 60).padStart(2, '0')} ${t('mon.unitSecond')}`;
}

function jobKindLabel(kind: HelperReleaseJob['kind'], t: TFn): string {
  if (kind === 'launcher') return t('helper.kindLauncher');
  if (kind === 'promote') return t('helper.kindPromote');
  return t('helper.kindPublish');
}

/**
 * Зашит ли ключ в TRUSTED_KEYS установленных программ: подписанные им
 * версии пилоты примут. Для ключей из config.json сверяется и публичный
 * ключ — ID может совпадать, а пара быть другой (ротация с тем же именем).
 */
function clientTrustBadge(store: StoreInfo, id: string, t: TFn, publicKey = ''): ReactElement {
  const known = Object.keys(store.clientTrustedKeys ?? {}).length > 0;
  const trusted = publicKey
    ? store.clientTrustedKeys?.[id] === publicKey
    : Boolean(store.clientTrustedKeys?.[id]);
  if (trusted) return <span style={{ color: '#2ecc71' }}>{t('helper.trustAccepted')}</span>;
  if (!known) return <span style={{ color: '#9ca3af' }}>{t('helper.trustUnknown')}</span>;
  return <span style={{ color: '#fca5a5' }}>{t('helper.trustRejected')}</span>;
}

/**
 * Прокси отвечает на слишком большой запрос HTML-страницей 413 — JSON там
 * нет, поэтому объясняем причину сами, иначе админ видит голый «HTTP 413».
 */
function describeUploadHttpError(status: number, t: TFn): string {
  if (status === 413) {
    return t('helper.upload413');
  }
  return `HTTP ${status}`;
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
  const { t, locale } = useI18n();
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
  // Осознанный выпуск ключом, которого нет в TRUSTED_KEYS клиентов: без
  // галочки сервер такую публикацию отвергнет — иначе пилоты массово
  // остаются на старой версии с «канал недоступен».
  const [allowUntrustedRelease, setAllowUntrustedRelease] = useState(false);
  const [releaseFiles, setReleaseFiles] = useState<File[]>([]);
  const [launcherVersion, setLauncherVersion] = useState('1.0.0');
  const [launcherFile, setLauncherFile] = useState<File | null>(null);
  // Установщик для первичной установки: именно его качают с сайта в профиле
  // и в меню профиля, поэтому он публикуется отдельно от базовой сборки.
  const [setupInfo, setSetupInfo] = useState<SetupInfo | null>(null);
  const [setupDownloadUrl, setSetupDownloadUrl] = useState('');
  const [setupFile, setSetupFile] = useState<File | null>(null);
  const [setupVersion, setSetupVersion] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  // Секрет, который показывается ровно один раз (приватный ключ / токен).
  const [secret, setSecret] = useState<{ title: string; value: string; note: string } | null>(null);
  // Публикация выполняется как серверная задача. Состояние и журнал лежат на
  // диске, поэтому перезагрузка вкладки не превращает процесс в «видимость».
  const [releaseJob, setReleaseJob] = useState<HelperReleaseJob | null>(null);
  const [processLogOpen, setProcessLogOpen] = useState(true);

  // Ключ подписи не входит в TRUSTED_KEYS установленных программ: публикация
  // требует осознанной отметки, а панель предлагает починить канал.
  const untrustedSigning = Boolean(store?.serverSigningConfigured && !store.serverSigningClientTrusted);

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch('/api/admin/uploader/versions', { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setStore(data.store ?? null);
      setChannels(data.channels ?? {});
      setVersions(data.versions ?? []);
      const setupResponse = await authFetch('/api/admin/uploader/setup', { cache: 'no-store' });
      const setupData = (await setupResponse.json().catch(() => ({}))) as {
        ok?: boolean;
        setup?: SetupInfo | null;
        downloadUrl?: string;
      };
      if (setupResponse.ok && setupData.ok) {
        setSetupInfo(setupData.setup ?? null);
        setSetupDownloadUrl(setupData.downloadUrl ?? '');
        setSetupVersion((current) => current || setupData.setup?.version || '');
      }
      setError('');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errVersions'));
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
      setError(exc instanceof Error ? exc.message : t('helper.errProcessLog'));
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
        ? t('helper.launcherPublished', { version: releaseJob.version ?? '' })
        : releaseJob.kind === 'promote'
          ? t('helper.channelPromoted', {
            channel: channelLabel(releaseJob.channel, t),
            version: releaseJob.version ?? '',
          })
          : releaseJob.channel
            ? t('helper.versionPublishedChannel', {
              version: releaseJob.version ?? '',
              channel: channelLabel(releaseJob.channel, t),
            })
            : t('helper.versionPublished', { version: releaseJob.version ?? '' }));
      void refresh();
    } else if (releaseJob.error) {
      setMessage('');
      setError(releaseJob.error);
    }
  }, [refresh, releaseJob]);

  const cancelRelease = useCallback(async () => {
    if (!releaseJob?.active) return;
    if (!window.confirm(t('helper.confirmStop'))) return;
    try {
      const response = await authFetch(`/api/admin/uploader/release?job=${encodeURIComponent(releaseJob.id)}`, { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (data.job) setReleaseJob(data.job);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errStopProcess'));
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
      setMessage(t('helper.copied'));
    } catch {
      setError(t('helper.clipboardDenied'));
    }
  }, [secret]);

  const promote = useCallback(async (channel: string, version: string) => {
    if (releaseJob?.active) {
      setError(t('helper.busyWait'));
      return;
    }
    const current = channels[channel]?.version ?? '';
    const back = Boolean(current && compareVersions(current, version) > 0);
    const question = back
      ? t('helper.confirmRollback', { channel: channelLabel(channel, t), current, version })
      : t('helper.confirmSwitch', { channel: channelLabel(channel, t), version });
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
      setMessage(t('helper.switchStarted', { channel: channelLabel(channel, t) }));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errSwitch'));
    } finally {
      setBusy(false);
    }
  }, [channels, releaseJob]);

  const removeVersion = useCallback(async (version: string) => {
    if (releaseJob?.active) {
      setError(t('helper.busyWait'));
      return;
    }
    if (!window.confirm(t('helper.confirmDeleteVersion', { version }))) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const response = await authFetch('/api/admin/uploader/versions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMessage(t('helper.versionDeleted', { version }));
      await refresh();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errDeleteVersion'));
    } finally {
      setBusy(false);
    }
  }, [refresh, releaseJob]);

  interface ConfigResponse {
    ok?: boolean;
    error?: string;
    store?: StoreInfo;
    generated?: { id: string; publicKey: string; privateKey: string };
    generatedToken?: string;
    resign?: Array<{ channel: string; version: string; action: string; keyId: string }>;
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
      setError(exc instanceof Error ? exc.message : t('helper.errSaveSettings'));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const addKey = useCallback(async () => {
    const data = await configAction(
      { action: 'addKey', id: keyId.trim(), publicKey: keyPublic.trim() },
      t('helper.keyAdded', { key: keyId.trim() }),
    );
    if (data?.ok) {
      setKeyId('');
      setKeyPublic('');
    }
  }, [configAction, keyId, keyPublic]);

  const generateKey = useCallback(async () => {
    const data = await configAction(
      { action: 'generateKey', id: keyId.trim() || undefined },
      t('helper.keyGenerated'),
    );
    if (data?.generated) {
      setKeyId('');
      setKeyPublic('');
      setSecret({
        title: t('helper.privateKeyTitle', { id: data.generated.id }),
        value: data.generated.privateKey,
        note: t('helper.privateKeyNote'),
      });
    }
  }, [configAction, keyId]);

  const removeKey = useCallback(async (id: string) => {
    if (!window.confirm(t('helper.confirmDeleteKey', { id }))) return;
    await configAction({ action: 'removeKey', id }, t('helper.keyDeleted', { id }));
  }, [configAction]);

  const resignChannels = useCallback(async () => {
    if (!window.confirm(t('helper.confirmResign'))) return;
    const data = await configAction({ action: 'resignChannel' }, t('helper.resigned'));
    const outcomes = data?.resign ?? [];
    if (outcomes.length) {
      setMessage(t('helper.resignedSummary', {
        list: outcomes
          .map((item) => (item.action === 'signed'
            ? t('helper.outcomeKey', { channel: item.channel, version: item.version, key: item.keyId })
            : item.action === 'kept'
              ? t('helper.outcomeUpToDate', { channel: item.channel, version: item.version })
              : t('helper.outcomeMissing', { channel: item.channel })))
          .join('; '),
      }));
    }
  }, [configAction]);

  const saveToken = useCallback(async () => {
    const data = await configAction(
      { action: 'setPublishToken', token: tokenInput.trim() },
      t('helper.tokenSaved'),
    );
    if (data?.ok) setTokenInput('');
  }, [configAction, tokenInput]);

  const generateToken = useCallback(async () => {
    const data = await configAction(
      { action: 'generatePublishToken' },
      t('helper.tokenGenerated'),
    );
    if (data?.generatedToken) {
      setTokenInput('');
      setSecret({
        title: t('helper.tokenTitle'),
        value: data.generatedToken,
        note: t('helper.tokenNote'),
      });
    }
  }, [configAction]);

  const clearToken = useCallback(async () => {
    if (!window.confirm(t('helper.confirmClearToken'))) return;
    await configAction({ action: 'clearPublishToken' }, t('helper.tokenCleared'));
  }, [configAction]);

  const importPrivateKey = useCallback(async () => {
    const data = await configAction(
      { action: 'importPrivateKey', id: keyId.trim(), privateKey: privateKeyInput.trim() },
      t('helper.privateKeySaved', { key: keyId.trim() }),
    );
    if (data?.ok) {
      setKeyId('');
      setPrivateKeyInput('');
    }
  }, [configAction, keyId, privateKeyInput]);

  const publishRelease = useCallback(async () => {
    if (releaseJob?.active) {
      setError(t('helper.busyWait'));
      return;
    }
    if (!releaseVersion.trim() || (releaseSource === 'upload' && releaseFiles.length === 0)) return;
    if (untrustedSigning && !allowUntrustedRelease) return;
    const confirmText = releasePromote
      ? t('helper.confirmPublishSwitch', { version: releaseVersion, channel: channelLabel(releaseChannel, t) })
      : t('helper.confirmPublishOnly', { version: releaseVersion, channel: channelLabel(releaseChannel, t) });
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    setMessage(t('helper.hashingStarted'));
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
      if (untrustedSigning && allowUntrustedRelease) form.set('allowUntrustedKey', 'true');
      const paths: string[] = [];
      for (const file of releaseFiles) {
        form.append('files', file, file.name);
        paths.push((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
      }
      form.set('paths', JSON.stringify(paths));
      const response = await authFetch('/api/admin/uploader/release', { method: 'POST', body: form });
      const data = (await response.json().catch(() => ({}))) as VersionsResponse;
      if (!response.ok || !data.ok || !data.job) throw new Error(data.error || describeUploadHttpError(response.status, t));
      setReleaseJob(data.job);
      setProcessLogOpen(true);
      setMessage(t('helper.prepStarted', { version: releaseVersion }));
      setReleaseVersion('');
      setReleaseNotes('');
      setReleaseFiles([]);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errPublish'));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }, [allowUntrustedRelease, releaseChannel, releaseFiles, releaseJob, releaseNotes, releasePromote, releaseSource, releaseVersion, untrustedSigning]);

  const downloadLauncherBuildKit = useCallback(async () => {
    if (!launcherVersion.trim()) return;
    setBusy(true);
    setError('');
    setMessage(t('helper.kitPreparing'));
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
      setMessage(t('helper.kitDownloaded'));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errKit'));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }, [launcherVersion]);

  const publishLauncher = useCallback(async () => {
    if (releaseJob?.active) {
      setError(t('helper.busyWait'));
      return;
    }
    if (!launcherFile || !launcherVersion.trim()) return;
    if (launcherFile.name !== 'ColonialHelper.exe') {
      setError(t('helper.wrongLauncherFile'));
      return;
    }
    setBusy(true);
    setError('');
    setMessage(t('helper.launcherChunksPreparing'));
    try {
      const job = await uploadLauncherInChunks({
        file: launcherFile,
        platform: 'win64',
        version: launcherVersion.trim(),
        fetcher: authFetch,
        onProgress: (uploadedBytes, totalBytes, completedChunks, totalChunks) => {
          const percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
          setMessage(t('helper.launcherUploadProgress', {
            done: formatBytes(uploadedBytes, t),
            total: formatBytes(totalBytes, t),
            percent,
            part: completedChunks,
            parts: totalChunks,
          }));
        },
        onRetry: (nextChunkSize) => {
          setMessage(t('helper.launcherChunkShrink', { size: formatBytes(nextChunkSize, t) }));
        },
      });
      setReleaseJob(job);
      setProcessLogOpen(true);
      setMessage(t('helper.launcherUploadAccepted', { version: launcherVersion }));
      setLauncherFile(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errUploadExe'));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }, [launcherFile, launcherVersion, releaseJob]);

  const publishSetup = useCallback(async () => {
    if (!setupFile || !setupVersion.trim()) return;
    if (setupFile.name !== 'ColonialHelperSetup.exe') {
      setError(t('helper.wrongSetupFile'));
      return;
    }
    setSetupBusy(true);
    setError('');
    setMessage(t('helper.setupUploadPreparing'));
    try {
      const result = await uploadSetupInChunks({
        file: setupFile,
        version: setupVersion.trim(),
        platform: 'win64',
        fetcher: authFetch,
        onProgress: (uploadedBytes, totalBytes, completedChunks, totalChunks) => {
          const percent = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
          setMessage(t('helper.setupUploadProgress', {
            done: formatBytes(uploadedBytes, t),
            total: formatBytes(totalBytes, t),
            percent,
            part: completedChunks,
            parts: totalChunks,
          }));
        },
      });
      setSetupInfo(result.setup);
      setSetupDownloadUrl(result.downloadUrl);
      setSetupFile(null);
      setMessage(t('helper.setupPublished', { version: result.setup?.version ?? setupVersion }));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errSetupUpload'));
      setMessage('');
    } finally {
      setSetupBusy(false);
    }
  }, [setupFile, setupVersion]);

  const removeSetupFile = useCallback(async () => {
    if (!confirm(t('helper.confirmRemoveSetup'))) return;
    setSetupBusy(true);
    setError('');
    try {
      const response = await authFetch('/api/admin/uploader/setup?platform=win64', { method: 'DELETE' });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setSetupInfo(null);
      setSetupDownloadUrl('');
      setMessage(t('helper.setupRemoved'));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t('helper.errSetupRemove'));
    } finally {
      setSetupBusy(false);
    }
  }, []);

  const releaseBusy = busy || releaseJob?.active === true;

  return (
    <div>
      <h2 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        {t('helper.title')}
        <button className="btn btn-cyan" style={{ fontSize: 12 }} onClick={() => void refresh()}>
          <IconRefresh size={12} /> {t('mon.refresh')}
        </button>
      </h2>
      <p style={{ color: '#9ca3af', fontSize: 14, lineHeight: 1.6, maxWidth: 780 }}>
        {t('helper.intro')}
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
          <section style={{ background: '#101820', border: `1px solid ${stateColor}`, borderRadius: 10, padding: 16, marginBottom: 16, boxShadow: '0 10px 30px rgba(0,0,0,.16)' }} aria-label={t('helper.processAria')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: '#9ca3af', fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase' }}>{t('helper.processLog')}</div>
                <h3 style={{ margin: '4px 0 3px', color: '#f3f4f6', fontSize: 16 }}>{jobKindLabel(releaseJob.kind, t)}</h3>
                <div style={{ color: '#9ca3af', fontSize: 12 }}>
                  {releaseJob.version ? t('helper.versionLine', { version: releaseJob.version }) : t('helper.jobOperation')}
                  {releaseJob.channel ? ` · ${channelLabel(releaseJob.channel, t)}` : ''}
                  {' · '}ID <code>{releaseJob.id.slice(0, 8)}</code>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: stateColor, fontWeight: 700, fontSize: 12 }}>
                  {releaseJob.state === 'queued' ? t('helper.stateQueued') : releaseJob.state === 'running' ? t('helper.stateRunning') : releaseJob.state === 'succeeded' ? t('helper.stateSucceeded') : releaseJob.state === 'aborted' ? t('helper.stateAborted') : t('helper.stateFailed')}
                </span>
                {releaseJob.active && (
                  <button className="btn" style={{ fontSize: 11, borderColor: '#e74c3c', color: '#fca5a5' }} onClick={() => void cancelRelease()}>
                    <IconXCircle size={12} /> {t('mon.stop')}
                  </button>
                )}
                <button className="btn" style={{ fontSize: 11 }} onClick={() => void loadReleaseJob(releaseJob.id)}>
                  <IconRefresh size={11} /> {t('helper.refreshLog')}
                </button>
                <button className="btn" style={{ fontSize: 11 }} onClick={() => setProcessLogOpen((open) => !open)}>
                  {processLogOpen ? t('helper.hideLog') : t('helper.showLog')}
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#d1d5db', fontSize: 12, marginBottom: 5 }}>
                <span>{releaseJob.stageLabel} · {releaseJob.message || t('helper.processing')}</span>
                <strong style={{ color: stateColor }}>{Math.round(releaseJob.percent)}%</strong>
              </div>
              <div role="progressbar" aria-label={t('helper.progressAria')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(releaseJob.percent)} style={{ height: 10, borderRadius: 999, background: '#26323c', overflow: 'hidden' }}>
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
                [t('helper.statFiles'), releaseJob.stats.files || '—'],
                [t('helper.statHashed'), releaseJob.stats.hashedFiles ? `${releaseJob.stats.hashedFiles}/${releaseJob.stats.files}` : '—'],
                [t('helper.statSize'), formatBytes(releaseJob.stats.totalBytes, t)],
                [t('helper.statNewBlobs'), releaseJob.stats.storedBlobs || 0],
                ['ZIP', formatBytes(releaseJob.stats.archiveBytes, t)],
                [t('helper.statTime'), formatDuration(duration, t)],
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
                  {t('helper.recentEvents', { count: releaseJob.log.length })}
                </div>
                <div role="log" aria-live="polite" style={{ maxHeight: 210, overflowY: 'auto', padding: '6px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.65 }}>
                  {releaseJob.log.length === 0 && <div style={{ color: '#7f8b96' }}>{t('helper.logEmpty')}</div>}
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
              <div style={{ color: '#9ca3af' }}>{t('helper.store')}: <code>{store.root}</code> — {store.ready ? t('helper.storeReady') : t('helper.storeMissing')}</div>
              <div style={{ color: store.serverSigningConfigured ? '#2ecc71' : '#f1c40f' }}>
                {t('helper.serverSigning')}: {store.serverSigningConfigured
                  ? t('helper.signingReady', { key: store.serverSigningKeyId })
                  : t('helper.signingMissing')}
              </div>
              {store.serverSigningConfigured && (
                <div style={{ color: store.serverSigningClientTrusted ? '#2ecc71' : '#fca5a5' }}>
                  {store.serverSigningClientTrusted
                    ? t('helper.trustKeyInList')
                    : t('helper.trustKeyOut')}
                </div>
              )}
              <div style={{ color: store.keyIds.length ? '#9ca3af' : '#f1c40f' }}>
                {t('helper.signKeys', { list: store.keyIds.length ? store.keyIds.join(', ') : t('helper.notConfigured') })}
                {Object.keys(store.clientTrustedKeys ?? {}).length > 0
                  && t('helper.bakedKeys', { list: Object.keys(store.clientTrustedKeys).join(', ') })}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end' }}>
              <button
                className="btn btn-cyan"
                style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={() => setShowConfig((value) => !value)}
              >
                {showConfig ? t('helper.hideConfig') : t('helper.configure')}
              </button>
              {store.serverSigningConfigured && !store.serverSigningClientTrusted && (
                <button
                  className="btn"
                  style={{ fontSize: 12, whiteSpace: 'nowrap', borderColor: '#e67e22', color: '#e67e22' }}
                  disabled={busy}
                  onClick={() => void resignChannels()}
                  title={t('helper.resignTitle')}
                >
                  {t('helper.resignButton')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {secret && (
        <div style={{ background: '#20140a', border: '1px solid #e67e22', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ color: '#e67e22' }}><IconAlert size={12} /> {secret.title} — {t('helper.secretOnce')}</strong>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setSecret(null)}>{t('helper.hide')}</button>
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
              {t('helper.copy')}
            </button>
            <span style={{ color: '#9ca3af', fontSize: 12 }}>{secret.note}</span>
          </div>
        </div>
      )}

      {store && showConfig && (
        <div style={{ background: '#1a1c1f', border: '1px solid #2d3033', borderRadius: 8, padding: 16, marginBottom: 16, fontSize: 13 }}>
          <h3 style={{ marginTop: 0, marginBottom: 6 }}>{t('helper.configTitle')}</h3>
          <p style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.6, marginTop: 0 }}>
            {t('helper.configNote1')} <code>config.json</code> {t('helper.configNote2')}
          </p>

          {/* --- Ключи подписи --- */}
          <div style={{ borderTop: '1px solid #2d3033', paddingTop: 12, marginTop: 8 }}>
            <strong>{t('helper.signKeysTitle')}</strong>
            <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
              {t('helper.signKeysNote1')} <code>config.json</code> {t('helper.signKeysNote2')}
            </p>

            {store.keyIds.length === 0 ? (
              <p style={{ color: '#f1c40f', fontSize: 12 }}>{t('helper.noKeysYet')}</p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 10 }}>
                <thead>
                  <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                    <th style={{ padding: '4px 6px' }}>ID</th>
                    <th style={{ padding: '4px 6px' }}>{t('helper.colPublicKey')}</th>
                    <th style={{ padding: '4px 6px' }}>{t('helper.colSource')}</th>
                    <th style={{ padding: '4px 6px' }}>{t('helper.colClients')}</th>
                    <th style={{ padding: '4px 6px' }} />
                  </tr>
                </thead>
                <tbody>
                  {store.envKeyIds.map((id) => (
                    <tr key={`env-${id}`} style={{ borderTop: '1px solid #2d3033' }}>
                      <td style={{ padding: '4px 6px', fontFamily: 'ui-monospace, monospace' }}>{id}</td>
                      <td style={{ padding: '4px 6px', color: '#6b7280' }}>{t('helper.hiddenInEnv')}</td>
                      <td style={{ padding: '4px 6px' }}>{t('helper.fromEnv')}</td>
                      <td style={{ padding: '4px 6px' }}>{clientTrustBadge(store, id, t)}</td>
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
                        {key.hasPrivate ? <span style={{ color: '#2ecc71' }}>{t('helper.serverPair')}</span> : t('helper.publicOnly')}
                      </td>
                      <td style={{ padding: '4px 6px' }}>{clientTrustBadge(store, key.id, t, key.publicKey)}</td>
                      <td style={{ padding: '4px 6px' }}>
                        <button className="btn" style={{ fontSize: 11 }} disabled={busy} onClick={() => void removeKey(key.id)}>
                          {t('helper.delete')}
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
                placeholder={t('helper.keyIdPlaceholder')}
                style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', width: 160 }}
              />
              <input
                value={keyPublic}
                onChange={(event) => setKeyPublic(event.target.value)}
                placeholder={t('helper.publicKeyPlaceholder')}
                style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', flex: 1, minWidth: 220, fontFamily: 'ui-monospace, monospace' }}
              />
              <button className="btn btn-cyan" style={{ fontSize: 12 }} disabled={busy || !keyId.trim() || !keyPublic.trim()} onClick={() => void addKey()}>
                {t('helper.add')}
              </button>
              <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void generateKey()} title={t('helper.generatePairTitle')}>
                {t('helper.generatePair')}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <input
                value={privateKeyInput}
                onChange={(event) => setPrivateKeyInput(event.target.value)}
                placeholder={t('helper.privateSeedPlaceholder')}
                type="password"
                autoComplete="off"
                style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', flex: 1, minWidth: 280, fontFamily: 'ui-monospace, monospace' }}
              />
              <button className="btn" style={{ fontSize: 12 }} disabled={busy || !keyId.trim() || !privateKeyInput.trim()} onClick={() => void importPrivateKey()}>
                {t('helper.importPrivate')}
              </button>
            </div>
          </div>

          {/* --- Токен публикации (необязательная совместимость) --- */}
          <div style={{ borderTop: '1px solid #2d3033', paddingTop: 12, marginTop: 16 }}>
            <strong>{t('helper.externalPublish')}</strong>
            <p style={{ color: '#9ca3af', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
              {t('helper.tokenNote1')}
              <code> /api/admin/uploader/publish</code>{t('helper.tokenNote2')}{' '}
              {store.publishTokenSource === 'env' && <span>{t('helper.tokenEnv')}</span>}
              {store.publishTokenSource === 'config' && <span style={{ color: '#2ecc71' }}>{t('helper.tokenConfig')}</span>}
              {store.publishTokenSource === 'none' && <span style={{ color: '#f1c40f' }}>{t('helper.tokenNone')}</span>}
            </p>
            {store.publishTokenSource !== 'env' && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  placeholder={t('helper.tokenPlaceholder')}
                  style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '6px 8px', color: '#e5e7eb', flex: 1, minWidth: 220, fontFamily: 'ui-monospace, monospace' }}
                />
                <button className="btn btn-cyan" style={{ fontSize: 12 }} disabled={busy || tokenInput.trim().length < 16} onClick={() => void saveToken()}>
                  {t('helper.save')}
                </button>
                <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void generateToken()}>
                  {t('helper.generate')}
                </button>
                {store.publishTokenSource === 'config' && (
                  <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => void clearToken()}>
                    {t('helper.clear')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ background: '#1a1c1f', border: '1px solid #e67e22', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 6px', color: '#e67e22' }}>{t('helper.publishTitle')}</h3>
        <p style={{ color: '#9ca3af', fontSize: 12, lineHeight: 1.6, marginTop: 0 }}>
          {t('helper.publishNote')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '140px 190px minmax(240px, 1fr)', gap: 8, marginBottom: 8 }}>
          <input value={releaseVersion} onChange={(event) => setReleaseVersion(event.target.value)} placeholder="2.13.1" style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }} />
          <select value={releaseChannel} onChange={(event) => setReleaseChannel(event.target.value)} style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }}>
            <option value="stable">{t('helper.channelStable')}</option>
            <option value="beta">{t('helper.channelTest')}</option>
          </select>
          <select value={releaseSource} onChange={(event) => setReleaseSource(event.target.value as 'server' | 'upload')} style={{ background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }}>
            <option value="server">{t('helper.sourceServer')}</option>
            <option value="upload">{t('helper.sourceUpload')}</option>
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
            <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 8 }}>{t('helper.filesChosen', { count: releaseFiles.length })}</span>
          </div>
        )}
        <textarea value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} placeholder={t('helper.notesPlaceholder')} style={{ width: '100%', minHeight: 68, background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb', resize: 'vertical', marginBottom: 8 }} />
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', color: '#d1d5db', fontSize: 12, marginBottom: 10 }}>
          <input type="checkbox" checked={releasePromote} onChange={(event) => setReleasePromote(event.target.checked)} />
          {t('helper.promoteNow')}
        </label>
        {busy && <progress style={{ width: '100%', height: 8, marginBottom: 8 }} />}
        <button
          className="btn btn-cyan"
          disabled={releaseBusy || (untrustedSigning && !allowUntrustedRelease) || !releaseVersion.trim() || (releaseSource === 'upload' && releaseFiles.length === 0)}
          onClick={() => void publishRelease()}
        >
          {releasePromote ? t('helper.zipPublish') : t('helper.zipOnly')}
        </button>
        {!store?.serverSigningConfigured && <span style={{ color: '#9ca3af', fontSize: 12, marginLeft: 10 }}>{t('helper.keyAuto')}</span>}
        {untrustedSigning && (
          <div style={{ borderTop: '1px dashed #e67e22', marginTop: 12, paddingTop: 10, color: '#fca5a5', fontSize: 12, lineHeight: 1.6 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={allowUntrustedRelease}
                onChange={(event) => setAllowUntrustedRelease(event.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span>
                {t('helper.untrustedNote', { key: store?.serverSigningKeyId ?? '' })}
              </span>
            </label>
          </div>
        )}

        <div style={{ borderTop: '1px solid #2d3033', marginTop: 16, paddingTop: 12 }}>
          <strong>{t('helper.firstBuild')}</strong>
          <p style={{ color: '#9ca3af', fontSize: 12, margin: '4px 0 8px' }}>
            {t('helper.firstBuildNote')}
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 9 }}>
            <input value={launcherVersion} onChange={(event) => setLauncherVersion(event.target.value)} placeholder="1.0.0" aria-label={t('helper.launcherVersionAria')} style={{ width: 120, background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }} />
            <button className="btn btn-cyan" disabled={releaseBusy || !launcherVersion.trim()} onClick={() => void downloadLauncherBuildKit()}>
              {t('helper.downloadKit')}
            </button>
            <span style={{ color: '#6b7280', fontSize: 11 }}>{t('helper.kitContents')}</span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingTop: 9, borderTop: '1px dashed #2d3033' }}>
            <input type="file" accept=".exe,application/vnd.microsoft.portable-executable" onChange={(event) => setLauncherFile(event.target.files?.[0] ?? null)} style={{ color: '#9ca3af', fontSize: 12 }} />
            {launcherFile && <span style={{ color: launcherFile.name === 'ColonialHelper.exe' ? '#9ca3af' : '#fca5a5', fontSize: 11 }}>{t('helper.launcherFileWrong', { name: launcherFile.name })}</span>}
            <button className="btn" disabled={releaseBusy || !launcherFile || launcherFile.name !== 'ColonialHelper.exe' || !launcherVersion.trim()} onClick={() => void publishLauncher()}>{t('helper.uploadLauncher')}</button>
          </div>
        </div>

        <div style={{ borderTop: '1px solid #2d3033', marginTop: 16, paddingTop: 12 }}>
          <strong>{t('helper.setupForPilots')}</strong>
          <p style={{ color: '#9ca3af', fontSize: 12, margin: '4px 0 8px', maxWidth: 760, lineHeight: 1.6 }}>
            {t('helper.setupNote1')}{' '}
            <code style={{ color: '#38bdf8' }}>/api/uploader/download?platform=win64</code>{' '}
            {t('helper.setupNote2')}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ background: '#1e2124', border: '1px solid #2d3033', borderRadius: 8, padding: '8px 12px', minWidth: 250 }}>
              {setupInfo ? (
                <>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>{t('helper.setupPublishedLabel')}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#38bdf8' }}>v{setupInfo.version}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af' }}>
                    {formatBytes(setupInfo.size, t)} · {formatDate(setupInfo.updated_at ?? '', locale)}
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all' }}>
                    {setupInfo.sha256.slice(0, 24)}…
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12, color: '#f1c40f' }}>
                  {t('helper.setupMissing')}
                </div>
              )}
            </div>
            {setupDownloadUrl && (
              <a className="btn btn-cyan" style={{ fontSize: 12 }} href={setupDownloadUrl} download>
                {t('helper.downloadSetup')}
              </a>
            )}
            {setupInfo && (
              <button className="btn" disabled={setupBusy} onClick={() => void removeSetupFile()}>
                {t('helper.removeFromDistribution')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', paddingTop: 9, borderTop: '1px dashed #2d3033' }}>
            <input
              value={setupVersion}
              onChange={(event) => setSetupVersion(event.target.value)}
              placeholder="2.18.36"
              aria-label={t('helper.setupVersionAria')}
              style={{ width: 120, background: '#0c0c0c', border: '1px solid #2d3033', borderRadius: 6, padding: '7px 8px', color: '#e5e7eb' }}
            />
            <input
              type="file"
              accept=".exe,application/vnd.microsoft.portable-executable"
              onChange={(event) => setSetupFile(event.target.files?.[0] ?? null)}
              style={{ color: '#9ca3af', fontSize: 12 }}
            />
            {setupFile && (
              <span style={{ color: setupFile.name === 'ColonialHelperSetup.exe' ? '#9ca3af' : '#fca5a5', fontSize: 11 }}>
                {t('helper.setupFileWrong', { name: setupFile.name })}
              </span>
            )}
            <button
              className="btn btn-orange"
              disabled={setupBusy || !setupFile || setupFile.name !== 'ColonialHelperSetup.exe' || !setupVersion.trim()}
              onClick={() => void publishSetup()}
            >
              {setupBusy ? t('helper.uploading') : t('helper.uploadSetup')}
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {Object.entries(channels).map(([channel, info]) => (
          <div key={channel} style={{ background: '#1e2124', border: '1px solid #2d3033', borderRadius: 8, padding: 14, minWidth: 240 }}>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>{channelLabel(channel, t)}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#e67e22' }}>{info.version || '—'}</div>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>{info.version ? formatDate(info.released_at, locale) : t('helper.nothingPublished')}</div>
          </div>
        ))}
      </div>

      {versions.length === 0 ? (
        <p style={{ color: '#9ca3af', fontSize: 13 }}>
          {t('helper.noVersions')}
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ color: '#9ca3af', textAlign: 'left' }}>
                <th style={{ padding: '6px 8px' }}>{t('helper.colVersion')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.colChannel')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.colPublished')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.statFiles')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.colSize')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.colSignature')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.colDownload')}</th>
                <th style={{ padding: '6px 8px' }}>{t('helper.colSwitch')}</th>
                <th style={{ padding: '6px 8px' }} />
              </tr>
            </thead>
            <tbody>
              {versions.map((row) => {
                const inStable = channels.stable?.version === row.version;
                const inBeta = channels.beta?.version === row.version;
                const keyTrusted = Boolean(row.signed_key && store?.clientTrustedKeys?.[row.signed_key]);
                return (
                  <tr key={row.version} style={{ borderTop: '1px solid #2d3033' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'ui-monospace, monospace' }}>{row.version}</td>
                    <td style={{ padding: '6px 8px' }}>{channelLabel(row.channel, t)}</td>
                    <td style={{ padding: '6px 8px', color: '#9ca3af' }}>{formatDate(row.released_at, locale)}</td>
                    <td style={{ padding: '6px 8px' }}>{row.files}</td>
                    <td style={{ padding: '6px 8px' }}>{formatBytes(row.bytes, t)}</td>
                    <td style={{ padding: '6px 8px', color: row.signed ? (keyTrusted ? '#2ecc71' : '#e67e22') : '#e74c3c' }}
                      title={row.signed ? t('helper.signatureTitle', { key: row.signed_key || '?' }) : t('helper.noSignature')}>
                      {row.signed ? (row.signed_key || t('helper.yes')) : t('helper.no')}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <a
                        className="btn"
                        style={{ fontSize: 11, display: 'inline-block', textDecoration: 'none' }}
                        href={`/api/uploader/bundle/${encodeURIComponent(row.version)}.zip`}
                        download
                      >
                        {t('helper.downloadZip')}
                      </a>
                    </td>
                    <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-cyan"
                        style={{ fontSize: 11, opacity: inStable ? 0.5 : 1 }}
                        disabled={releaseBusy || inStable}
                        onClick={() => void promote('stable', row.version)}
                      >
                        {inStable ? t('helper.inStable') : t('helper.toStable')}
                      </button>
                      <button
                        className="btn btn-cyan"
                        style={{ fontSize: 11, opacity: inBeta ? 0.5 : 1 }}
                        disabled={releaseBusy || inBeta}
                        onClick={() => void promote('beta', row.version)}
                      >
                        {inBeta ? t('helper.inTest') : t('helper.toTest')}
                      </button>
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <button
                        className="btn"
                        style={{ fontSize: 11, color: '#fca5a5' }}
                        disabled={releaseBusy || inStable || inBeta}
                        title={inStable || inBeta ? t('helper.removeFromChannelFirst') : t('helper.deleteVersion')}
                        onClick={() => void removeVersion(row.version)}
                      >
                        {t('helper.delete')}
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
