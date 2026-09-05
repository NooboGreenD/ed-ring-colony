"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/lib/supabaseClient";

const EMOJIS = ["👍", "❤️", "🔥", "🚀"];

interface ForumReactionsProps {
  postId: number;
  userId?: string;
}

export function ForumReactions({ postId, userId }: ForumReactionsProps) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [userReactions, setUserReactions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("forum_reactions")
      .select("emoji, user_id")
      .eq("post_id", postId);

    const c: Record<string, number> = {};
    const u = new Set<string>();
    data?.forEach((r) => {
      c[r.emoji] = (c[r.emoji] || 0) + 1;
      if (r.user_id === userId) u.add(r.emoji);
    });
    setCounts(c);
    setUserReactions(u);
  }, [postId, userId]);

  useEffect(() => { load(); }, [load]);

  const toggle = async (emoji: string) => {
    if (!userId) return;
    setLoading(true);
    if (userReactions.has(emoji)) {
      await supabase.from("forum_reactions").delete().eq("post_id", postId).eq("user_id", userId).eq("emoji", emoji);
    } else {
      await supabase.from("forum_reactions").insert({ post_id: postId, user_id: userId, emoji });
    }
    await load();
    setLoading(false);
  };

  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
      {EMOJIS.map((emoji) => {
        const active = userReactions.has(emoji);
        const count = counts[emoji] || 0;
        return (
          <button
            key={emoji}
            onClick={() => toggle(emoji)}
            disabled={loading || !userId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "3px 10px",
              borderRadius: 12,
              border: "1px solid",
              borderColor: active ? "#e67e22" : "#323538",
              background: active ? "rgba(255,157,46,0.1)" : "transparent",
              color: active ? "#e67e22" : "#9ca3af",
              fontSize: 13,
              cursor: userId ? "pointer" : "default",
              opacity: loading ? 0.6 : 1,
              transition: "all 0.2s",
            }}
            title={userId ? (active ? "Убрать реакцию" : "Добавить реакцию") : "Войдите, чтобы реагировать"}
          >
            <span>{emoji}</span>
            {count > 0 && <span style={{ fontSize: 11, fontWeight: 600 }}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
