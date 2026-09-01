"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/I18nContext";

export function ForumSearch() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      router.push(`/forum?q=${encodeURIComponent(query.trim())}`);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
      <input type="search" placeholder={t('forum.searchPlaceholder')} value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 220, fontSize: 14 }} />
      <button type="submit" style={{ padding: "6px 14px", fontSize: 13 }}>{t('forum.searchBtn')}</button>
    </form>
  );
}
