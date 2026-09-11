"use client";
import { IconImage, IconPaperclip, IconExternalLink } from "@/components/Icons";

import { useEffect, useState, useRef, useCallback } from "react";
import { useI18n } from "@/lib/i18n/I18nContext";
import { authFetch } from "@/lib/supabaseClient";

type Ticket = {
  id: string;
  user_id: string;
  title: string;
  category: string;
  priority: string;
  status: string;
  assigned_to: string | null;
  page_url: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  user?: { cmdr_name: string | null; avatar_url: string | null; email: string | null };
  assigned?: { cmdr_name: string | null };
};

type Message = {
  id: string;
  ticket_id: string;
  sender_id: string;
  content: string;
  is_internal: boolean;
  created_at: string;
  sender?: { cmdr_name: string | null; avatar_url: string | null };
};

type Attachment = {
  id: string;
  file_name: string;
  file_type: string;
  public_url: string;
  created_at: string;
};

type StaffProfile = {
  id: string;
  cmdr_name: string | null;
  role: string;
};

const CATEGORIES: Record<string, string> = {
  bug: "Баг",
  feature_request: "Фича",
  account_issue: "Аккаунт",
  other: "Другое",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "#e74c3c",
  high: "#e67e22",
  normal: "#3498db",
  low: "#9ca3af",
};

const STATUS_COLORS: Record<string, string> = {
  open: "#e74c3c",
  in_progress: "#e67e22",
  waiting_user: "#3498db",
  resolved: "#2ecc71",
  closed: "#9ca3af",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Открыт",
  in_progress: "В работе",
  waiting_user: "Ждёт ответа",
  resolved: "Решён",
  closed: "Закрыт",
};

