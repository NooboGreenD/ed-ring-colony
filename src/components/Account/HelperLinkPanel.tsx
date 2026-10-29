"use client";

/**
 * Привязка лаунчера к учётной записи прямо в профиле пилота.
 *
 * Лаунчер не спрашивает пароль: здесь пилот нажимает «Подключить лаунчер»,
 * получает код на десять минут и вводит его в лаунчере. После этого раскладка
 * оверлея (профили раскладки и позиции блоков) подтягивается на любом
 * устройстве, где выполнен вход, а ниже видно, какие устройства привязаны, и
 * любое можно отозвать.
 *
 * Токены EDSM, Inara и Raven копируются только вместе с компьютера: на сайт
 * они не уезжают.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/lib/i18n/I18nContext";
import { authFetch } from "@/lib/supabaseClient";

interface LinkedDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

interface LinkState {
  devices: LinkedDevice[];
  hasSettings: boolean;
  settingsUpdatedAt: string;
  settingsDevice: string;
}

const EMPTY: LinkState = { devices: [], hasSettings: false, settingsUpdatedAt: "", settingsDevice: "" };

function formatStamp(value: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toLocaleString();
}

function secondsLeft(expiresAt: string): number {
  const target = Date.parse(expiresAt);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 1000));
}

export default function HelperLinkPanel() {
  const { t } = useI18n();
  const [state, setState] = useState<LinkState>(EMPTY);
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [left, setLeft] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await authFetch("/api/uploader/link", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as Partial<LinkState> & { ok?: boolean };
      if (!response.ok || !data.ok) throw new Error(t("account.helperLinkLoadFailed"));
      setState({
        devices: Array.isArray(data.devices) ? data.devices : [],
        hasSettings: Boolean(data.hasSettings),
        settingsUpdatedAt: String(data.settingsUpdatedAt ?? ""),
        settingsDevice: String(data.settingsDevice ?? ""),
      });
      setError("");
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t("account.helperLinkLoadFailed"));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Обратный отсчёт кода: по нулю код гаснет, чтобы никто не диктовал
  // просроченный код и не искал потом, почему лаунчер его не принял.
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => {
      const remaining = secondsLeft(expiresAt);
      setLeft(remaining);
      if (remaining <= 0) {
        setCode("");
        setExpiresAt("");
        if (timer.current !== null) {
          window.clearInterval(timer.current);
          timer.current = null;
        }
      }
    };
    tick();
    timer.current = window.setInterval(tick, 1_000);
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [expiresAt]);

  const requestCode = useCallback(async () => {
    setBusy(true);
    setError("");
    setCopied(false);
    try {
      const response = await authFetch("/api/uploader/link/code", { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; code?: string; expiresAt?: string; error?: string };
      if (!response.ok || !data.ok || !data.code) {
        throw new Error(data.error || t("account.helperLinkCodeFailed"));
      }
      setCode(data.code);
      setExpiresAt(String(data.expiresAt ?? ""));
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t("account.helperLinkCodeFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const copyCode = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }, [code]);

  const revoke = useCallback(async (device: LinkedDevice) => {
    setBusy(true);
    setError("");
    try {
      const response = await authFetch(`/api/uploader/link?device=${encodeURIComponent(device.id)}`, {
        method: "DELETE",
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || t("account.helperLinkRevokeFailed"));
      await load();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : t("account.helperLinkRevokeFailed"));
    } finally {
      setBusy(false);
    }
  }, [load, t]);

  const prettyCode = useMemo(
    () => (code ? `${code.slice(0, 4)}-${code.slice(4)}` : ""),
    [code],
  );
  const minutes = Math.floor(left / 60);
  const seconds = String(left % 60).padStart(2, "0");

  return (
    <div
      style={{
        background: "#1e2124",
        border: "1px solid #2d3033",
        borderRadius: 10,
        padding: 16,
        maxWidth: 780,
        marginTop: 16,
      }}
    >
      <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>
        {t("account.helperLinkTitle")}
      </h3>
      <p style={{ color: "#9ca3af", fontSize: 13, lineHeight: 1.6, margin: "0 0 12px" }}>
        {t("account.helperLinkDesc")}
      </p>

      {error && (
        <p style={{ color: "#e74c3c", fontSize: 12, margin: "0 0 10px" }}>{error}</p>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn btn-cyan" disabled={busy} onClick={() => void requestCode()}>
          {code ? t("account.helperLinkNewCode") : t("account.helperLinkGetCode")}
        </button>
        {code && (
          <>
            <span
              aria-label={t("account.helperLinkCodeLabel")}
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: 24,
                letterSpacing: 4,
                color: "#38bdf8",
                background: "#0c0c0c",
                border: "1px solid #2d3033",
                borderRadius: 8,
                padding: "6px 14px",
              }}
            >
              {prettyCode}
            </span>
            <span style={{ fontSize: 12, color: left > 0 ? "#f1c40f" : "#e74c3c" }}>
              {t("account.helperLinkCodeLeft", { time: `${minutes}:${seconds}` })}
            </span>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => void copyCode()}>
              {copied ? t("account.helperLinkCopied") : t("account.helperLinkCopy")}
            </button>
          </>
        )}
      </div>

      <p style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.6, margin: "12px 0 0" }}>
        {t("account.helperLinkHowTo")}
      </p>

      <div style={{ borderTop: "1px solid #2d3033", marginTop: 14, paddingTop: 12 }}>
        <strong style={{ fontSize: 13 }}>{t("account.helperLinkDevices")}</strong>
        {state.devices.length === 0 ? (
          <p style={{ color: "#9ca3af", fontSize: 12, margin: "6px 0 0" }}>
            {t("account.helperLinkNoDevices")}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {state.devices.map((device) => (
              <div
                key={device.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  background: "#16191b",
                  border: "1px solid #2d3033",
                  borderRadius: 8,
                  padding: "8px 12px",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ fontSize: 13, color: "#e5e7eb" }}>
                    {device.name || t("account.helperLinkUnnamedDevice")}
                  </div>
                  <div style={{ fontSize: 11, color: "#9ca3af" }}>
                    {t("account.helperLinkLastSeen", {
                      when: formatStamp(device.lastSeenAt, t("account.helperLinkNever")),
                    })}
                  </div>
                </div>
                <button
                  className="btn danger-btn"
                  style={{ fontSize: 12 }}
                  disabled={busy}
                  onClick={() => void revoke(device)}
                >
                  {t("account.helperLinkRevoke")}
                </button>
              </div>
            ))}
          </div>
        )}
        <p style={{ color: "#9ca3af", fontSize: 12, margin: "10px 0 0", lineHeight: 1.6 }}>
          {state.hasSettings
            ? t("account.helperLinkSettingsOnSite", {
                when: formatStamp(state.settingsUpdatedAt, t("account.helperLinkNever")),
              })
            : t("account.helperLinkSettingsEmpty")}
        </p>
      </div>
    </div>
  );
}
