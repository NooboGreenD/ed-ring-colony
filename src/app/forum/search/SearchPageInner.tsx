"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/I18nContext";

interface SearchResult {
  id: number;
  title?: string;
  content?: string;
  thread_id?: number;
  thread_title?: string;
  author_name?: string;
  created_at: string;
  type: "thread" | "post";
}

export default function SearchPageInner() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") || "";

  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!query.trim() || query.trim().length < 2) return;
    setLoading(true);
    setSearched(true);
    const res = await fetch(`/api/forum/search?q=${encodeURIComponent(query.trim())}`);
    const data = await res.json();
    setResults(data.results || []);
    setLoading(false);
  };

  useEffect(() => {
    if (initialQuery) search();
  }, []);

  return (
    <main className="card">
      <h1>
        <Link href="/forum" style={{ color: "#e67e22", textDecoration: "none" }}>{t('forum.title')}</Link>
        <span style={{ color: "#9ca3af", margin: "0 8px" }}>/</span>
        {t('forum.search')}
      </h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="search"
          placeholder={t('forum.searchInput')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1 }}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button onClick={search} disabled={loading}>
          {loading ? t('forum.searching') : t('forum.searchBtn')}
        </button>
      </div>

      {searched && !loading && results.length === 0 && (
        <p style={{ color: "#9ca3af", textAlign: "center" }}>{t('forum.nothingFound')}</p>
      )}

      <div className="forum-search-results">
        {results.map((result) => (
          <div key={`${result.type}-${result.id}`} className="forum-search-result">
            <div className="forum-search-result-type">
              {result.type === "thread" ? t('forum.threadLabel') : t('forum.postLabel')}
            </div>
            <Link
              href={result.type === "thread" ? `/forum/thread/${result.id}` : `/forum/thread/${result.thread_id}#post-${result.id}`}
              className="forum-search-result-title"
            >
              {result.title || result.thread_title || t('forum.noTopicsYet')}
            </Link>
            {result.content && (
              <div className="forum-search-result-content">
                {result.content.slice(0, 200)}{result.content.length > 200 ? "…" : ""}
              </div>
            )}
            <div className="forum-search-result-meta">
              {result.author_name || "Unknown"} · {new Date(result.created_at).toLocaleDateString("ru-RU")}
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
