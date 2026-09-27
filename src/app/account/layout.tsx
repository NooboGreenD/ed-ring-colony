"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Вкладки личного кабинета.
 *
 * «Сообщения» и «Друзья» объединены в одну вкладку: переписка в проекте
 * возможна только с друзьями, поэтому отдельная страница сообщений была
 * заглушкой со ссылкой «перейдите в раздел Друзья». Теперь список друзей,
 * заявки и сама переписка живут на одной странице, а старый адрес
 * `/account/messages` перенаправляет сюда же.
 */
const TABS = [
  { href: "/account", label: "Профиль" },
  { href: "/account/friends", label: "Сообщения и друзья", alias: ["/account/messages"] },
];

export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <main className="card">
      <h1>Личный кабинет</h1>

      {/* Вкладки */}
      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid #323538",
          marginBottom: 24,
        }}
      >
        {TABS.map((tab) => {
          const active = pathname === tab.href || (tab.alias ?? []).includes(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              style={{
                padding: "10px 20px",
                fontSize: 14,
                fontWeight: 500,
                color: active ? "#e67e22" : "#9ca3af",
                borderBottom: active ? "2px solid #e67e22" : "2px solid transparent",
                textDecoration: "none",
                transition: "color 0.2s, border-color 0.2s",
              }}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>

      {children}
    </main>
  );
}
