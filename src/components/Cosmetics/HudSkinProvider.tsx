"use client";

import { useEffect } from "react";
import { getCurrentUser, createSupabaseClient } from "@/lib/supabaseClient";
import { useCosmeticsFor, invalidateCosmetics } from "./useCosmetics";
import { useState } from "react";

/**
 * Applies the equipped HUD skin of the signed-in pilot to <html>:
 *  - class  `hud-<hudSkinClass>` (for CSS rules in globals.css)
 *  - CSS variables --orange / --orange-hover / --cyan overridden with the
 *    skin's `color` / `accentColor` so the whole site recolours.
 */
export default function HudSkinProvider() {
  const [userId, setUserId] = useState<string | null>(null);
  const cosmetics = useCosmeticsFor(userId);

  useEffect(() => {
    let alive = true;
    getCurrentUser().then((u) => alive && setUserId(u?.id || null)).catch(() => {});
    const { data: sub } = createSupabaseClient().auth.onAuthStateChange((_e, session) => {
      if (!alive) return;
      const id = session?.user?.id || null;
      setUserId(id);
      invalidateCosmetics(id || undefined);
    });
    const onEquip = () => invalidateCosmetics(userId || undefined);
    window.addEventListener("cosmetics:changed", onEquip);
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      window.removeEventListener("cosmetics:changed", onEquip);
    };
  }, [userId]);

  useEffect(() => {
    const root = document.documentElement;
    const prev = Array.from(root.classList).filter((c) => c.startsWith("hud-"));
    prev.forEach((c) => root.classList.remove(c));
    const skin = cosmetics?.skin;
    if (!skin) {
      root.style.removeProperty("--orange");
      root.style.removeProperty("--orange-hover");
      root.style.removeProperty("--cyan");
      root.removeAttribute("data-hud-skin");
      return;
    }
    const p = skin.preview || {};
    if (p.hudSkinClass) root.classList.add(`hud-${p.hudSkinClass}`);
    root.setAttribute("data-hud-skin", skin.id);
    if (p.color) {
      root.style.setProperty("--orange", p.color);
      root.style.setProperty("--orange-hover", p.accentColor || p.color);
    }
    if (p.accentColor) root.style.setProperty("--cyan", p.accentColor);
    if (p.cssEffects && typeof p.cssEffects === "object") {
      for (const [k, v] of Object.entries(p.cssEffects)) if (k.startsWith("--")) root.style.setProperty(k, String(v));
    }
  }, [cosmetics?.skin?.id, cosmetics?.skin?.preview]);

  return null;
}
