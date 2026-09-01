"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";

import { supabase } from "@/lib/supabaseClient";

import { ForumBreadcrumbs } from "@/components/Forum/ForumBreadcrumbs";
import { ForumReactions } from "@/components/Forum/ForumReactions";
import { ForumReplyBox } from "@/components/Forum/ForumReplyBox";
import { MarkdownToolbar } from "@/components/Forum/MarkdownToolbar";
import { MarkdownRenderer } from "@/lib/markdown";

interface Post {
  id: number;
  content: string;
  author_id: string;
  
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  author?: { cmdr_name: string; avatar_url: string | null };
}

interface Thread {
  id: number;
  title: string;
  category_id: number;
  author_id: string;
  
  is_pinned: boolean;
  is_locked: boolean;
  views: number;
  created_at: string;
}

interface Category {
  id: number;
  name: string;
  slug: string;
}

interface Props {
  thread: Thread;
  category: Category | null;
  initialPosts: Post[];
}

export function ThreadPageClient({ thread, category, initialPosts }: Props) {
  
  const [posts, setPosts] = useState<Post[]>(initialPosts);
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [editingPost, setEditingPost] = useState<number | null>(null);
  const [editContent, setEditContent] = useState("");
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [quote, setQuote] = useState("");
  const [currentThread, setCurrentThread] = useState<Thread>(thread);
  const [threadAuthorName, setThreadAuthorName] = useState<string>("Unknown");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      if (data.user) {
        supabase.from("profiles").select("*").eq("id", data.user.id).maybeSingle().then(({ data: p }) => {
          setProfile(p);
          setIsAdmin(["admin", "moderator"].includes(p?.role ?? ""));
        });
        supabase.from("forum_subscriptions").select("*").eq("thread_id", thread.id).eq("user_id", data.user.id).maybeSingle().then(({ data: sub }) => {
          setIsSubscribed(!!sub);
        });
      }
    });
    // Загружаем имя автора темы
    if (thread.author_id) {
      supabase.from("profiles").select("cmdr_name").eq("id", thread.author_id).maybeSingle().then(({ data: p }) => {
        setThreadAuthorName(p?.cmdr_name || "Unknown");
      });
    }
  }, [thread.id, thread.author_id]);

  const loadPosts = useCallback(async () => {
    const { data: rawPosts } = await supabase
      .from("forum_posts")
      .select("*")
      .eq("thread_id", thread.id)
      .order("created_at", { ascending: true });

    const postList = rawPosts ?? [];

    const authorIds = [...new Set(postList.map((p: any) => p.author_id).filter(Boolean))];
    let profileMap = new Map<string, { cmdr_name: string; avatar_url: string | null }>();
    if (authorIds.length > 0) {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, cmdr_name, avatar_url")
        .in("id", authorIds);
      profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
    }

    setPosts(postList.map((p: any) => ({
      ...p,
      author: profileMap.get(p.author_id) ?? { cmdr_name: 'Unknown', avatar_url: null },
    })));
  }, [thread.id]);

  const loadThread = useCallback(async () => {
    const { data } = await supabase.from("forum_threads").select("*").eq("id", thread.id).single();
    if (data) setCurrentThread(data);
  }, [thread.id]);

  const quotePost = (post: Post) => {
    const lines = post.content.split("\n").map((l) => `> ${l}`).join("\n");
    setQuote(`> **${post.author?.cmdr_name || "Unknown"}** писал(а):\n${lines}\n\n`);
    setTimeout(() => boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: "smooth" }), 100);
  };

  const sendReply = async (text: string) => {
    if (!text.trim() || !user || currentThread.is_locked) return;
    
    const { error } = await supabase.from("forum_posts").insert({
      thread_id: thread.id,
      author_id: user.id,
      
      content: text.trim(),
    });
    if (error) { alert(error.message); return; }
    setQuote("");
    await loadPosts();
    await loadThread();
    setTimeout(() => {
      boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: "smooth" });
    }, 100);
  };

  const startEdit = (post: Post) => {
    setEditingPost(post.id);
    setEditContent(post.content);
  };

  const saveEdit = async (postId: number) => {
    const res = await fetch('/api/forum/posts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, content: editContent.trim() }),
    });
    const result = await res.json();
    if (!res.ok) { alert(result.error || 'Ошибка сохранения'); return; }
    setEditingPost(null);
    loadPosts();
  };

  const deletePost = async (postId: number) => {
    if (!confirm("Удалить сообщение?")) return;
    await supabase.from("forum_posts").update({ is_deleted: true }).eq("id", postId);
    loadPosts();
  };

  const togglePin = async () => {
    if (!isAdmin) return;
    await supabase.from("forum_threads").update({ is_pinned: !currentThread.is_pinned }).eq("id", thread.id);
    loadThread();
  };

  const toggleLock = async () => {
    if (!isAdmin) return;
    await supabase.from("forum_threads").update({ is_locked: !currentThread.is_locked }).eq("id", thread.id);
    loadThread();
  };

  const deleteThread = async () => {
    if (!isAdmin) return;
    if (!confirm("Удалить всю тему?")) return;
    await supabase.from("forum_threads").delete().eq("id", thread.id);
    window.location.href = `/forum/${category?.slug ?? ""}`;
  };

  const toggleSubscribe = async () => {
    if (!user) return;
    if (isSubscribed) {
      await supabase.from("forum_subscriptions").delete().eq("thread_id", thread.id).eq("user_id", user.id);
      setIsSubscribed(false);
    } else {
      await supabase.from("forum_subscriptions").insert({ thread_id: thread.id, user_id: user.id });
      setIsSubscribed(true);
    }
  };

  const avatarUrl = (post: Post) => {
    if (post.author?.avatar_url) return post.author.avatar_url;
    return null;
  };

  return (
    <main className="card">
      <ForumBreadcrumbs items={[
        { label: "Форум", href: "/forum" },
        category ? { label: category.name, href: `/forum/${category.slug}` } : { label: "…" },
        { label: currentThread.title },
      ]} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>{currentThread.title}</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {user && (
            <button onClick={toggleSubscribe} style={{ fontSize: 12, padding: "4px 10px", background: isSubscribed ? "rgba(230,126,34,0.15)" : "transparent", borderColor: isSubscribed ? "var(--orange)" : "var(--line)", color: isSubscribed ? "var(--orange)" : "var(--muted)" }}>
              {isSubscribed ? "🔔 Подписка активна" : "🔕 Подписаться"}
            </button>
          )}
          {isAdmin && (
            <>
              <button onClick={togglePin} style={{ fontSize: 12, padding: "4px 10px" }}>
                {currentThread.is_pinned ? "Открепить" : "Закрепить"}
              </button>
              <button onClick={toggleLock} style={{ fontSize: 12, padding: "4px 10px" }}>
                {currentThread.is_locked ? "Открыть" : "Закрыть"}
              </button>
              <button onClick={deleteThread} style={{ fontSize: 12, padding: "4px 10px", background: "var(--red)", borderColor: "var(--red)" }}>
                Удалить тему
              </button>
            </>
          )}
        </div>
      </div>

      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
        {threadAuthorName} · {new Date(currentThread.created_at).toLocaleDateString("ru-RU")} · Просмотров: {currentThread.views}
        {currentThread.is_pinned && <span style={{ color: "var(--orange)", marginLeft: 8 }}>📌 Закреплено</span>}
        {currentThread.is_locked && <span style={{ color: "var(--red)", marginLeft: 8 }}>🔒 Закрыто</span>}
      </div>

      <div
        ref={boxRef}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxHeight: "60vh",
          overflowY: "auto",
          paddingRight: 6,
        }}
      >
        {posts.length === 0 && (
          <p style={{ color: "var(--muted)" }}>Пока нет сообщений.</p>
        )}
        {posts.map((post) => (
          <div
            key={post.id}
            style={{
              padding: "12px 14px",
              background: post.is_deleted ? "#2a1a1a" : "#25282b",
              border: "1px solid var(--line)",
              borderRadius: 3,
              opacity: post.is_deleted ? 0.5 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              {avatarUrl(post) ? (
                <img src={avatarUrl(post)!} alt="" style={{ width: 32, height: 32, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--line)" }} />
              ) : (
                <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#323538" }} />
              )}
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                  {post.author?.cmdr_name || "Unknown"}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: 8 }}>
                  {new Date(post.created_at).toLocaleString("ru-RU")}
                  {post.updated_at !== post.created_at && " (изм.)"}
                </span>
              </div>
            </div>

            {editingPost === post.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <MarkdownToolbar
                  textareaRef={editTextareaRef}
                  onChange={setEditContent}
                  getValue={() => editContent}
                />
                <textarea ref={editTextareaRef} value={editContent} onChange={(e) => setEditContent(e.target.value)} style={{ minHeight: 80 }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEdit(post.id)} style={{ fontSize: 12 }}>Сохранить</button>
                  <button onClick={() => setEditingPost(null)} style={{ fontSize: 12, background: "transparent", color: "var(--muted)", borderColor: "var(--line)" }}>Отмена</button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>
                {post.is_deleted ? (
                  <span style={{ fontStyle: "italic", color: "var(--muted)" }}>[Сообщение удалено]</span>
                ) : (
                  <MarkdownRenderer content={post.content} />
                )}
              </div>
            )}

            {!post.is_deleted && editingPost !== post.id && (
              <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <ForumReactions postId={post.id} userId={user?.id} />
                {user && (
                  <button onClick={() => quotePost(post)} style={{ fontSize: 11, padding: "3px 8px", background: "transparent", color: "var(--muted)", borderColor: "var(--line)" }}>
                    Цитировать
                  </button>
                )}
                {(post.author_id === user?.id || isAdmin) && (
                  <>
                    {post.author_id === user?.id && (
                      <button onClick={() => startEdit(post)} style={{ fontSize: 11, padding: "3px 8px" }}>Редактировать</button>
                    )}
                    <button onClick={() => deletePost(post.id)} style={{ fontSize: 11, padding: "3px 8px", background: "var(--red)", borderColor: "var(--red)" }}>Удалить</button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <ForumReplyBox
        threadId={thread.id}
        threadLocked={currentThread.is_locked}
        user={user}
        profile={profile}
        onReply={loadPosts}
        quote={quote}
        onClearQuote={() => setQuote("")}
      />
    </main>
  );
}
