'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function SectorStatisticsPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  useEffect(() => { fetch(`/api/atlas/sector/${params.id}`).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error); setData(body); }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Ошибка загрузки')); }, [params.id]);
  if (error) return <main className="atlas-page"><Link href="/atlas">← Вернуться в Atlas</Link><h1>Ошибка</h1><p>{error}</p></main>;
  if (!data) return <main className="atlas-page"><p>Загрузка статистики сектора...</p></main>;
  const stat = data.statistics;
  return <main className="atlas-page" style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px' }}>
    <Link href="/atlas" style={{ color: '#8bbcff' }}>← Вернуться к карте галактики</Link>
    <div style={{ marginTop: 28, borderBottom: '1px solid rgba(130,184,255,.25)', paddingBottom: 18 }}>
      <div style={{ color: '#82b8ff', letterSpacing: 3, fontSize: 12 }}>GALACTIC SECTOR {data.id}</div>
      <h1 style={{ fontFamily: 'Eurostile, Orbitron, Rajdhani, sans-serif', color: '#e5f1ff', fontSize: 36, letterSpacing: 2, margin: '8px 0' }}>{data.name}</h1>
      <p style={{ color: '#9fb5cf' }}>Статистика сектора и накопленные данные исследования Atlas</p>
    </div>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14, marginTop: 24 }}>
      <Stat title="Систем в кэше Atlas" value={stat.cached_systems.toLocaleString('ru-RU')} />
      <Stat title="Известных реальных систем" value={stat.known_real_systems.toLocaleString('ru-RU')} />
      <Stat title="Обитаемых систем" value={stat.inhabited_systems == null ? 'Нет данных' : stat.inhabited_systems.toLocaleString('ru-RU')} />
      <Stat title="Изученность сектора" value={stat.explored_percent == null ? 'Уточняется' : `${stat.explored_percent}%`} />
    </section>
    <section style={{ marginTop: 24, padding: 20, background: 'rgba(10,25,48,.55)', border: '1px solid rgba(130,184,255,.2)' }}>
      <h2 style={{ color: '#d8e8ff', fontSize: 18 }}>Координаты региона</h2>
      <p style={{ color: '#9fb5cf', fontFamily: 'ui-monospace, monospace' }}>Центр: X {data.center.x.toFixed(2)} · Y {data.center.y.toFixed(2)} · Z {data.center.z.toFixed(2)}</p>
      <p style={{ color: '#7892ad', fontSize: 12 }}>{data.source}</p>
    </section>
  </main>;
}
function Stat({ title, value }: { title: string; value: string }) { return <div style={{ padding: 18, background: 'rgba(16,36,64,.7)', border: '1px solid rgba(130,184,255,.22)' }}><div style={{ color: '#7892ad', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</div><strong style={{ display: 'block', marginTop: 10, color: '#e5f1ff', fontSize: 24 }}>{value}</strong></div>; }
