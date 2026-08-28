import { createClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import { IconStats, IconActivity, IconDone } from '@/components/Icons';

export const revalidate = 60;

export default async function ForumPage() {
  const supabase = await createClient();

  // 1. Категории
  const { data: categories } = await supabase
    .from('forum_categories')
    .select('id, name, slug, description, sort_order')
    .order('sort_order', { ascending: true });

  // 2. Все темы
  const { data: allThreads } = await supabase
    .from('forum_threads')
    .select('id, title, category_id, updated_at, author_id')
    .order('updated_at', { ascending: false })
    .limit(100);

  // 3. Последние 8 постов (без JOIN — отдельно)
  const { data: recentPosts } = await supabase
    .from('forum_posts')
    .select('id, content, created_at, author_id, thread_id')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(8);

  // 4. Загружаем темы для recentPosts
  const threadIds = [...new Set((recentPosts || []).map((p: any) => p.thread_id).filter(Boolean))];
  const { data: postThreads } = threadIds.length
    ? await supabase.from('forum_threads').select('id, title, category_id').in('id', threadIds)
    : { data: [] };
  const threadMap = new Map((postThreads || []).map((t: any) => [t.id, t]));

  // 5. Загружаем категории для recentPosts
  const catIds = [...new Set((postThreads || []).map((t: any) => t.category_id).filter(Boolean))];
  const { data: postCats } = catIds.length
    ? await supabase.from('forum_categories').select('id, name, slug').in('id', catIds)
    : { data: [] };
  const catMap = new Map((postCats || []).map((c: any) => [c.id, c]));

  // 6. Загружаем профили
  const allAuthorIds = [...new Set([
    ...(recentPosts || []).map((p: any) => p.author_id),
    ...(allThreads || []).map((t: any) => t.author_id),
  ].filter(Boolean))];

  const { data: profilesData } = allAuthorIds.length
    ? await supabase.from('profiles').select('id, cmdr_name, avatar_url').in('id', allAuthorIds)
    : { data: [] };
  const profileMap = new Map((profilesData || []).map((p: any) => [p.id, p]));

  // 7. Общая статистика
  const { count: totalThreads } = await supabase.from('forum_threads').select('*', { count: 'exact', head: true });
  const { count: totalPosts } = await supabase.from('forum_posts').select('*', { count: 'exact', head: true }).eq('is_deleted', false);
  const { count: totalUsers } = await supabase.from('profiles').select('*', { count: 'exact', head: true });

  // Подсчёт тем по категориям
  const topicsByCat = new Map<number, number>();
  (allThreads || []).forEach((t: any) => {
    topicsByCat.set(t.category_id, (topicsByCat.get(t.category_id) || 0) + 1);
  });

  // Последняя тема по категории
  const lastByCat = new Map<number, any>();
  (allThreads || []).forEach((t: any) => {
    if (!lastByCat.has(t.category_id)) {
      lastByCat.set(t.category_id, {
        ...t,
        author_name: profileMap.get(t.author_id)?.cmdr_name || 'Unknown',
      });
    }
  });

  return (
    <main className="forum-layout" style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Шапка */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)' }}>
          Форум
        </h1>
        <div style={{ display: 'flex', gap: 12, marginLeft: 'auto' }}>
          <Link href="/forum/latest" className="btn" style={{ padding: '8px 18px', fontSize: 11 }}>
            <IconActivity size={12} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Последние
          </Link>
          <Link href="/forum/search" className="btn" style={{ padding: '8px 18px', fontSize: 11 }}>
            <IconDone size={12} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Поиск
          </Link>
        </div>
      </div>

      <div className="forum-layout-inner">
        {/* Основная таблица категорий */}
        <div className="forum-main">
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="forum-table">
              <thead>
                <tr>
                  <th className="col-topic">Категория</th>
                  <th className="col-replies">Темы</th>
                  <th className="col-views">Посты</th>
                  <th className="col-last">Последнее</th>
                </tr>
              </thead>
              <tbody>
                {(categories || []).map((cat) => {
                  const last = lastByCat.get(cat.id);
                  return (
                    <tr key={cat.id}>
                      <td className="col-topic">
                        <Link href={`/forum/${cat.slug}`} className="forum-cat-name">
                          {cat.name}
                        </Link>
                        {cat.description && (
                          <div className="forum-cat-desc">{cat.description}</div>
                        )}
                      </td>
                      <td className="col-replies" style={{ textAlign: 'center' }}>
                        <span style={{ color: 'var(--orange)', fontWeight: 600 }}>{topicsByCat.get(cat.id) || 0}</span>
                      </td>
                      <td className="col-views" style={{ textAlign: 'center' }}>
                        <span style={{ color: 'var(--muted)' }}>—</span>
                      </td>
                      <td className="col-last">
                        {last ? (
                          <>
                            <Link href={`/forum/thread/${last.id}`} className="forum-topic-title" style={{ fontSize: 12 }}>
                              {last.title}
                            </Link>
                            <div className="forum-last-cell">
                              <span className="forum-last-author">{last.author_name}</span>
                              <span className="forum-last-time"> · {new Date(last.updated_at).toLocaleDateString('ru-RU')}</span>
                            </div>
                          </>
                        ) : (
                          <span style={{ color: 'var(--muted)', fontSize: 11 }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="forum-sidebar">
          {/* Статистика */}
          <div className="recent-posts-panel" style={{ marginBottom: 16 }}>
            <div className="recent-posts-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconStats size={14} />
              Статистика
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalThreads || 0}</div>
                <div className="lbl">Тем</div>
              </div>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalPosts || 0}</div>
                <div className="lbl">Постов</div>
              </div>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalUsers || 0}</div>
                <div className="lbl">Пилотов</div>
              </div>
            </div>
          </div>

          {/* Последние посты */}
          <div className="recent-posts-panel">
            <div className="recent-posts-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconActivity size={14} />
              Последние посты
            </div>
            {(recentPosts || []).map((post: any) => {
              const author = profileMap.get(post.author_id);
              const thread = threadMap.get(post.thread_id);
              const cat = thread ? catMap.get(thread.category_id) : null;
              return (
                <div key={post.id} className="recent-post-item">
                  <img
                    src={author?.avatar_url || '/default-avatar.png'}
                    alt=""
                    className="recent-post-avatar"
                  />
                  <div className="recent-post-body">
                    <Link href={`/forum/thread/${thread?.id}#post-${post.id}`} className="recent-post-thread">
                      {thread?.title || '…'}
                    </Link>
                    <div className="recent-post-author">
                      {author?.cmdr_name || 'Unknown'}
                      {cat && <> · <Link href={`/forum/${cat.slug}`} style={{ color: 'var(--orange)' }}>{cat.name}</Link></>}
                    </div>
                    <div className="recent-post-time">
                      {new Date(post.created_at).toLocaleDateString('ru-RU')}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}
