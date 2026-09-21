"use client";

import React from "react";
import CosmeticAvatar from "./CosmeticAvatar";
import CosmeticBadge from "./CosmeticBadge";
import CosmeticCallsign from "./CosmeticCallsign";
import CosmeticTitle from "./CosmeticTitle";
import { useCosmeticsFor } from "./useCosmetics";

/** Header avatar for /cmdr/[name] with the equipped frame. */
export function CmdrProfileHeader({ userId, name, avatarUrl }: { userId: string | null; name: string; avatarUrl: string | null }) {
  const c = useCosmeticsFor(userId);
  return <CosmeticAvatar avatarUrl={avatarUrl} cmdrName={name} frameId={c?.frame?.id} framePreview={c?.frame?.preview} size={72} />;
}

/** Name line for /cmdr/[name]: badge + glowing callsign + tier + title. */
export function CmdrProfileName({ userId, name }: { userId: string | null; name: string }) {
  const c = useCosmeticsFor(userId);
  return (
    <>
      {c?.badge && <CosmeticBadge badgeId={c.badge.id} badgePreview={c.badge.preview} title={c.badge.title} size={26} />}
      <CosmeticCallsign name={name} glowId={c?.glow?.id} glowPreview={c?.glow?.preview} tier={c?.tier?.label || null} tierColor={c?.tier?.color || null} fontSize={24} monospace={false} />
      {c?.title && <CosmeticTitle titleId={c.title.id} titlePreview={c.title.preview} text={c.title.title} size={11} />}
    </>
  );
}
