"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/supabaseClient";
import type { CarrierView } from "@/lib/fleetCarriers";
import CarrierCard from "./CarrierCard";

/**
 * Панель авианосцев.
 *
 *   mode="account"  — личный носитель пилота и носители его эскадрильи;
 *   mode="squadron" — носители конкретной эскадрильи (страница эскадрильи).
 *
 * Привязка автоматическая (по журналу через Colonial Helper или загрузку
 * журналов), ручная форма — запасной путь.
 */

type Props = { mode: "account" } | { mode: "squadron"; squadronId: number };

interface State {
  own: CarrierView | null;
  squadron: CarrierView[];
  squadronId: number | null;
  canManage: boolean;
  isMember: boolean;
}

const EMPTY: State = { own: null, squadron: [], squadronId: null, canManage: false, isMember: false };
const REFRESH_MS = 60_000;

function BindForm({ kind, squadronId, onDone }: { kind: "personal" | "squadron"; squadronId?: number | null; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError("");
    try {
      const response = await authFetch("/api/carriers/bind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, carrier: value.trim(), squadron_id: squadronId ?? undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setValue("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
          placeholder="Carrier ID (3700…) или позывной ABC-123"
          style={{ flex: "1 1 240px", background: "#141618", border: "1px solid #323538", color: "#eeeeee", padding: "8px 10px", borderRadius: 4, fontSize: 13 }}
        />
        <button className="btn btn-cyan" style={{ padding: "8px 14px", fontSize: 11 }} disabled={busy || !value.trim()} onClick={() => void submit()}>
          {busy ? "Привязка…" : "Привязать"}
        </button>
      </div>
      {error && <div style={{ color: "#e74c3c", fontSize: 12, marginTop: 6 }}>{error}</div>}
    </div>
  );
}

export default function CarrierPanel(props: Props) {
  const [state, setState] = useState<State>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const squadronParam = props.mode === "squadron" ? props.squadronId : null;

  const load = useCallback(async () => {
    try {
      const url = props.mode === "account" ? "/api/carriers/mine" : `/api/carriers?squadron_id=${squadronParam}`;
      const response = await authFetch(url, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setState(props.mode === "account"
        ? { own: data.own ?? null, squadron: data.squadron ?? [], squadronId: data.squadron_id ?? null, canManage: Boolean(data.can_manage_squadron), isMember: data.squadron_id != null }
        : { own: null, squadron: data.carriers ?? [], squadronId: squadronParam, canManage: Boolean(data.can_manage), isMember: Boolean(data.is_member) });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [props.mode, squadronParam]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const unbind = async (carrier: CarrierView, kind: "personal" | "squadron") => {
    const question = kind === "personal"
      ? `Отвязать «${carrier.name || carrier.callsign || carrier.carrierId}» от профиля? Учёт груза сохранится.`
      : `Отвязать «${carrier.name || carrier.callsign || carrier.carrierId}» от эскадрильи?`;
    if (!window.confirm(question)) return;
    const response = await authFetch("/api/carriers/bind", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, carrier_id: carrier.carrierId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) setError(data.error || `HTTP ${response.status}`);
    void load();
  };

  const smallButton = { padding: "6px 12px", fontSize: 11, letterSpacing: 1 } as const;
  const heading = { margin: "0 0 10px", fontSize: 14, letterSpacing: 2, textTransform: "uppercase" as const };

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <p style={{ margin: 0, fontSize: 12, color: "#9ca3af", maxWidth: 720 }}>
          Учёт ведёт сайт проекта по журналам (Colonial Helper в реальном времени или загрузка журналов). Оверлей Helper'а
          берёт эти данные отсюда и не зависит от доступности Raven Colonial.
        </p>
        <button className="btn btn-cyan" style={smallButton} onClick={() => { setLoading(true); void load(); }} disabled={loading}>
          {loading ? "Обновление…" : "Обновить"}
        </button>
      </div>
      {error && <div style={{ color: "#e74c3c", fontSize: 13 }}>{error}</div>}

      {props.mode === "account" && (
        <div>
          <h3 style={{ ...heading, color: "#3498db" }}>Мой авианосец</h3>
          {state.own ? (
            <CarrierCard carrier={state.own} actions={
              <button className="btn btn-danger" style={smallButton} onClick={() => void unbind(state.own!, "personal")}>Отвязать</button>
            } />
          ) : !loading && (
            <div style={{ border: "1px dashed #323538", borderRadius: 8, padding: 16, color: "#9ca3af", fontSize: 13 }}>
              Авианосец ещё не привязан. Он привяжется сам, когда Colonial Helper (или загрузка журналов) увидит
              CarrierStats — откройте в игре управление носителем. Если журналы сброшены, укажите носитель вручную:
              <BindForm kind="personal" onDone={() => void load()} />
            </div>
          )}
        </div>
      )}

      {(props.mode === "squadron" || state.isMember) && (
        <div>
          <h3 style={{ ...heading, color: "#e67e22" }}>{props.mode === "account" ? "Авианосцы эскадрильи" : "Эскадренный авианосец"}</h3>
          {state.squadron.length > 0 ? (
            <div style={{ display: "grid", gap: 12 }}>
              {state.squadron.map((carrier) => (
                <CarrierCard key={carrier.carrierId} carrier={carrier} actions={state.canManage ? (
                  <button className="btn btn-danger" style={smallButton} onClick={() => void unbind(carrier, "squadron")}>Отвязать</button>
                ) : undefined} />
              ))}
            </div>
          ) : !loading && (
            <div style={{ border: "1px dashed #323538", borderRadius: 8, padding: 16, color: "#9ca3af", fontSize: 13 }}>
              {state.isMember || props.mode === "account"
                ? "Эскадренный носитель привяжется сам, когда участник эскадрильи с Colonial Helper пристыкуется к нему или откроет управление им."
                : "У эскадрильи пока нет привязанного авианосца."}
            </div>
          )}
          {state.canManage && (
            <div style={{ marginTop: 10, fontSize: 12, color: "#9ca3af" }}>
              Привязать носитель к эскадрилье вручную:
              <BindForm kind="squadron" squadronId={state.squadronId} onDone={() => void load()} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
