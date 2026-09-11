'use client';

import { useState, useCallback } from 'react';
import { IconJournal, IconCheck, IconError, IconBuilding } from '@/components/Icons';
import { authFetch } from '@/lib/supabaseClient';

interface ParsedDepot {
  timestamp: string;
  systemName: string;
  marketId: string | null;
  constructionName: string;
  constructionId: string | null;
  constructionProgress: number;
  resourcesRequired: { nameLocalised: string; requiredAmount: number; providedAmount: number }[];
}

interface ParsedContribution {
  timestamp: string;
  systemName: string;
  marketId: string | null;
  commodity: string;
  commodityLocalised: string;
  amount: number;
  total: number;
}

interface ParseResult {
  filename: string;
  cmdrName: string | null;
  depotEvents: ParsedDepot[];
  contributionEvents: ParsedContribution[];
  stats: { eventsParsed: number; depotEventsFound: number; contributionEventsFound: number; fsdJumps: number };
}

export default function JournalPage() {
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const [imported, setImported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    setError(null);
    setResult(null);
    setImported(false);

    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.log')) {
      setError('Только .log файлы');
      return;
    }
    await parseFile(file);
  }, []);

  const handleFileInput = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setResult(null);
    setImported(false);
    await parseFile(file);
  }, []);

  async function parseFile(file: File) {
    setParsing(true);
    setParseProgress(30);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await authFetch('/api/journal/parse', {
        method: 'POST',
        body: formData,
      });

      setParseProgress(70);

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Parse failed');
      }

      const data = await res.json();
      setResult(data);
      setParseProgress(100);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setParsing(false);
    }
  }

  async function handleImport() {
    if (!result) return;
    setImporting(true);
    setError(null);

    try {
      // Construction-depot logs can contain thousands of status snapshots.
      // Send small incremental chunks instead of one giant JSON body/INSERT so
      // a single slow database statement cannot cancel the entire import.
      const BATCH_SIZE = 100;
      const batchCount = Math.max(
        1,
        Math.ceil(result.depotEvents.length / BATCH_SIZE),
        Math.ceil(result.contributionEvents.length / BATCH_SIZE),
      );
      let importId: number | null = null;

      for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
        setImportProgress({ current: batchIndex + 1, total: batchCount });
        const res = await authFetch('/api/journal/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filename: result.filename,
            importId,
            totalEvents: result.depotEvents.length + result.contributionEvents.length,
            finalize: batchIndex === batchCount - 1,
            depotEvents: result.depotEvents.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE),
            contributionEvents: result.contributionEvents.slice(batchIndex * BATCH_SIZE, (batchIndex + 1) * BATCH_SIZE),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Import failed');
        }
        if (!importId && typeof data.importId === 'number') {
          importId = data.importId;
        }
        if (!importId) {
          throw new Error('Сервер не вернул идентификатор импорта');
        }
      }

      setImported(true);
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportProgress(null);
      setImporting(false);
    }
  }

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1200 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 20 }}>
        ЖУРНАЛ CMDR
      </h2>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`journal-dropzone ${dragOver ? 'journal-dropzone-active' : ''}`}
        onClick={() => document.getElementById('journal-file')?.click()}
      >
        <input id="journal-file" type="file" accept=".log" style={{ display: 'none' }} onChange={handleFileInput} />
        <IconJournal size={32} color="#e67e22" />
        <p style={{ marginTop: 12, color: '#9ca3af', fontSize: 14 }}>
          Перетащите .log файл сюда или нажмите для выбора
        </p>
        <p style={{ marginTop: 4, color: '#6b7280', fontSize: 12, fontFamily: 'ui-monospace' }}>
          %USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\
        </p>
      </div>

      {/* Progress */}
      {parsing && (
        <div style={{ margin: '24px 0' }}>
          <div className="journal-progress-bar">
            <div className="journal-progress-fill" style={{ width: `${parseProgress}%` }} />
          </div>
          <p style={{ fontFamily: 'ui-monospace', fontSize: 11, color: '#9ca3af', marginTop: 8, letterSpacing: '2px', textTransform: 'uppercase' }}>
            Парсинг журнала...
          </p>
        </div>
      )}

      {importProgress && (
        <div style={{ margin: '24px 0' }}>
          <div className="journal-progress-bar">
            <div
              className="journal-progress-fill"
              style={{ width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` }}
            />
          </div>
          <p style={{ fontFamily: 'ui-monospace', fontSize: 11, color: '#9ca3af', marginTop: 8, letterSpacing: '2px', textTransform: 'uppercase' }}>
            Импорт пакета {importProgress.current} из {importProgress.total}...
          </p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="journal-error-box" style={{ margin: '24px 0' }}>
          <IconError size={16} color="#e74c3c" />
          <span>{error}</span>
        </div>
      )}

      {/* Stats */}
      {result && (
        <div className="stat-grid" style={{ margin: '24px 0' }}>
          <div className="stat-box">
            <div className="num">{result.stats.eventsParsed}</div>
            <div className="lbl">Событий</div>
          </div>
          <div className="stat-box">
            <div className="num">{result.stats.depotEventsFound}</div>
            <div className="lbl">Строек</div>
          </div>
          <div className="stat-box">
            <div className="num">{result.stats.contributionEventsFound}</div>
            <div className="lbl">Взносов</div>
          </div>
          <div className="stat-box">
            <div className="num">{result.stats.fsdJumps}</div>
            <div className="lbl">Прыжков</div>
          </div>
          {result.cmdrName && (
            <div className="stat-box">
              <div className="num" style={{ fontSize: 16, overflow: 'hidden', textOverflow: 'ellipsis' }}>{result.cmdrName}</div>
              <div className="lbl">CMDR</div>
            </div>
          )}
        </div>
      )}

      {/* Import button */}
      {result && (result.depotEvents.length > 0 || result.contributionEvents.length > 0) && !imported && (
        <button className="btn btn-orange" onClick={handleImport} disabled={importing} style={{ marginBottom: 24 }}>
          {importing ? 'Импорт...' : 'Импортировать в проект'}
        </button>
      )}

      {imported && (
        <div className="journal-success-box" style={{ marginBottom: 24 }}>
          <IconCheck size={16} color="#2ecc71" />
          Импорт завершён
        </div>
      )}

      {/* Events table */}
      {result && result.depotEvents.length > 0 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', color: '#e67e22', marginBottom: 12 }}>
            Найденные объекты стройки
          </h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Система</th>
                  <th>Объект</th>
                  <th>Прогресс</th>
                  <th>Ресурсы</th>
                  <th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {result.depotEvents.map((ev, i) => (
                  <tr key={i}>
                    <td>{ev.systemName}</td>
                    <td>{ev.constructionName}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, height: 4, background: '#25282b', borderRadius: 2, overflow: 'hidden', maxWidth: 80 }}>
                          <div style={{ width: `${ev.constructionProgress}%`, height: '100%', background: '#e67e22' }} />
                        </div>
                        <span style={{ fontFamily: 'ui-monospace', fontSize: 12, color: '#e67e22', minWidth: 36 }}>
                          {ev.constructionProgress.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                    <td>
                      {ev.resourcesRequired.length > 0 ? (
                        <div className="journal-resource-row">
                          {ev.resourcesRequired.map((r, j) => (
                            <div key={j}>
                              {r.nameLocalised}: {r.providedAmount}/{r.requiredAmount}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: '#6b7280' }}>—</span>
                      )}
                    </td>
                    <td style={{ fontFamily: 'ui-monospace', fontSize: 11, color: '#9ca3af' }}>
                      {new Date(ev.timestamp).toLocaleString('ru-RU')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {result && result.contributionEvents.length > 0 && (
        <>
          <h3 style={{ fontSize: 16, fontWeight: 600, letterSpacing: '2px', textTransform: 'uppercase', color: '#60a5fa', margin: '24px 0 12px' }}>
            Взносы в строительство
          </h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Система</th>
                  <th>Товар</th>
                  <th>Сумма в журнале</th>
                  <th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {result.contributionEvents.map((event, index) => (
                  <tr key={`${event.timestamp}-${event.marketId ?? ''}-${event.commodity}-${index}`}>
                    <td>{event.systemName || '—'}</td>
                    <td>{event.commodityLocalised || event.commodity}</td>
                    <td style={{ fontFamily: 'ui-monospace', color: '#60a5fa' }}>{event.amount.toLocaleString('ru-RU')} т</td>
                    <td style={{ fontFamily: 'ui-monospace', fontSize: 11, color: '#9ca3af' }}>
                      {event.timestamp ? new Date(event.timestamp).toLocaleString('ru-RU') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
