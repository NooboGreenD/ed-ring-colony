// ============================================================
// Icons — Custom SVG icons in site theme style
// Thin stroke, monochrome by default, color via props
// ============================================================

import React from "react";

interface IconProps {
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}

const defaultColor = "currentColor";

function wrap(
  children: React.ReactNode,
  { size = 16, color = defaultColor, className, style }: IconProps
) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      {children}
    </svg>
  );
}

/* ── Faction / Allegiance ── */
export const IconAlliance = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></>, p);
export const IconEmpire = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 7v10M8 10l4-3 4 3"/></>, p);
export const IconFederation = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></>, p);
export const IconIndependent = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 7v10M7 12h10"/></>, p);

/* ── Squadron / Power ── */
export const IconPower = (p: IconProps) => wrap(<><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></>, p);
export const IconActivity = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>, p);
export const IconHomeSystem = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 2l-8 8h3v8h10v-8h3z"/></>, p);
export const IconLanguage = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></>, p);
export const IconTimezone = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>, p);
export const IconOpenRecruit = (p: IconProps) => wrap(<><path d="M12 2a10 10 0 100 20 10 10 0 000-20z"/><path d="M12 8v4l3 3"/></>, p);
export const IconDiscord = (p: IconProps) => wrap(<><path d="M18 8a3 3 0 00-3-3H9a3 3 0 00-3 3v8a3 3 0 003 3h6a3 3 0 003-3V8z"/><path d="M8 11h8M8 14h5"/></>, p);
export const IconWebsite = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></>, p);

/* ── Stats / UI ── */
export const IconMembers = (p: IconProps) => wrap(<><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></>, p);
export const IconProjects = (p: IconProps) => wrap(<><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></>, p);
export const IconDone = (p: IconProps) => wrap(<><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></>, p);
export const IconSquadron = (p: IconProps) => wrap(<><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></>, p);
export const IconLeaderboard = (p: IconProps) => wrap(<><path d="M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M8 9v10M16 9v10M12 4v15"/></>, p);
export const IconSuitable = (p: IconProps) => wrap(<><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/></>, p);
export const IconNotification = (p: IconProps) => wrap(<><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></>, p);
export const IconStats = (p: IconProps) => wrap(<><path d="M18 20V10M12 20V4M6 20v-6"/></>, p);
export const IconAtlas = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></>, p);
export const IconSettings = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></>, p);
export const IconProfile = (p: IconProps) => wrap(<><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></>, p);
export const IconLock = (p: IconProps) => wrap(<><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></>, p);
export const IconSend = (p: IconProps) => wrap(<><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></>, p);
export const IconTrash = (p: IconProps) => wrap(<><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6"/></>, p);
export const IconNote = (p: IconProps) => wrap(<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></>, p);
export const IconSearch = (p: IconProps) => wrap(<><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></>, p);
export const IconError = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></>, p);
export const IconCheck = (p: IconProps) => wrap(<><path d="M20 6L9 17l-5-5"/></>, p);
export const IconBuilding = (p: IconProps) => wrap(<><path d="M2 20h20M5 20v-8l7-4 7 4v8M9 20v-4h6v4"/></>, p);
export const IconWaiting = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>, p);
export const IconUnsubscribe = (p: IconProps) => wrap(<><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0M2 2l20 20"/></>, p);
export const IconSync = (p: IconProps) => wrap(<><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.3"/></>, p);
export const IconDeepSync = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/><path d="M21 12a9 9 0 11-6.36-8.64"/></>, p);
export const IconHistory = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/><path d="M12 2a10 10 0 00-7.07 17.07"/></>, p);
export const IconArrowRight = (p: IconProps) => wrap(<><path d="M5 12h14M12 5l7 7-7 7"/></>, p);
export const IconArrowLeft = (p: IconProps) => wrap(<><path d="M19 12H5M12 19l-7-7 7-7"/></>, p);
export const IconSatellite = (p: IconProps) => wrap(<><path d="M4 20l4-4M8 16l-4 4M12 2l-2 2 4 4 2-2zM6 10l4 4M14 6l4 4M10 14l4 4M18 2l4 4M2 18l4 4"/></>, p);
export const IconPin = (p: IconProps) => wrap(<><path d="M12 2v8M5 12h14M12 10l-4 8h8l-4-8z"/></>, p);
export const IconExternalLink = (p: IconProps) => wrap(<><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3"/></>, p);
export const IconMic = (p: IconProps) => wrap(<><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></>, p);
export const IconMicOff = (p: IconProps) => wrap(<><line x1="2" y1="2" x2="22" y2="22"/><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></>, p);
export const IconHeadphones = (p: IconProps) => wrap(<><path d="M3 14v3a2 2 0 0 0 2 2h2v-7H5a2 2 0 0 0-2 2Z"/><path d="M21 14v3a2 2 0 0 1-2 2h-2v-7h2a2 2 0 0 1 2 2Z"/><path d="M5 12a7 7 0 0 1 14 0"/></>, p);
export const IconVolumeOff = (p: IconProps) => wrap(<><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></>, p);
export const IconVolumeOn = (p: IconProps) => wrap(<><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></>, p);
export const IconPhoneOff = (p: IconProps) => wrap(<><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/></>, p);
export const IconUsers = (p: IconProps) => wrap(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>, p);
export const IconPlane = (p: IconProps) => wrap(<><path d="M12 2l-1.5 4h3z"/><path d="M10.5 6h3v9h-3z"/><path d="M4 9l6.5-3v6H4z"/><path d="M13.5 6l6.5 3v6h-6.5z"/><path d="M9 15h6l-1.5 4h-3z"/></>, p);
export const IconRadio = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></>, p);

