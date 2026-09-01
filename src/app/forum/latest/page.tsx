"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nContext";

interface Post {
  id: number;
  content: string;
  created_at: string;
  author_name: string;
  thread_id: number;
  thread_title: string;
  category_slug?: string;
  category_name?: string;
}

export default function LatestPage() {
  const { t } = useI18n();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/forum/latest')
      .then(r => r.json())
      .then(data => {
        setPosts(data.posts || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <main className="card"><p>{t('common.loading')}</p></main>;

  return (
    <main className="card">
      <h1>
        <Link href="/forum" style={{ color: "#e67e22", textDecoration: "none" }}>{t('forum.title')}</Link>
        <span style={{ color: "#9ca3af", margin: "0 8px" }}>/</span>
        {t('forum.latest')}
      </h1>

      <h2 style={{ marginTop: 16, fontSize: 18 }}>{t('forum.latestMessages')}</h2>

      {!posts?.length ? (
        <p style={{ color: "#9ca3af", textAlign: "center", padding: 40 }}>{t('forum.noMessages')}</p>
      ) : (
        <div className="forum-latest-posts">
          {posts.map((post) => (
            <div key={post.id} className="forum-latest-post">
              <div className="forum-latest-post-thread">
                <Link href={`/forum/thread/${post.thread_id}`} style={{ color: "#e67e22", textDecoration: "none", fontWeight: 500 }}>
                  {post.thread_title || t('forum.noTopicsYet')}
                </Link>
                {post.category_name && (
                  <span style={{ fontSize: 12, color: "#9ca3af" }}>
                    {" "}·{" "}
                    <Link href={`/forum/${post.category_slug}`} style={{ color: "#9ca3af" }}>
                      {post.category_name}
                    </Link>
                  </span>
                )}
              </div>
              <div className="forum-latest-post-content">
                {post.content.slice(0, 200)}{post.content.length > 200 ? "…" : ""}
              </div>
              <div className="forum-latest-post-meta">
                {post.author_name || "Unknown"} · {new Date(post.created_at).toLocaleDateString("ru-RU")}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
