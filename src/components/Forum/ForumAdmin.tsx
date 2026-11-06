"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useI18n } from '@/lib/i18n/I18nContext';
import { IconPin, IconLock } from "@/components/Icons";

interface Category {
  id: number;
  name: string;
  slug: string;
  description: string;
  sort_order: number;
}

interface Thread {
  id: number;
  title: string;
  author_name: string;
  category_id: number;
  is_pinned: boolean;
  is_locked: boolean;
  views: number;
  created_at: string;
  last_post_at?: string;
  last_post_author?: string;
}

interface Post {
  id: number;
  content: string;
  author_name: string;
  thread_id: number;
  created_at: string;
  is_deleted: boolean;
}

interface Stats {
  threads: number;
  posts: number;
  users: number;
  reactions: number;
}

export default function ForumAdmin() {
  const { t, locale } = useI18n();
  const [categories, setCategories] = useState<Category[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [stats, setStats] = useState<Stats>({ threads: 0, posts: 0, users: 0, reactions: 0 });
  const [catForm, setCatForm] = useState({ name: "", slug: "", description: "", sort_order: 0 });
  const [editingCat, setEditingCat] = useState<number | null>(null);
  const [threadQuery, setThreadQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [
        { data: cats, error: eCats },
        { data: ths, error: eThs },
        { data: ps, error: ePs },
        { count: cTh, error: eCTh },
        { count: cPs, error: eCPs },
        { count: cUs, error: eCUs },
        { count: cRe, error: eCRe },
      ] = await Promise.all([
        supabase.from("forum_categories").select("*").order("sort_order"),
        supabase.from("forum_threads").select("*").order("updated_at", { ascending: false }).limit(100),
        supabase.from("forum_posts").select("*").order("created_at", { ascending: false }).limit(100),
        supabase.from("forum_threads").select("*", { count: "exact", head: true }),
        supabase.from("forum_posts").select("*", { count: "exact", head: true }),
        supabase.from("profiles").select("*", { count: "exact", head: true }),
        supabase.from("forum_reactions").select("*", { count: "exact", head: true }),
      ]);

      if (eCats) throw new Error(t('fam.catsError', { message: eCats.message }));
      if (eThs) throw new Error(t('fam.thsError', { message: eThs.message }));
      if (ePs) throw new Error(t('fam.psError', { message: ePs.message }));

      setCategories(cats ?? []);
      setThreads(ths ?? []);
      setPosts(ps ?? []);
      setStats({
        threads: cTh ?? 0,
        posts: cPs ?? 0,
        users: cUs ?? 0,
        reactions: cRe ?? 0,
      });
    } catch (e: any) {
      setLoadError(e.message || t('fam.loadFailed'));
      console.error("ForumAdmin load error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const saveCategory = async () => {
    const payload = {
      name: catForm.name.trim(),
      slug: catForm.slug.trim().toLowerCase().replace(/\s+/g, "-"),
      description: catForm.description.trim(),
      sort_order: catForm.sort_order,
    };
    if (!payload.name || !payload.slug) { setMsg(t('fam.nameSlugRequired')); return; }
    const { error } = editingCat
      ? await supabase.from("forum_categories").update(payload).eq("id", editingCat)
      : await supabase.from("forum_categories").insert(payload);
    if (error) { setMsg(error.message); return; }
    setMsg(editingCat ? t('fam.catUpdated') : t('fam.catCreated'));
    setCatForm({ name: "", slug: "", description: "", sort_order: 0 });
    setEditingCat(null);
    load();
  };

  const editCategory = (cat: Category) => {
    setEditingCat(cat.id);
    setCatForm({ name: cat.name, slug: cat.slug, description: cat.description, sort_order: cat.sort_order });
  };

  const deleteCategory = async (id: number) => {
    if (!confirm(t('fam.confirmDelCat'))) return;
    await supabase.from("forum_categories").delete().eq("id", id);
    load();
  };

  const toggleThreadPin = async (id: number, val: boolean) => {
    await supabase.from("forum_threads").update({ is_pinned: !val }).eq("id", id);
    load();
  };

  const toggleThreadLock = async (id: number, val: boolean) => {
    await supabase.from("forum_threads").update({ is_locked: !val }).eq("id", id);
    load();
  };

  const deleteThread = async (id: number) => {
    if (!confirm(t('fam.confirmDelThread'))) return;
    await supabase.from("forum_threads").delete().eq("id", id);
    load();
  };

  const deletePost = async (id: number) => {
    if (!confirm(t('fam.confirmDelPost'))) return;
    await supabase.from("forum_posts").update({ is_deleted: true }).eq("id", id);
    load();
  };

  const restorePost = async (id: number) => {
    await supabase.from("forum_posts").update({ is_deleted: false }).eq("id", id);
    load();
  };

  const filteredThreads = threads.filter((th) =>
    th.title.toLowerCase().includes(threadQuery.trim().toLowerCase())
  );

  return (
    <div>
      <h2>{t('fam.statsTitle')}</h2>
      <div style={{ display: "flex", gap: 16, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: 'fam.statThreads', value: stats.threads },
          { label: 'fam.statPosts', value: stats.posts },
          { label: 'fam.statUsers', value: stats.users },
          { label: 'fam.statReactions', value: stats.reactions },
        ].map((s) => (
          <div key={s.label} style={{ padding: "12px 20px", background: "#25282b", border: "1px solid #323538", borderRadius: 8, minWidth: 120, textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: "#e67e22" }}>{s.value}</div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginTop: 4 }}>{t(s.label)}</div>
          </div>
        ))}
      </div>

      <h2>{t('fam.catsTitle')}</h2>
      {msg && <p style={{ color: "#e67e22" }}>{msg}</p>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <input placeholder={t('fam.phName')} value={catForm.name} onChange={(e) => setCatForm({ ...catForm, name: e.target.value })} />
        <input placeholder="slug" value={catForm.slug} onChange={(e) => setCatForm({ ...catForm, slug: e.target.value })} />
        <input placeholder={t('fam.phDesc')} value={catForm.description} onChange={(e) => setCatForm({ ...catForm, description: e.target.value })} style={{ width: 240 }} />
        <input type="number" placeholder={t('fam.phOrder')} value={catForm.sort_order} onChange={(e) => setCatForm({ ...catForm, sort_order: +e.target.value })} style={{ width: 80 }} />
        <button onClick={saveCategory}>{editingCat ? t('fam.update') : t('fam.create')}</button>
        {editingCat && <button onClick={() => { setEditingCat(null); setCatForm({ name: "", slug: "", description: "", sort_order: 0 }); }}>{t('fam.cancel')}</button>}
      </div>

      <table>
        <thead><tr><th>{t('fam.phName')}</th><th>Slug</th><th>{t('fam.phDesc')}</th><th>{t('fam.phOrder')}</th><th></th></tr></thead>
        <tbody>
          {categories.map((cat) => (
            <tr key={cat.id}>
              <td>{cat.name}</td>
              <td>{cat.slug}</td>
              <td>{cat.description}</td>
              <td>{cat.sort_order}</td>
              <td>
                <button onClick={() => editCategory(cat)} style={{ fontSize: 11 }}>{t('fam.edit')}</button>
                <button onClick={() => deleteCategory(cat.id)} style={{ fontSize: 11, background: "#e74c3c" }}>{t('fam.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 32 }}>{t('fam.threadsTitle')}</h2>
      <input placeholder={t('fam.phSearchThreads')} value={threadQuery} onChange={(e) => setThreadQuery(e.target.value)} style={{ width: 300, marginBottom: 12 }} />

      {loading && <p style={{ color: "#9ca3af" }}>{t('fam.loadingThreads')}</p>}
      {loadError && <p style={{ color: "#e74c3c" }}>{t('fam.errorPrefix', { message: loadError })}</p>}

      {!loading && !loadError && (
        <div className="table-scroll">
          {filteredThreads.length === 0 ? (
            <p style={{ color: "#9ca3af" }}>{t('fam.noThreads')}</p>
          ) : (
            <table>
              <thead><tr><th>ID</th><th>{t('fam.phName')}</th><th>{t('fam.thAuthor')}</th><th>{t('fam.thViews')}</th><th>{t('fam.thLastReply')}</th><th>{t('fam.thStatus')}</th><th></th></tr></thead>
              <tbody>
                {filteredThreads.map((th) => (
                  <tr key={th.id}>
                    <td>{th.id}</td>
                    <td><a href={`/forum/thread/${th.id}`} target="_blank" style={{ color: "#e67e22" }}>{th.title}</a></td>
                    <td>{th.author_name}</td>
                    <td>{th.views}</td>
                    <td>{th.last_post_author ? `${th.last_post_author} · ${new Date(th.last_post_at || "").toLocaleDateString(locale)}` : "—"}</td>
                    <td>
                      {th.is_pinned ? <IconPin size={12} />  : ""}
                      {th.is_locked ? <IconLock size={12} /> : t('fam.open')}
                    </td>
                    <td>
                      <button onClick={() => toggleThreadPin(th.id, th.is_pinned)} style={{ fontSize: 11 }}>
                        {th.is_pinned ? t('fam.unpin') : t('fam.pin')}
                      </button>
                      <button onClick={() => toggleThreadLock(th.id, th.is_locked)} style={{ fontSize: 11 }}>
                        {th.is_locked ? t('fam.openThread') : t('fam.closeThread')}
                      </button>
                      <button onClick={() => deleteThread(th.id)} style={{ fontSize: 11, background: "#e74c3c" }}>{t('fam.delete')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <h2 style={{ marginTop: 32 }}>{t('fam.postsTitle')}</h2>
      {!loading && !loadError && posts.length === 0 && (
        <p style={{ color: "#9ca3af" }}>{t('fam.noPosts')}</p>
      )}
      <div className="table-scroll">
        <table>
          <thead><tr><th>ID</th><th>{t('fam.thAuthor')}</th><th>{t('fam.pContent')}</th><th>{t('fam.thStatus')}</th><th></th></tr></thead>
          <tbody>
            {posts.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.author_name}</td>
                <td style={{ maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.content}
                </td>
                <td>{p.is_deleted ? t('fam.deleted') : t('fam.active')}</td>
                <td>
                  {p.is_deleted ? (
                    <button onClick={() => restorePost(p.id)} style={{ fontSize: 11 }}>{t('fam.restore')}</button>
                  ) : (
                    <button onClick={() => deletePost(p.id)} style={{ fontSize: 11, background: "#e74c3c" }}>{t('fam.delete')}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
