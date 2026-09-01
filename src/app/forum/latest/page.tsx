import { createClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import { ForumBreadcrumbs } from '@/components/Forum/ForumBreadcrumbs';

export const revalidate = 60;

export default async function ForumLatestPage() {
  const supabase = await createClient();

  const { data: recentPosts } = await supabase
    .from('forum_posts')
    .select('id, content, created_at, author_id, thread_id')
    .eq('is_deleted', false)
    .order('created_at', { ascending: false })
    .limit(30);

  const threadIds = [...new Set((recentPosts || []).map((p: any) => p.thread_id).filter(Boolean))];
  const { data: postThreads } = threadIds.length
    ? await supabase.from('forum_threads').select('id, title, category_id, forum_categories!inner(slug, name)').in('id', threadIds)
    : { data: [] };
  const threadMap = new Map((postThreads || []).map((t: any) => [t.id, t]));

  const authorIds = [...new Set((recentPosts || []).map((p: any) => p.author_id).filter(Boolean))];
  const { data: profilesData } = authorIds.length
    ? await supabase.from('profiles').select('id, cmdr_name, avatar_url').in('id', authorIds)
    : { data: [] };
  const profileMap = new Map((profilesData || []).map((p: any) => [p.id, p]));

  return (
    <main className="forum-layout" style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <ForumBreadcrumbs items={[
        { label: 'Форум', href: '/forum' },
        { label: 'Последние' },
      ]} />

      <h1 style={{ margin: '0 0 20px', fontSize: 20, color: 'var(--orange)', letterSpacing: 3, textTransform: 'uppercase' }}>
        Последние сообщения
      </h1>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <table className="forum-table">
          <thead>
            <tr>
              <th className="col-topic">Тема / Сообщение</th>
              <th className="col-replies">Автор</th>
              <th className="col-last">Дата</th>
            </tr>
          </thead>
          <tbody>
            {(recentPosts || []).map((post: any) => {
              const author = profileMap.get(post.author_id);
              const thread = threadMap.get(post.thread_id);
              const cat = thread?.forum_categories;
              return (
                <tr key={post.id}>
                  <td className="col-topic">
                    <Link href={`/forum/thread/${thread?.id}#post-${post.id}`} className="forum-topic-title">
                      {thread?.title || '…'}
                    </Link>
                    {cat && (
                      <div className="forum-cat-desc">
                        <Link href={`/forum/${cat.slug}`} style={{ color: 'var(--orange)' }}>{cat.name}</Link>
                      </div>
                    )}
                    <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                      {post.content.slice(0, 200)}{post.content.length > 200 ? '…' : ''}
                    </div>
                  </td>
                  <td className="col-replies" style={{ whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--text)' }}>{author?.cmdr_name || 'Unknown'}</span>
                  </td>
                  <td className="col-last" style={{ whiteSpace: 'nowrap' }}>
                    <span className="forum-last-time">{new Date(post.created_at).toLocaleDateString('ru-RU')}</span>
                  </td>
                </tr>
              );
            })}
            {(!recentPosts || recentPosts.length === 0) && (
              <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)', padding: 40 }}>Пока нет сообщений</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
