'use client';

import { useState, useCallback } from 'react';
import { IconJournal, IconCheck, IconError, IconBuilding } from '@/components/Icons';
import { getAccessToken } from '@/lib/supabaseClient';

interface ParsedDepot {
  timestamp: string;
  systemName: string;
  constructionName: string;
  constructionProgress: number;
  resourcesRequired: { nameLocalised: string; requiredAmount: number; providedAmount: number }[];
}

interface ParseResult {
  filename: string;
  cmdrName: string | null;
  depotEvents: ParsedDepot[];
  stats: { eventsParsed: number; depotEventsFound: number; fsdJumps: number };
}

export default function JournalPage() {
  const [dragOver, setDragOver] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [parseProgress, setParseProgress] = useState(0);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [importing, setImporting] = useState(false);
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
      const token = getAccessToken();
      const res = await fetch('/api/journal/parse', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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
      const token = getAccessToken();
      const res = await fetch('/api/journal/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          filename: result.filename,
          depotEvents: result.depotEvents,
          contributionEvents: [],
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Import failed');
      }

      setImported(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
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
      {result && result.depotEvents.length > 0 && !imported && (
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
    </div>
  );
}