/* ── Achievement / Hero icons ── */
export const IconAnchor = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="3"/><path d="M12 2v7"/><path d="M5 12a7 7 0 0014 0"/></>, p);
export const IconRoute = (p: IconProps) => wrap(<><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M8 17l6-8"/></>, p);
export const IconCrown = (p: IconProps) => wrap(<><path d="M2 4l3 12h14l3-12-6 4-4-8-4 8-6-4z"/><path d="M5 16v4h14v-4"/></>, p);
export const IconSword = (p: IconProps) => wrap(<><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/></>, p);
export const IconDiamond = (p: IconProps) => wrap(<><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3L8 9l4 13 4-13-3-6"/></>, p);
export const IconCastle = (p: IconProps) => wrap(<><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></>, p);
export const IconStar = (p: IconProps) => wrap(<><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></>, p);
export const IconRocket = (p: IconProps) => wrap(<><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/></>, p);
export const IconBolt = (p: IconProps) => wrap(<><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></>, p);
export const IconInfo = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></>, p);
export const IconGear = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></>, p);
export const IconShield = (p: IconProps) => wrap(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></>, p);

export const IconWiki = (p: IconProps) => wrap(<><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></>, p);

/* ── Helper: Achievement icon by emoji / id ── */
export function AchievementIcon({ icon, size = 22, color = "currentColor" }: { icon: string; size?: number; color?: string }) {
  switch (icon) {
    case '⚓': return <IconAnchor size={size} color={color} />;
    case '⚙️': return <IconGear size={size} color={color} />;
    case '💎': return <IconDiamond size={size} color={color} />;
    case '🛡️': return <IconShield size={size} color={color} />;
    case '🌌': return <IconAtlas size={size} color={color} />;
    case '📡': return <IconRadio size={size} color={color} />;
    case '🏗️': return <IconBuilding size={size} color={color} />;
    case '👑': return <IconCrown size={size} color={color} />;
    case '⚔️': return <IconSword size={size} color={color} />;
    case '💠': return <IconDiamond size={size} color={color} />;
    case '🏰': return <IconCastle size={size} color={color} />;
    case '🌠': return <IconStar size={size} color={color} />;
    case '🚀': return <IconRocket size={size} color={color} />;
    case '⚡': return <IconBolt size={size} color={color} />;
    default: return <span style={{ fontSize: size }}>{icon}</span>;
  }
}

/* ── Helper: Allegiance icon by name ── */
export function AllegianceIcon({ allegiance, size = 14, color = "#9ca3af" }: { allegiance: string | null; size?: number; color?: string }) {
  switch (allegiance) {
    case "Alliance": return <IconAlliance size={size} color={color} />;
    case "Empire": return <IconEmpire size={size} color={color} />;
    case "Federation": return <IconFederation size={size} color={color} />;
    default: return <IconIndependent size={size} color={color} />;
  }
}
