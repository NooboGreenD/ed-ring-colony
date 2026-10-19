"use client";

import { useEffect, useRef } from "react";
import { getCurrentUser, createSupabaseClient } from "@/lib/supabaseClient";
import { useCosmeticsFor, invalidateCosmetics } from "./useCosmetics";
import { useState } from "react";

/**
 * Applies the equipped HUD skin of the signed-in pilot to <html>:
 *  - class  `hud-<hudSkinClass>` (for CSS rules in globals.css)
 *  - CSS variables --orange / --orange-hover / --cyan overridden with the
 *    skin's `color` / `accentColor` so the whole site recolours.
 */
export const THEME_MAP: Record<string, string> = {
  bg: "--bg",
  panel: "--panel",
  panelHover: "--panel-hover",
  line: "--line",
  text: "--text",
  muted: "--muted",
  orange: "--orange",
  orangeHover: "--orange-hover",
  cyan: "--cyan",
  green: "--green",
  red: "--red",
};
const THEME_VARS = [...Object.values(THEME_MAP)];

type SkinLike = { id: string; preview?: Record<string, any> | null };
const effectVars = new Set<string>();
let previewOverride: SkinLike | null | undefined = undefined;

/** Apply (or clear) a skin's colour scheme to <html>. Exported for live previews. */
export function applySkinToDocument(skin: SkinLike | null) {
  const root = document.documentElement;
  Array.from(root.classList).filter((c) => c.startsWith("hud-")).forEach((c) => root.classList.remove(c));
  for (const key of effectVars) root.style.removeProperty(key);
  effectVars.clear();
  for (const v of THEME_VARS) root.style.removeProperty(v);
  root.style.removeProperty("--site-background");
  root.style.removeProperty("--site-font");
  root.removeAttribute("data-hud-effect");
  if (!skin) {
    root.removeAttribute("data-hud-skin");
    return;
  }
  const p = skin.preview || {};
  const theme = p.theme as Record<string, string> | undefined;
  if (theme) {
    for (const [k, v] of Object.entries(theme)) {
      if (!v) continue;
      const cssVar = THEME_MAP[k];
      if (cssVar) root.style.setProperty(cssVar, v);
    }
    if (theme.background) root.style.setProperty("--site-background", theme.background);
    if (theme.font) root.style.setProperty("--site-font", theme.font);
    if (theme.effect) root.setAttribute("data-hud-effect", theme.effect);
  }
  if (p.hudSkinClass) root.classList.add(`hud-${p.hudSkinClass}`);
  root.setAttribute("data-hud-skin", skin.id);
  if (p.color && !theme?.orange) {
    root.style.setProperty("--orange", p.color);
    root.style.setProperty("--orange-hover", p.accentColor || p.color);
  }
  if (p.accentColor && !theme?.cyan) root.style.setProperty("--cyan", p.accentColor);
  if (p.cssEffects && typeof p.cssEffects === "object") {
    for (const [k, v] of Object.entries(p.cssEffects)) if (k.startsWith("--")) { root.style.setProperty(k, String(v)); effectVars.add(k); }
  }
}

/** Fire from anywhere (e.g. the shop) to preview a skin site-wide; `null` resets to equipped. */
export function previewSkin(skin: SkinLike | null) {
  window.dispatchEvent(new CustomEvent("cosmetics:preview-skin", { detail: skin ? { skin } : { reset: true } }));
}

export default function HudSkinProvider() {
  const [userId, setUserId] = useState<string | null>(null);
  const cosmetics = useCosmeticsFor(userId);
  const identityRef = useRef<string | null>(null);
  const skinRef = useRef(cosmetics?.skin);
  skinRef.current = cosmetics?.skin;

  useEffect(() => {
    let alive = true;
    let authChanged = false;
    getCurrentUser()
      .then(async (u) => {
        if (!alive || authChanged) return;
        if (u?.id) { identityRef.current = u.id; setUserId(u.id); return; }
        // No Supabase session: ask the billing API (handles preview-admin mode in dev).
        try {
          const r = await fetch("/api/shop/user-state", { cache: "no-store" });
          const j = r.ok ? await r.json() : null;
          if (alive && !authChanged && j?.userId) { identityRef.current = j.userId; setUserId(j.userId); }
        } catch {}
      })
      .catch(() => {});
    const { data: sub } = createSupabaseClient().auth.onAuthStateChange((_e, session) => {
      if (!alive) return;
      // Initial empty session must not cancel the dev billing identity lookup.
      if (_e === 'INITIAL_SESSION' && !session?.user) return;
      authChanged = true;
      const id = session?.user?.id || null;
      if (id === identityRef.current && _e !== 'SIGNED_OUT') return;
      identityRef.current = id;
      previewOverride = undefined;
      if (!id) applySkinToDocument(null);
      setUserId(id);
      invalidateCosmetics(id || undefined);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const onEquip = () => { previewOverride = undefined; applySkinToDocument(skinRef.current || null); invalidateCosmetics(userId || undefined); };
    window.addEventListener("cosmetics:changed", onEquip);
    return () => {
      window.removeEventListener("cosmetics:changed", onEquip);
    };
  }, [userId]);

  useEffect(() => {
    if (previewOverride !== undefined) return; // shop preview owns the theme
    applySkinToDocument(cosmetics?.skin || null);
  }, [cosmetics?.skin?.id, cosmetics?.skin?.preview]);

  useEffect(() => {
    const onPreview = (e: Event) => {
      const detail = (e as CustomEvent).detail as { skin?: SkinLike | null; reset?: boolean } | undefined;
      if (!detail || detail.reset) {
        previewOverride = undefined;
        applySkinToDocument(skinRef.current || null);
      } else {
        previewOverride = detail.skin || null;
        applySkinToDocument(previewOverride);
      }
    };
    window.addEventListener("cosmetics:preview-skin", onPreview);
    return () => {
      window.removeEventListener("cosmetics:preview-skin", onPreview);
      previewOverride = undefined;
    };
  }, []);

  return null;
}
