import { createClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import Starfield from '@/components/Starfield';
import { footerFromContent } from '@/lib/siteFooter';
export const revalidate = 60;
export default async function Home() {
  const supabase = await createClient();
  const { data: c } = await supabase
    .from('site_content')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  const { data: news } = await supabase
    .from('news')
    .select('*')
    .order('published_at', { ascending: false })
    .limit(3);
  const { count: cmdrs } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true });
  const { count: systems } = await supabase
    .from('hubs')
    .select('id', { count: 'exact', head: true });
  const { count: built } = await supabase
    .from('hubs')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'done');
  const kicker = c?.kicker ?? 'Pilots Federation // Priority Transmission';
  const title1 = c?.title1 ?? 'КОЛЬЦО';
  const title2 = c?.title2 ?? 'КОЛОНИЗАЦИИ';
  const manifest =
    c?.manifest ??
    'Командиры! Мы колонизируем системы по кольцу на удалении 20 000–22 000 световых лет от центра галактики. Через каждые 450–500 световых лет — строительный хаб. Присоединяйтесь: везите грузы, стройте звёздные порты, создавайте новую цивилизацию среди звёзд.';
  return (
    <>
      <section className="hero">
        <Starfield />
        <div className="corner tl" />
        <div className="corner br" />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="kicker">{kicker}</div>
          <h1>
            {title1}
            <br />
            {title2}
          </h1>
          <p className="sub">{manifest}</p>
          <div className="btn-row">
            <Link href="/login" className="btn btn-orange">
              &#9656; Принять миссию
            </Link>
            <Link href="/map" className="btn btn-cyan">
              &#8857; Карта кольца
            </Link>
          </div>
        </div>
        <div className="stats">
          <div>
            Cmdrs enlisted:<b>{(cmdrs ?? 0).toLocaleString('ru-RU')}</b>
          </div>
          <div>
            Systems claimed:<b>{(systems ?? 0).toLocaleString('ru-RU')}</b>
          </div>
          <div>
            Facilities built:<b>{(built ?? 0).toLocaleString('ru-RU')}</b>
          </div>
        </div>
        <div className="initiate">Initiate sequence</div>
      </section>
      <section className="card">
        <div className="kicker">Передачи // Ход экспедиции</div>
        <h2 style={{ marginTop: 10 }}>Новостная лента</h2>
        {(!news || news.length === 0) && (
          <p style={{ color: '#9ca3af' }}>
            Новостей пока нет. Первую сводку добавит командование через админ-панель.
          </p>
        )}
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
        <Link href="/news" className="btn btn-cyan" style={{ marginTop: 10 }}>
          Архив всех новостий
        </Link>
      </section>
    </>
  );
}
