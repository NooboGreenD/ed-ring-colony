import { createClient } from '@/lib/supabaseServer';
export const revalidate = 60;
export default async function NewsPage() {
  const supabase = await createClient();
  const { data: news } = await supabase
    .from('news')
    .select('*')
    .order('published_at', { ascending: false });
  return (
    <main className="card">
      <div className="kicker">Архив передач</div>
      <h1>Новости экспедиции</h1>
      {(!news || news.length === 0) && (
        <p style={{ color: '#9ca3af' }}>Новостей пока нет.</p>
      )}
      <div className="news-grid">
        {(news ?? []).map((n: any) => (
          <article key={n.id} className="news-item">
            {n.cover_url && (
              <img src={n.cover_url} alt={n.title} className="news-cover" />
            )}
            <div className="news-date">
              {new Date(n.published_at).toLocaleString('ru-RU')}
              {n.author ? ' · ' + n.author : ''}
            </div>
            <h3>{n.title}</h3>
            <div className="news-body">{n.body}</div>
          </article>
        ))}
      </div>
    </main>
  );
}