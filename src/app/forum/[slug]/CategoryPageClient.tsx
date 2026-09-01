"use client";

import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import { useI18n } from "@/lib/i18n/I18nContext";
import { ForumSearch } from "@/components/Forum/ForumSearch";

interface Thread {
  id: number;
  title: string;
  author_name: string;
  is_pinned: boolean;
  is_locked: boolean;
  views: number;
  posts_count: number;
  created_at: string;
  last_post_at: string;
  last_post_author: string;
}

interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
}

export default function CategoryPageClient({ category, threads: initialThreads, totalCount, totalPages, currentPage }: {
  category: Category;
  threads: Thread[];
  totalCount: number;
  totalPages: number;
  currentPage: number;
}) {
  const { t } = useI18n();
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const createThread = async () => {
    if (!title.trim()) return;
    setCreating(true);
    setError("");
    const res = await fetch("/api/forum/thread", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category_id: category.id, title: title.trim() }),
    });
    const data = await res.json();
    setCreating(false);
    if (!res.ok) { setError(data.error || t('forum.errorLoading')); return; }
    setTitle("");
    setShowForm(false);
    window.location.href = `/forum/thread/${data.thread.id}`;
  };

  return (
    <main className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div>
          <Link href="/forum" style={{ color: "#e67e22", textDecoration: "none" }}>{t('forum.title')}</Link>
          <span style={{ color: "#9ca3af", margin: "0 8px" }}>/</span>
          <span style={{ fontWeight: 600 }}>{category.name}</span>
        </div>
        <ForumSearch />
      </div>

      <p style={{ color: "#9ca3af", marginBottom: 16 }}>{category.description}</p>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div style={{ color: "#9ca3af", fontSize: 14 }}>
          {t('forum.threads')}: {totalCount} · Страница {currentPage} из {totalPages || 1}
        </div>
        <button onClick={() => setShowForm(!showForm)}>{t('forum.newThread')}</button>
      </div>

      {showForm && (
        <div style={{ marginBottom: 16, padding: 16, background: "#25282b", borderRadius: 8 }}>
          <input placeholder={t('forum.threadTitle')} value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={createThread} disabled={creating}>{creating ? t('forum.creating') : t('forum.create')}</button>
            <button onClick={() => setShowForm(false)} style={{ background: "transparent", border: "1px solid #323538" }}>{t('forum.cancel')}</button>
          </div>
          {error && <p style={{ color: "#e74c3c", marginTop: 8 }}>{error}</p>}
        </div>
      )}

      {threads.length === 0 ? (
        <p style={{ color: "#9ca3af", textAlign: "center", padding: 40 }}>{t('forum.noThreadsBeFirst')}</p>
      ) : (
        <div className="forum-threads">
          {threads.map((thread) => (
            <div key={thread.id} className={`forum-thread ${thread.is_pinned ? "pinned" : ""} ${thread.is_locked ? "locked" : ""}`}>
              <div className="forum-thread-main">
                <Link href={`/forum/thread/${thread.id}`} className="forum-thread-title">
                  {thread.is_pinned && <span style={{ color: "#e67e22", marginRight: 6 }}>📌</span>}
                  {thread.is_locked && <span style={{ color: "#e74c3c", marginRight: 6 }}>🔒</span>}
                  {thread.title}
                </Link>
                <div className="forum-thread-meta">
                  {t('forum.author')}: {thread.author_name} · {new Date(thread.created_at).toLocaleDateString("ru-RU")}
                </div>
              </div>
              <div className="forum-thread-stats">
                <div>{thread.posts_count} {t('forum.replies')}</div>
                <div>{thread.views} {t('forum.views')}</div>
              </div>
              <div className="forum-thread-last">
                {thread.last_post_at && (
                  <>
                    <div>{new Date(thread.last_post_at).toLocaleDateString("ru-RU")}</div>
                    <div style={{ fontSize: 12, color: "#9ca3af" }}>{thread.last_post_author}</div>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 24 }}>
          {currentPage > 1 && (
            <Link href={`/forum/${category.slug}?page=${currentPage - 1}`} className="btn btn-cyan">{t('forum.back')}</Link>
          )}
          {currentPage < totalPages && (
            <Link href={`/forum/${category.slug}?page=${currentPage + 1}`} className="btn btn-cyan">{t('forum.forward')}</Link>
          )}
        </div>
      )}
    </main>
  );
}
