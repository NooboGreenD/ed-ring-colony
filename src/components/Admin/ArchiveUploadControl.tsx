'use client';

import { useRef, useState, type HTMLAttributes } from 'react';

import { IconUpload } from '@/components/Icons';
import { postArchiveUpload, uploadArchiveFile, type ArchiveUploadSession } from '@/lib/archiveUploadClient';
import { formatImportBytes, formatImportSpeed } from '@/lib/importProgress';
import { authFetch } from '@/lib/supabaseClient';

/**
 * «Загрузить архив с компьютера» — общий блок карточки «1 · Архив на сервере»
 * в админке фракций и PowerPlay.
 *
 * Для сервера, которому EDSM недоступен (сеть «замораживает» соединения к
 * зарубежным CDN): администратор скачивает дамп у себя и передаёт его сюда
 * кусками (`archiveUploadClient.ts` → маршрут `…/upload`, сервер —
 * `dumpUpload.ts`). Полоса, скорость, «Остановить загрузку», незаконченная
 * загрузка («выберите тот же файл — продолжится», «Удалить»), ссылка на дамп
 * EDSM. Данные-атрибуты — с префиксом раздела (`data-bgs-admin-upload`,
 * `data-pp-admin-upload`), по ним разделы проверяются в тестах.
 */

export interface PendingArchiveUpload {
  active: boolean;
  name: string | null;
  size: number;
  received: number;
  startedAt: string | null;
}

const RUN = '#f0af28';
const DIM = '#6b7280';

function attrs(prefix: string, name: string, value = ''): HTMLAttributes<HTMLElement> {
  return { [`data-${prefix}-${name}`]: value } as HTMLAttributes<HTMLElement>;
}

export default function ArchiveUploadControl({
  endpoint,
  prefix,
  sourceName,
  dumpUrl,
  disabled,
  pending,
  accent,
  onUploadingChange,
  onMessage,
  onSettled,
}: {
  /** `/api/admin/factions/upload`, `/api/admin/powerplay/upload`. */
  endpoint: string;
  /** Префикс данных-атрибутов: `bgs-admin`, `pp-admin`. */
  prefix: string;
  /** Имя файла на EDSM: `systemsPopulated.json.gz`. */
  sourceName: string;
  dumpUrl: string;
  /** Идёт импорт или другое действие — новую загрузку не начинать. */
  disabled: boolean;
  /** Незаконченная загрузка на сервере (из состояния раздела). */
  pending: PendingArchiveUpload | null | undefined;
  accent: string;
  onUploadingChange: (uploading: boolean) => void;
  onMessage: (text: string, isError: boolean) => void;
  /** Загрузка закончилась (как угодно) — раздел перечитывает состояние. */
  onSettled: () => void | Promise<void>;
}) {
  const [upload, setUpload] = useState<ArchiveUploadSession | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const uploadArchive = async (file: File) => {
    const controller = new AbortController();
    abort.current = controller;
    onMessage('', false);
    onUploadingChange(true);
    try {
      const done = await uploadArchiveFile({
        endpoint,
        file,
        fetchImpl: authFetch,
        signal: controller.signal,
        onStart: (session) => setUpload(session),
        onProgress: (sent) => setUpload((current) => (current ? { ...current, sent } : current)),
      });
      onMessage(
        `Архив загружен на сервер: ${formatImportBytes(done.bytes)}${done.sameAsEdsm ? ' — это тот же дамп, что сейчас на EDSM' : ''}. `
          + 'Нажмите «Загрузить данные»: архив разобьётся на куски и запишется в базу, EDSM не понадобится.',
        false,
      );
    } catch (error) {
      if (controller.signal.aborted) {
        onMessage('Загрузка архива остановлена. Принятое осталось на сервере — выберите тот же файл, и загрузка продолжится.', false);
      } else {
        onMessage(`Архив не загружен: ${(error as Error).message}`, true);
      }
    } finally {
      abort.current = null;
      setUpload(null);
      onUploadingChange(false);
      if (fileInput.current) fileInput.current.value = '';
      await onSettled();
    }
  };

  const discardUpload = async () => {
    if (!window.confirm('Удалить незаконченную загрузку архива с сервера?')) return;
    try {
      const result = await postArchiveUpload(endpoint, { action: 'cancel' }, authFetch);
      onMessage(result.removed ? `Незаконченная загрузка удалена — освобождено ${formatImportBytes(result.freed)}` : 'Незаконченной загрузки нет', false);
    } catch (error) {
      onMessage((error as Error).message, true);
    }
    await onSettled();
  };

  const pendingUpload = !upload && pending?.active ? pending : null;
  const fraction = upload ? upload.sent / Math.max(1, upload.size) : 0;
  const speed = upload ? (upload.sent - upload.startOffset) / Math.max(1, (Date.now() - upload.startedAt) / 1000) : 0;

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed #2d3136' }} {...attrs(prefix, 'upload')}>
      {upload ? (
        <>
          <div style={{ color: RUN }} {...attrs(prefix, 'upload-progress')}>
            Загружаю {upload.name}: {formatImportBytes(upload.sent)} из {formatImportBytes(upload.size)}
            {` (${Math.floor(fraction * 100)} %)`}
            {speed > 0 ? ` · ${formatImportSpeed(speed)}` : ''}
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            aria-label="Загружено с компьютера"
            style={{ height: 5, background: '#22252a', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}
          >
            <div style={{ width: `${Math.max(0, Math.min(100, fraction * 100))}%`, height: '100%', background: RUN, transition: 'width 0.5s' }} />
          </div>
          <button
            type="button"
            className="btn btn-danger"
            style={{ fontSize: 12, padding: '3px 8px', marginTop: 6 }}
            onClick={() => abort.current?.abort()}
            {...attrs(prefix, 'action', 'upload-stop')}
          >
            Остановить загрузку
          </button>
        </>
      ) : (
        <>
          {pendingUpload && (
            <div style={{ color: '#fbbf24', marginBottom: 6 }} {...attrs(prefix, 'upload-pending')}>
              Незаконченная загрузка: {pendingUpload.name} — {formatImportBytes(pendingUpload.received)} из {formatImportBytes(pendingUpload.size)}.
              Выберите тот же файл — загрузка продолжится с этого места.{' '}
              <button type="button" className="btn" style={{ fontSize: 11, padding: '1px 6px' }} onClick={() => void discardUpload()} {...attrs(prefix, 'action', 'upload-discard')}>
                Удалить
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn"
            style={{ fontSize: 12, padding: '3px 8px' }}
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
            title={`Передать на сервер ${sourceName}, скачанный на этом компьютере`}
            {...attrs(prefix, 'action', 'upload')}
          >
            <IconUpload size={12} /> Загрузить архив с компьютера
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".gz,application/gzip,application/x-gzip"
            style={{ display: 'none' }}
            {...attrs(prefix, 'upload-input')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void uploadArchive(file);
            }}
          />
          <div style={{ fontSize: 11, color: DIM, marginTop: 4, lineHeight: 1.5 }}>
            Серверу не скачать архив с EDSM (в журнале соединения «замолкают» или «замирают»)? Скачайте{' '}
            <a href={dumpUrl} target="_blank" rel="noreferrer" style={{ color: accent }}>{sourceName}</a> на этом
            компьютере и загрузите его сюда — дальше «Загрузить данные» разобьёт его на куски и запишет в базу без EDSM.
          </div>
        </>
      )}
    </div>
  );
}
