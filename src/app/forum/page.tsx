"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nContext";
import { ForumSearch } from "@/components/Forum/ForumSearch";
import { RecentPosts } from "@/components/Forum/RecentPosts";

interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  sort_order: number;
}

export default function ForumPage() {
  const { t } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [latestThreads, setLatestThreads] = useState<any[]>([]);
  const [totalThreads, setTotalThreads] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/forum/categories')
      .then(r => r.json())
      .then(data => {
        setCategories(data.categories || []);
        setLatestThreads(data.latestThreads || []);
        setTotalThreads(data.totalThreads || 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <main className="card"><p>{t('common.loading')}</p></main>;

  return (
    <main className="card">
      <h1>{t('forum.title')}</h1>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Link href="/forum/latest" className="btn btn-cyan">{t('forum.latest')}</Link>
          <Link href="/forum/search" className="btn btn-cyan">{t('forum.search')}</Link>
        </div>
        <ForumSearch />
      </div>

      <div className="forum-categories">
        {categories.map((cat) => (
          <div key={cat.id} className="forum-category">
            <Link href={`/forum/${cat.slug}`} className="forum-category-title">
              {cat.name}
            </Link>
            <div className="forum-category-desc">{cat.description}</div>
          </div>
        ))}
      </div>

      <div className="forum-stats" style={{ marginTop: 24 }}>
        <div className="forum-stat">
          <div className="forum-stat-value">{totalThreads}</div>
          <div className="forum-stat-label">{t('forum.threads')}</div>
        </div>
      </div>

      <h2 style={{ marginTop: 32, fontSize: 18 }}>{t('forum.latestPosts')}</h2>
      <RecentPosts threads={latestThreads} />
    </main>
  );
}
