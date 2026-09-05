"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nContext";
import { IconStats, IconActivity, IconDone } from "@/components/Icons";

interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  sort_order: number;
}

interface Thread {
  id: number;
  title: string;
  category_id: number;
  updated_at: string;
  author_name: string;
}

interface Post {
  id: number;
  content: string;
  created_at: string;
  author_id: string;
  thread_id: number;
}

interface Profile {
  id: string;
  cmdr_name: string;
  avatar_url: string | null;
}

export default function ForumPage() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [allThreads, setAllThreads] = useState<Thread[]>([]);
  const [recentPosts, setRecentPosts] = useState<Post[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [threadMap, setThreadMap] = useState<Map<number, Thread>>(new Map());
  const [catMap, setCatMap] = useState<Map<number, Category>>(new Map());
  const [stats, setStats] = useState({ totalThreads: 0, totalPosts: 0, totalUsers: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/forum/categories")
      .then((r) => r.json())
      .then((data) => {
        setCategories(data.categories || []);
        setAllThreads(data.allThreads || []);
        setRecentPosts(data.recentPosts || []);
        setProfiles(data.profiles || []);
        setThreadMap(new Map((data.allThreads || []).map((t: Thread) => [t.id, t])));
        setCatMap(new Map((data.categories || []).map((c: Category) => [c.id, c])));
        setStats({
          totalThreads: data.totalThreads || 0,
          totalPosts: data.totalPosts || 0,
          totalUsers: data.totalUsers || 0,
        });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  const topicsByCat = new Map<number, number>();
  allThreads.forEach((t) => {
    topicsByCat.set(t.category_id, (topicsByCat.get(t.category_id) || 0) + 1);
  });

  const lastByCat = new Map<number, Thread>();
  allThreads.forEach((t) => {
    if (!lastByCat.has(t.category_id)) {
      lastByCat.set(t.category_id, t);
    }
  });

  if (loading) {
    return (
      <main className="forum-layout" style={{ padding: "24px 28px", maxWidth: 1400, margin: "0 auto" }}>
        <p>{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="forum-layout" style={{ padding: "24px 28px", maxWidth: 1400, margin: "0 auto" }}>
      {/* Шапка */}
      <div style={{ marginBottom: 24, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 4, textTransform: "uppercase", color: "var(--orange)" }}>
          {t("forum.title")}
        </h1>
        <div style={{ display: "flex", gap: 12, marginLeft: "auto" }}>
          <Link href="/forum/latest" className="btn" style={{ padding: "8px 18px", fontSize: 11 }}>
            <IconActivity size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
            {t("forum.latest")}
          </Link>
          <Link href="/forum/search" className="btn" style={{ padding: "8px 18px", fontSize: 11 }}>
            <IconDone size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />
            {t("forum.search")}
          </Link>
        </div>
      </div>

      <div className="forum-layout-inner">
        {/* Основная таблица категорий */}
        <div className="forum-main">
          <div className="card" style={{ padding: 0, overflow: "hidden" }}>
            <table className="forum-table">
              <thead>
                <tr>
                  <th className="col-topic">{t("forum.category")}</th>
                  <th className="col-replies">{t("forum.threads")}</th>
                  <th className="col-views">{t("forum.posts")}</th>
                  <th className="col-last">{t("forum.last")}</th>
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
                      <td className="col-replies" style={{ textAlign: "center" }}>
                        <span style={{ color: "var(--orange)", fontWeight: 600 }}>{topicsByCat.get(cat.id) || 0}</span>
                      </td>
                      <td className="col-views" style={{ textAlign: "center" }}>
                        <span style={{ color: "var(--muted)" }}>—</span>
                      </td>
                      <td className="col-last">
                        {last ? (
                          <>
                            <Link href={`/forum/thread/${last.id}`} className="forum-topic-title" style={{ fontSize: 12 }}>
                              {last.title}
                            </Link>
                            <div className="forum-last-cell">
                              <span className="forum-last-author">{last.author_name}</span>
                              <span className="forum-last-time"> · {new Date(last.updated_at).toLocaleDateString("ru-RU")}</span>
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "var(--muted)", fontSize: 11 }}>—</span>
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
            <div className="recent-posts-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconStats size={14} />
              {t("forum.statistics")}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{stats.totalThreads}</div>
                <div className="lbl">{t("forum.threads")}</div>
              </div>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{stats.totalPosts}</div>
                <div className="lbl">{t("forum.posts")}</div>
              </div>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{stats.totalUsers}</div>
                <div className="lbl">{t("forum.pilots")}</div>
              </div>
            </div>
          </div>

          {/* Последние посты */}
          <div className="recent-posts-panel">
            <div className="recent-posts-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <IconActivity size={14} />
              {t("forum.latestPosts")}
            </div>
            {(recentPosts || []).map((post) => {
              const author = profileMap.get(post.author_id);
              const thread = threadMap.get(post.thread_id);
              const cat = thread ? catMap.get(thread.category_id) : null;
              return (
                <div key={post.id} className="recent-post-item">
                  <img
                    src={author?.avatar_url || "/default-avatar.png"}
                    alt=""
                    className="recent-post-avatar"
                  />
                  <div className="recent-post-body">
                    <Link href={`/forum/thread/${thread?.id}#post-${post.id}`} className="recent-post-thread">
                      {thread?.title || "…"}
                    </Link>
                    <div className="recent-post-author">
                      {author?.cmdr_name || "Unknown"}
                      {cat && <> · <Link href={`/forum/${cat.slug}`} style={{ color: "var(--orange)" }}>{cat.name}</Link></>}
                    </div>
                    <div className="recent-post-time">
                      {new Date(post.created_at).toLocaleDateString("ru-RU")}
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
