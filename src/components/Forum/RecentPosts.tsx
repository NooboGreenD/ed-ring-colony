"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/I18nContext";

interface Thread {
  id: number;
  title: string;
  created_at: string;
  author?: { cmdr_name: string | null } | { cmdr_name: string | null }[];
  forum_categories?: { slug: string; name: string } | { slug: string; name: string }[] | null;
}

export function RecentPosts({ threads }: { threads: Thread[] }) {
  const { t } = useI18n();
  if (!threads.length) return <p style={{ color: "var(--muted)" }}>{t('forum.noTopicsYet')}</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {threads.map((t) => {
        const author = Array.isArray(t.author) ? t.author[0] : t.author;
        const cat = Array.isArray(t.forum_categories) ? t.forum_categories[0] : t.forum_categories;
        return (
          <div key={t.id} style={{ padding: "10px 12px", background: "#25282b", border: "1px solid var(--line)", borderRadius: 3 }}>
            <Link href={`/forum/thread/${t.id}`} style={{ color: "var(--text)", fontWeight: 500, textDecoration: "none", fontSize: 14 }}>
              {t.title}
            </Link>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              {author?.cmdr_name || 'Unknown'} · {new Date(t.created_at).toLocaleDateString("ru-RU")}
              {cat && <span> · <Link href={`/forum/${cat.slug}`} style={{ color: "var(--orange)" }}>{cat.name}</Link></span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