function fmtDate(d: string) {
  return new Date(d).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function SupportAdmin() {
  const { t } = useI18n();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [staffList, setStaffList] = useState<StaffProfile[]>([]);
  const [reply, setReply] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterCategory, setFilterCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const statusParam = filterStatus !== "all" ? `&status=${encodeURIComponent(filterStatus)}` : "";
      const res = await authFetch(`/api/support/tickets?limit=100${statusParam}`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось загрузить тикеты");
      setTickets(data.tickets || []);
      setLoadError(null);
    } catch (error) {
      // Keep the last successful list visible during a transient API failure;
      // previously both staff and users saw a misleading empty state here.
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить тикеты");
    } finally {
      setLoading(false);
    }
  }, [filterStatus]);

  const loadUnread = useCallback(async () => {
    try {
      const res = await authFetch("/api/support/unread", { credentials: "include", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось загрузить счётчик тикетов");
      setUnreadCount(data.count || 0);
    } catch {
      // The ticket list remains usable even if the optional badge fails.
      setUnreadCount(0);
    }
  }, []);

  const loadStaff = useCallback(async () => {
    try {
      const { supabase } = await import("@/lib/supabaseClient");
      const { data } = await supabase
        .from("profiles")
        .select("id, cmdr_name, role")
        .in("role", ["admin", "moderator", "support_manager"]);
      setStaffList(data || []);
    } catch {
      setStaffList([]);
    }
  }, []);

  const loadDetails = useCallback(async (id: string) => {
    try {
      const res = await authFetch(`/api/support/tickets/${id}`, {
        credentials: "include",
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось загрузить тикет");
      if (data.ticket) {
        setSelected(data.ticket);
        setMessages(data.messages || []);
        setAttachments(data.attachments || []);
        setMsg("");
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Не удалось загрузить тикет");
    }
  }, []);

  useEffect(() => {
    loadTickets();
    loadUnread();
    loadStaff();
    const interval = setInterval(() => {
      loadTickets();
      loadUnread();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadTickets, loadUnread, loadStaff]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendReply = async () => {
    if (!reply.trim() || !selected) return;
    setSending(true);
    setMsg("");
    try {
      const res = await authFetch(`/api/support/tickets/${selected.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: reply, is_internal: isInternal }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось отправить ответ");
      if (data.message) {
        setReply("");
        setIsInternal(false);
        await loadDetails(selected.id);
        await loadTickets();
        await loadUnread();
      } else {
        setMsg(data.error || "Не удалось отправить ответ");
      }
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : "Ошибка сети");
    } finally {
      setSending(false);
    }
  };

  const updateTicket = async (updates: Partial<Ticket>) => {
    if (!selected) return;
    try {
      const res = await authFetch(`/api/support/tickets/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось обновить тикет");
      if (data.ticket) {
        await loadDetails(selected.id);
        await loadTickets();
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Не удалось обновить тикет");
    }
  };

  const uploadFile = async (file: File) => {
    if (!selected) return;
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("ticket_id", selected.id);
      const res = await authFetch("/api/support/upload", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Не удалось загрузить файл");
      if (data.attachment) {
        await loadDetails(selected.id);
      }
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Не удалось загрузить файл");
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const filteredTickets = tickets.filter((t) => {
    if (filterCategory !== "all" && t.category !== filterCategory) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      t.user?.cmdr_name?.toLowerCase().includes(q) ||
      t.user?.email?.toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q)
    );
  });

  const openCount = tickets.filter((t) =>
    ["open", "in_progress", "waiting_user"].includes(t.status)
  ).length;

  return (
    <div>
      <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <div className="stat-box" style={{ padding: "10px 14px", minWidth: 100 }}>
          <div className="num" style={{ fontSize: 20 }}>{openCount}</div>
          <div className="lbl" style={{ fontSize: 10 }}>Открытых</div>
        </div>
        <div className="stat-box" style={{ padding: "10px 14px", minWidth: 100 }}>
          <div className="num" style={{ fontSize: 20 }}>{tickets.filter((t) => t.status === "resolved").length}</div>
          <div className="lbl" style={{ fontSize: 10 }}>Решённых</div>
        </div>
        <div className="stat-box" style={{ padding: "10px 14px", minWidth: 100 }}>
          <div className="num" style={{ fontSize: 20 }}>{tickets.filter((t) => t.status === "closed").length}</div>
          <div className="lbl" style={{ fontSize: 10 }}>Закрытых</div>
        </div>
        <div className="stat-box" style={{ padding: "10px 14px", minWidth: 100 }}>
          <div className="num" style={{ fontSize: 20, color: "#e74c3c" }}>{unreadCount}</div>
          <div className="lbl" style={{ fontSize: 10 }}>Ожидают</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, minHeight: 600 }}>
        <aside style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ flex: 1, minWidth: 100 }}>
              <option value="all">Все статусы</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} style={{ flex: 1, minWidth: 100 }}>
              <option value="all">Все категории</option>
              {Object.entries(CATEGORIES).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <input placeholder="Поиск по тикетам..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: "100%", margin: 0 }} />
          {loadError && (
            <div role="alert" className="card" style={{ padding: 10, color: "#e74c3c", fontSize: 12 }}>
              Не удалось обновить тикеты: {loadError}{" "}
              <button type="button" onClick={loadTickets} style={{ fontSize: 11, padding: "3px 7px", marginLeft: 4 }}>Повторить</button>
            </div>
          )}

          {loading && tickets.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>Загрузка...</p>
          ) : filteredTickets.length === 0 ? (
            <div className="card" style={{ textAlign: "center", padding: 24 }}>
              <p style={{ color: loadError ? "#e74c3c" : "var(--muted)" }}>
                {loadError ? "Список тикетов недоступен. Повторите попытку." : "Тикетов не найдено"}
              </p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "70vh", overflowY: "auto" }}>
              {filteredTickets.map((t) => (
                <button key={t.id} onClick={() => loadDetails(t.id)} style={{ textAlign: "left", background: selected?.id === t.id ? "rgba(230,126,34,0.08)" : "var(--panel)", border: `1px solid ${selected?.id === t.id ? "var(--orange)" : "var(--line)"}`, borderRadius: 4, padding: 10, cursor: "pointer", transition: "all 0.15s", width: "100%", position: "relative" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, paddingRight: 8 }}>{t.title}</span>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: STATUS_COLORS[t.status] + "20", color: STATUS_COLORS[t.status], flexShrink: 0 }}>{STATUS_LABELS[t.status]}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)", flexWrap: "wrap" }}>
                    <span style={{ color: PRIORITY_COLORS[t.priority] || "var(--muted)" }}>{t.priority}</span>
                    <span>·</span>
                    <span>{CATEGORIES[t.category] || t.category}</span>
                    <span>·</span>
                    <span>{t.user?.cmdr_name || t.user?.email || "—"}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                    {fmtDate(t.updated_at)}
                    {t.assigned?.cmdr_name && <span> · {t.assigned.cmdr_name}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section style={{ flex: 1, minWidth: 0 }}>
          {msg && !selected && <p role="alert" style={{ color: "#e74c3c", fontSize: 12 }}>{msg}</p>}
          {selected ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="card" style={{ padding: "14px 18px" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>{selected.title}</h3>
                    <div style={{ fontSize: 11, color: "var(--muted)", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                      <span>Пользователь: <b style={{ color: "var(--text)" }}>{selected.user?.cmdr_name || selected.user?.email || "—"}</b></span>
                      <span>Создан: {fmtDate(selected.created_at)}</span>
                      {selected.page_url && (
                        <a href={selected.page_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>Страница <IconExternalLink size={10} /></a>
                      )}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <select value={selected.status} onChange={(e) => updateTicket({ status: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
                      {Object.entries(STATUS_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                    <select value={selected.priority} onChange={(e) => updateTicket({ priority: e.target.value })} style={{ width: "auto", fontSize: 12 }}>
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                    <select value={selected.assigned_to || ""} onChange={(e) => updateTicket({ assigned_to: e.target.value || null })} style={{ width: "auto", fontSize: 12 }}>
                      <option value="">Не назначен</option>
                      {staffList.map((s) => (
                        <option key={s.id} value={s.id}>{s.cmdr_name || s.id.slice(0, 8)} ({s.role})</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              <div className="card" style={{ flex: 1, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 400 }}>
                <div style={{ flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                  {messages.length === 0 ? (
                    <p style={{ color: "var(--muted)", textAlign: "center" }}>Нет сообщений</p>
                  ) : (
                    messages.map((m) => (
                      <div key={m.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", alignSelf: m.is_internal ? "flex-end" : "flex-start", flexDirection: "row", maxWidth: "90%" }}>
                        <div style={{ width: 28, height: 28, borderRadius: "50%", background: m.is_internal ? "#e74c3c" : "#3a3d40", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#fff", flexShrink: 0 }}>
                          {m.is_internal ? "!" : (m.sender?.cmdr_name?.[0]?.toUpperCase() || "?")}
                        </div>
                        <div style={{ background: m.is_internal ? "rgba(231,76,60,0.08)" : "var(--panel)", border: `1px solid ${m.is_internal ? "rgba(231,76,60,0.25)" : "var(--line)"}`, borderRadius: 8, padding: "8px 12px", maxWidth: "100%" }}>
                          <div style={{ fontSize: 11, marginBottom: 3, display: "flex", gap: 8, alignItems: "center" }}>
                            <span style={{ color: m.is_internal ? "#e74c3c" : "var(--orange)", fontWeight: 600 }}>
                              {m.sender?.cmdr_name || "—"}
                              {m.is_internal && (
                                <span style={{ fontSize: 9, background: "#e74c3c", color: "#fff", padding: "1px 4px", borderRadius: 3, marginLeft: 4 }}>ВНУТР</span>
                              )}
                            </span>
                            <span style={{ color: "var(--muted)" }}>{fmtDate(m.created_at)}</span>
                          </div>
                          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</div>
                        </div>
                      </div>
                    ))
                  )}
                  {attachments.length > 0 && (
                    <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {attachments.map((a) => (
                        <a key={a.id} href={a.public_url} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 4, fontSize: 12, color: "var(--orange)" }}>
                          {a.file_type.startsWith("image/") ? <IconImage size={12} /> : <IconPaperclip size={12} />}
                          {a.file_name}
                        </a>
                      ))}
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                <div style={{ borderTop: "1px solid var(--line)", padding: "10px 14px", display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <textarea placeholder="Ответ пользователю..." value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(); } }} style={{ flex: 1, minHeight: 48, maxHeight: 120, resize: "none", margin: 0, fontSize: 13 }} />
                  <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: "none" }} accept="image/*,.pdf,.txt" />
                  <button onClick={() => fileInputRef.current?.click()} style={{ padding: "10px", fontSize: 14 }} title="Прикрепить файл"><IconPaperclip size={14} /></button>
                  <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--muted)", cursor: "pointer", whiteSpace: "nowrap" }}>
                    <input type="checkbox" checked={isInternal} onChange={(e) => setIsInternal(e.target.checked)} style={{ margin: 0 }} />
                    Внутр.
                  </label>
                  <button onClick={sendReply} disabled={!reply.trim() || sending} className="btn btn-orange" style={{ padding: "10px 18px", fontSize: 11 }}>
                    {sending ? "..." : "Ответить"}
                  </button>
                </div>
              </div>
              {msg && <p style={{ color: "#e74c3c", fontSize: 12 }}>{msg}</p>}
            </div>
          ) : (
            <div className="card" style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
              <p>Выберите тикет из списка слева</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
