'use client';

import { useState } from 'react';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';
import { toast } from '@/components/ui/Toaster';

interface Props { onRouteFound: (route: RoutePoint[]) => void; }
type RingResult = { route: Array<{ name: string; x: number; y: number; z: number; source?: string }>; center?: { name?: string; x: number; y: number; z: number }; ring_radius: number; search_radius: number; max_jump: number; discovered_count: number; synthetic_count: number; anchors: Array<{ name: string }> };

export default function AtlasRingRouteFinder({ onRouteFound }: Props) {
  const [startSystem, setStartSystem] = useState('Sol');
  const [ringRadius, setRingRadius] = useState(23000);
  const [searchRadius, setSearchRadius] = useState(500);
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [progress, setProgress] = useState({ percent: 0, stage: '', message: '', sector: 0, sectors: 0, found: 0, cached: false, deviation: 0, point: 0, total: 0, replacements: 0 });
  const [result, setResult] = useState<RingResult | null>(null);

  const downloadCsv = () => {
    if (!result) return;
    const quote = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Порядок', 'Система', 'X', 'Y', 'Z', 'Тип', 'Прыжок, св.л.'].map(quote).join(';'),
      ...result.route.map((point, index) => {
        const previous = result.route[index - 1];
        const jump = previous ? Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z).toFixed(2) : '';
        return [index + 1, point.name, point.x.toFixed(6), point.y.toFixed(6), point.z.toFixed(6), point.source === 'triangulated' ? 'Триангуляция' : 'EDSM', jump].map(quote).join(';');
      }),
    ];
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `galactic-ring-${startSystem}.csv`; link.click(); URL.revokeObjectURL(url);
  };

  const search = async () => {
    if (!startSystem.trim()) return;
    setLoading(true); setResult(null); setProgress({ percent: 0, stage: 'start', message: 'Запуск поиска кольцевого маршрута', sector: 0, sectors: 0, found: 0, cached: false, deviation: 0, point: 0, total: 0, replacements: 0 });
    try {
      const res = await fetch('/api/atlas/ring-route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start_system: startSystem, ring_radius: ringRadius, search_radius: searchRadius }) });
      if (!res.ok || !res.body) throw new Error('Не удалось запустить поиск кольца');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = ''; let data: RingResult | null = null;
      const handlePacket = (line: string) => {
        if (!line.trim()) return;
        const packet = JSON.parse(line);
        if (packet.event === 'progress') setProgress((current) => ({ ...current, ...packet.data }));
        if (packet.event === 'error') throw new Error(packet.data?.message || 'Ошибка поиска кольца');
        if (packet.event === 'result') data = packet.data as RingResult;
      };
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) handlePacket(line);
        if (chunk.done) break;
      }
      buffer += decoder.decode();
      if (buffer.trim()) handlePacket(buffer);
      if (!data) throw new Error('Поиск не вернул маршрут');
      const completed = data as RingResult;
      const mapped: RoutePoint[] = completed.route.map((point: any, index: number) => ({ id: -(index + 1), system_name: point.name, x: point.x, y: point.y, z: point.z, sort_order: index, status: 'planned', isHub: false }));
      setResult(completed); onRouteFound(mapped);
      toast(`Кольцо построено: ${completed.route.length} точек`, 'success');
    } catch (error) { toast(error instanceof Error ? error.message : 'Ошибка поиска кольца', 'error'); }
    finally { setLoading(false); }
  };

  const refine = async () => {
    if (!result || refining) return;
    setRefining(true); setProgress((current) => ({ ...current, percent: 0, stage: 'refine', message: 'Подготовка уточнения маршрута', point: 0, total: result.route.length - 2, replacements: 0 }));
    try {
      const res = await fetch('/api/atlas/ring-route/refine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ route: result.route, center: result.center || { x: 25.21875, y: -20.90625, z: 25899.96875 }, ring_radius: result.ring_radius }) });
      if (!res.ok || !res.body) throw new Error('Не удалось запустить уточнение маршрута');
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let refined: any = null;
      const handlePacket = (line: string) => {
        if (!line.trim()) return;
        const packet = JSON.parse(line);
        if (packet.event === 'progress') setProgress((current) => ({ ...current, ...packet.data }));
        if (packet.event === 'error') throw new Error(packet.data?.message || 'Ошибка уточнения маршрута');
        if (packet.event === 'result') refined = packet.data;
      };
      while (true) {
        const chunk = await reader.read(); buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
        const lines = buffer.split('\n'); buffer = lines.pop() || ''; lines.forEach(handlePacket); if (chunk.done) break;
      }
      buffer += decoder.decode(); if (buffer.trim()) handlePacket(buffer);
      if (!refined?.route) throw new Error('Уточнение не вернуло маршрут');
      const mapped: RoutePoint[] = refined.route.map((point: any, index: number) => ({ id: -(index + 1), system_name: point.name, x: point.x, y: point.y, z: point.z, sort_order: index, status: 'planned', isHub: false }));
      setResult({ ...result, route: refined.route }); onRouteFound(mapped);
      toast(`Маршрут уточнён: заменено ${refined.replacements} точек`, 'success');
    } catch (error) { toast(error instanceof Error ? error.message : 'Ошибка уточнения маршрута', 'error'); }
    finally { setRefining(false); }
  };

  return <div className="atlas-route-finder">
    <div className="atlas-search-panel">
      <h3>Галактическое кольцо колонизации</h3>
      <p className="atlas-route-desc">Построение замкнутого маршрута вокруг Sagittarius A*. Разрешены переходы от 1 до 14,99 св.л.; реальные системы EDSM используются как опорные точки, а пропуски заполняются координатными точками.</p>
      <div className="atlas-search-field"><label>Начальная система</label><input value={startSystem} onChange={(e) => setStartSystem(e.target.value)} placeholder="Sol" /></div>
      <div className="atlas-search-field"><label>Удаление от центра: {ringRadius.toLocaleString('ru-RU')} св.л.</label><input type="range" min={100} max={45000} step={100} value={ringRadius} onChange={(e) => setRingRadius(Number(e.target.value))} /></div>
      <div className="atlas-search-field"><label>Радиус поиска известных систем: {searchRadius.toLocaleString('ru-RU')} св.л. (макс. 3000)</label><input type="range" min={50} max={3000} step={50} value={searchRadius} onChange={(e) => setSearchRadius(Number(e.target.value))} /></div>
      <button className="atlas-scan-btn" onClick={search} disabled={loading || !startSystem.trim()}>{loading ? 'Поиск систем кольца...' : 'Построить галактическое кольцо'}</button>
      {loading && <div style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}><span>{progress.message || 'Подготовка поиска...'}</span><strong>{progress.percent}%</strong></div>
        <div style={{ height: 8, background: 'rgba(255,255,255,.08)', borderRadius: 4, overflow: 'hidden' }}><div style={{ height: '100%', width: `${progress.percent}%`, background: 'var(--accent, #65d6a1)', transition: 'width .25s ease' }} /></div>
        {progress.sectors > 0 && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>Сегмент {progress.sector} из {progress.sectors} · найдено в сегменте: {progress.found} · {progress.cached ? 'кэш' : 'EDSM с задержкой'} · отклонение: {progress.deviation.toFixed(1)} св.л.</div>}
      </div>}
    </div>
    {result && <div className="atlas-section">
      <h4>Результат кольцевого маршрута</h4>
      <div className="atlas-route-summary">
        <div className="stat-box"><div className="num">{result.route.length}</div><div className="lbl">Точек маршрута</div></div>
        <div className="stat-box"><div className="num">{result.anchors.length - 1}</div><div className="lbl">Опорных систем</div></div>
        <div className="stat-box"><div className="num">{result.discovered_count}</div><div className="lbl">Найдено EDSM</div></div>
        <div className="stat-box"><div className="num">{result.synthetic_count}</div><div className="lbl">Триангуляций</div></div>
      </div>
      <button className="atlas-scan-btn" style={{ width: '100%', marginTop: 12 }} onClick={downloadCsv}>Скачать кольцо CSV</button>
      <button className="atlas-scan-btn" style={{ width: '100%', marginTop: 8 }} onClick={refine} disabled={refining}>
        {refining ? `Уточнение маршрута: ${progress.percent}%` : 'Уточнить маршрут по известным системам'}
      </button>
      {refining && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--muted)' }}>
        {progress.message} · проверено точек: {progress.point} из {progress.total} · заменено: {progress.replacements} · радиус проверки: 30 св.л.
      </div>}
    </div>}
  </div>;
}
