"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nContext";
import { ForumBreadcrumbs } from "@/components/Forum/ForumBreadcrumbs";

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

export default function ForumLatestPage() {
  const { t } = useI18n();
  const [recentPosts, setRecentPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/forum/latest")
      .then((r) => r.json())
      .then((data) => {
        setRecentPosts(data.posts || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <main className="forum-layout" style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>
        <p>{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="forum-layout" style={{ padding: "24px 28px", maxWidth: 1200, margin: "0 auto" }}>
      <ForumBreadcrumbs items={[
        { label: t("forum.title"), href: "/forum" },
        { label: t("forum.latest") },
      ]} />

      <h1 style={{ margin: "0 0 20px", fontSize: 20, color: "var(--orange)", letterSpacing: 3, textTransform: "uppercase" }}>
        {t("forum.latestMessages")}
      </h1>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <table className="forum-table">
          <thead>
            <tr>
              <th className="col-topic">{t("forum.topicMessage")}</th>
              <th className="col-replies">{t("forum.author")}</th>
              <th className="col-last">{t("forum.date")}</th>
            </tr>
          </thead>
          <tbody>
            {(recentPosts || []).map((post) => (
              <tr key={post.id}>
                <td className="col-topic">
                  <Link href={`/forum/thread/${post.thread_id}#post-${post.id}`} className="forum-topic-title">
                    {post.thread_title || "…"}
                  </Link>
                  {post.category_name && (
                    <div className="forum-cat-desc">
                      <Link href={`/forum/${post.category_slug}`} style={{ color: "var(--orange)" }}>{post.category_name}</Link>
                    </div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                    {post.content.slice(0, 200)}{post.content.length > 200 ? "…" : ""}
                  </div>
                </td>
                <td className="col-replies" style={{ whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--text)" }}>{post.author_name || "Unknown"}</span>
                </td>
                <td className="col-last" style={{ whiteSpace: "nowrap" }}>
                  <span className="forum-last-time">{new Date(post.created_at).toLocaleDateString("ru-RU")}</span>
                </td>
              </tr>
            ))}
            {(!recentPosts || recentPosts.length === 0) && (
              <tr><td colSpan={3} style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>{t("forum.noMessages")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
