"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { nickFromUser } from "@/lib/authProfile";
import { ForumBreadcrumbs } from "@/components/Forum/ForumBreadcrumbs";
import { RecentPosts } from "@/components/Forum/RecentPosts";
import { IconPin, IconLock } from "@/components/Icons";
import { useI18n } from "@/lib/i18n/I18nContext";

interface Thread {
  id: number;
  title: string;
  author_id: string;
  is_pinned: boolean;
  is_locked: boolean;
  views: number;
  created_at: string;
  updated_at: string;
  last_post_at?: string;
  last_post_author?: string;
  forum_posts?: { count: number }[];
  author?: { cmdr_name: string; avatar_url: string | null };
}

interface Category {
  id: number;
  name: string;
  slug: string;
}

interface Props {
  category: Category;
  threads: Thread[];
  totalCount: number;
  totalPages: number;
  currentPage: number;
}

export default function CategoryPageClient({ category, threads, totalCount, totalPages, currentPage }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [newTitle, setNewTitle] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      if (data.user) {
        supabase.from("profiles").select("*").eq("id", data.user.id).maybeSingle().then(({ data: p }) => setProfile(p));
      }
    });
  }, []);

  const createThread = async () => {
    if (!newTitle.trim() || !user) return;
    setCreating(true);
    const name = nickFromUser(user, profile);
    const { data, error } = await supabase.from("forum_threads").insert({
      category_id: category.id,
      title: newTitle.trim(),
      author_id: user.id,
    }).select().single();
    setCreating(false);
    if (error) { alert(error.message); return; }
    setNewTitle("");
    setShowForm(false);
    await supabase.from("forum_posts").insert({
      thread_id: data.id,
      author_id: user.id,
      content: "",
    });
    router.refresh();
  };

  return (
    <div className="forum-layout">
      <div className="forum-main">
        <div className="card">
          <ForumBreadcrumbs items={[
            { label: t("forum.title"), href: "/forum" },
            { label: category.name },
          ]} />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
            <h1 style={{ margin: 0 }}>{category.name}</h1>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              {t("forum.threads")}: {totalCount} · {t("admin.order")} {currentPage} {t("admin.of")} {totalPages || 1}
            </div>
          </div>

          {user && (
            <div style={{ marginBottom: 16 }}>
              {!showForm ? (
                <button onClick={() => setShowForm(true)}>{t("forum.newThread")}</button>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    placeholder={t("forum.threadTitle")}
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    style={{ flex: 1, maxWidth: 400 }}
                    onKeyDown={(e) => e.key === "Enter" && createThread()}
                  />
                  <button onClick={createThread} disabled={creating}>{creating ? t("forum.creating") : t("forum.create")}</button>
                  <button onClick={() => setShowForm(false)} style={{ background: "transparent", color: "var(--muted)", borderColor: "var(--line)" }}>{t("forum.cancel")}</button>
                </div>
              )}
            </div>
          )}

          {threads.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>{t("forum.noThreadsBeFirst")}</p>
          ) : (
            <div style={{ border: "1px solid var(--line)", borderRadius: 3, overflow: "hidden" }}>
              <table className="forum-table">
                <thead>
                  <tr>
                    <th className="col-topic">{t("forum.topic")}</th>
                    <th className="col-author">{t("forum.author")}</th>
                    <th className="col-replies">{t("forum.replies")}</th>
                    <th className="col-views">{t("forum.views")}</th>
                    <th className="col-last">{t("forum.last")}</th>
                  </tr>
                </thead>
                <tbody>
                  {threads.map((t) => (
                    <tr key={t.id}>
                      <td className="col-topic">
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          {t.is_pinned && <span className="forum-pin-badge"><IconPin size={10} color="#e67e22" /></span>}
                          {t.is_locked && <span className="forum-lock-badge"><IconLock size={10} color="#9ca3af" /></span>}
                          <Link href={`/forum/thread/${t.id}`} className="forum-topic-title">
                            {t.title}
                          </Link>
                        </div>
                        <div className="forum-topic-meta">
                          {new Date(t.created_at).toLocaleDateString("ru-RU")}
                        </div>
                      </td>
                      <td className="col-author">
                        <div className="forum-author-cell">
                          <div className="forum-author-avatar" style={{ background: "#25282b" }} />
                          <span className="forum-author-name">{t.author?.cmdr_name || 'Unknown'}</span>
                        </div>
                      </td>
                      <td className="col-replies forum-replies-cell">
                        {t.forum_posts?.[0]?.count ?? 0}
                      </td>
                      <td className="col-views forum-views-cell">
                        {t.views}
                      </td>
                      <td className="col-last forum-last-cell">
                        {t.last_post_at ? (
                          <>
                            <div className="forum-last-author">{t.last_post_author}</div>
                            <div className="forum-last-time">{new Date(t.last_post_at).toLocaleDateString("ru-RU")}</div>
                          </>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {totalPages > 1 && (
            <div style={{ display: "flex", gap: 6, marginTop: 16, justifyContent: "center", flexWrap: "wrap" }}>
              {currentPage > 1 && (
                <Link href={`/forum/${category.slug}?currentPage=${currentPage - 1}`} style={{ padding: "5px 12px", background: "#25282b", border: "1px solid var(--line)", borderRadius: 3, color: "var(--text)", textDecoration: "none", fontSize: 12 }}>
                  {t("forum.back")}
                </Link>
              )}
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <Link
                  key={p}
                  href={`/forum/${category.slug}?currentPage=${p}`}
                  style={{
                    padding: "5px 10px",
                    background: p === currentPage ? "var(--orange)" : "#25282b",
                    border: "1px solid var(--line)",
                    borderRadius: 3,
                    color: p === currentPage ? "#1e2022" : "var(--text)",
                    textDecoration: "none",
                    fontSize: 12,
                    fontWeight: p === currentPage ? 600 : 400,
                  }}
                >
                  {p}
                </Link>
              ))}
              {currentPage < totalPages && (
                <Link href={`/forum/${category.slug}?currentPage=${currentPage + 1}`} style={{ padding: "5px 12px", background: "#25282b", border: "1px solid var(--line)", borderRadius: 3, color: "var(--text)", textDecoration: "none", fontSize: 12 }}>
                  {t("forum.forward")}
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
      <aside className="forum-sidebar">
        <RecentPosts threads={threads.slice(0, 5)} />
      </aside>
    </div>
  );
}
