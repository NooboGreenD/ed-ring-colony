'use client';

import { useState } from 'react';

interface MarketPrice {
  system_name: string;
  station_name: string;
  commodity_name: string;
  sell_price: number;
  buy_price: number;
  stock: number;
  demand: number;
  reported_at: string;
}

export default function MarketPage() {
  const [commodity, setCommodity] = useState('');
  const [system, setSystem] = useState('');
  const [prices, setPrices] = useState<MarketPrice[]>([]);
  const [loading, setLoading] = useState(false);

  async function search() {
    if (!commodity) return;
    setLoading(true);
    const params = new URLSearchParams({ commodity, ...(system ? { system } : {}) });
    const res = await fetch(`/api/market/search?${params}`);
    const data = await res.json();
    setPrices(data.prices || []);
    setLoading(false);
  }

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1200 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 20 }}>
        РЫНОК РЕСУРСОВ
      </h2>

      <div className="market-search-row">
        <input className="input" placeholder="Товар (например: Steel)" value={commodity} onChange={(e) => setCommodity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <input className="input" placeholder="Система (опционально)" value={system} onChange={(e) => setSystem(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
        <button className="btn btn-orange" onClick={search} disabled={loading}>{loading ? 'Поиск...' : 'Найти'}</button>
      </div>

      {prices.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Система</th><th>Станция</th><th>Товар</th><th>Покупка</th><th>Продажа</th><th>Запас</th><th>Спрос</th></tr>
            </thead>
            <tbody>
              {prices.map((p, i) => (
                <tr key={i}>
                  <td>{p.system_name}</td>
                  <td>{p.station_name}</td>
                  <td>{p.commodity_name}</td>
                  <td style={{ fontFamily: 'ui-monospace' }}>{p.buy_price?.toLocaleString('ru-RU')}</td>
                  <td style={{ fontFamily: 'ui-monospace', color: 'var(--green)' }}>{p.sell_price?.toLocaleString('ru-RU')}</td>
                  <td style={{ fontFamily: 'ui-monospace' }}>{p.stock?.toLocaleString('ru-RU')}</td>
                  <td style={{ fontFamily: 'ui-monospace' }}>{p.demand?.toLocaleString('ru-RU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
