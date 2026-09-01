"use client";

import Link from "next/link";

interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function ForumBreadcrumbs({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="breadcrumb" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {i > 0 && <span style={{ color: "#475569" }}>/</span>}
          {item.href ? (
            <Link href={item.href} style={{ color: "#9ca3af", textDecoration: "none", fontSize: 14 }}>
              {item.label}
            </Link>
          ) : (
            <span style={{ color: "#eeeeee", fontSize: 14, fontWeight: 500 }}>{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
