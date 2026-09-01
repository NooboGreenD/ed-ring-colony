"use client";

import { useState, useRef } from "react";
import { supabase } from "@/lib/supabaseClient";

import { MarkdownToolbar } from "./MarkdownToolbar";

interface ForumReplyBoxProps {
  threadId: number;
  threadLocked: boolean;
  user: any;
  profile: any;
  onReply: () => void;
  quote?: string;
  onClearQuote?: () => void;
}

export function ForumReplyBox({ threadId, threadLocked, user, profile, onReply, quote, onClearQuote }: ForumReplyBoxProps) {
  const [reply, setReply] = useState(quote || "");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const send = async () => {
    const text = reply.trim();
    if (!text || !user || threadLocked) return;
    if (!text.replace(/[\s\n\r]/g, "").length) return;

    setSending(true);
    
    const { error } = await supabase.from("forum_posts").insert({
      thread_id: threadId,
      author_id: user.id,
      
      content: text,
    });
    setSending(false);
    if (error) { alert(error.message); return; }
    setReply("");
    if (onClearQuote) onClearQuote();
    onReply();
    setTimeout(() => textareaRef.current?.focus(), 100);
  };

  if (threadLocked) {
    return <p style={{ color: "#e74c3c", marginTop: 16, fontSize: 14 }}>🔒 Тема закрыта.</p>;
  }

  if (!user) {
    return (
      <p style={{ color: "#9ca3af", marginTop: 16, fontSize: 14 }}>
        <a href="/login" style={{ color: "#e67e22" }}>Войдите</a>, чтобы ответить.
      </p>
    );
  }

  return (
    <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      {quote && (
        <div style={{ padding: "8px 12px", background: "#323538", borderRadius: 6, borderLeft: "3px solid #e67e22", fontSize: 13, color: "#9ca3af" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Цитата:</span>
            <button onClick={onClearQuote} style={{ fontSize: 11, background: "transparent", color: "#9ca3af" }}>✕</button>
          </div>
          <div style={{ marginTop: 4, fontStyle: "italic" }}>{quote.slice(0, 200)}{quote.length > 200 ? "…" : ""}</div>
        </div>
      )}

      <MarkdownToolbar
        textareaRef={textareaRef}
        onChange={setReply}
        getValue={() => reply}
      />

      <textarea
        ref={textareaRef}
        placeholder="Ваш ответ… (поддерживается Markdown)"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        style={{ minHeight: 100, fontSize: 14 }}
        onKeyDown={(e) => { if (e.key === "Enter" && e.ctrlKey) send(); }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={send} disabled={sending}>
          {sending ? "Отправка…" : "Ответить"}
        </button>
        <span style={{ fontSize: 12, color: "#9ca3af" }}>Ctrl+Enter — быстрая отправка</span>
      </div>
    </div>
  );
}
