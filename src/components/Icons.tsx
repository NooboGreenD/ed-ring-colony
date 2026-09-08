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
export const IconJournal = (p: IconProps) => wrap(<><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></>, p);
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


/* ── Emoji replacements ── */
export const IconCheckCircle = (p: IconProps) => wrap(<><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></>, p);
export const IconXCircle = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></>, p);
export const IconMessage = (p: IconProps) => wrap(<><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></>, p);
export const IconAlert = (p: IconProps) => wrap(<><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>, p);
export const IconMapPin = (p: IconProps) => wrap(<><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></>, p);
export const IconRefresh = (p: IconProps) => wrap(<><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0118.8-4.3L23 12"/><path d="M20.49 15a9 9 0 01-18.8 4.3L1 12"/></>, p);
export const IconMap = (p: IconProps) => wrap(<><polygon points="1 6 1 22 8 18 16 22 21 18 21 2 16 6 8 2 1 6"/><path d="M8 2v16M16 6v16"/></>, p);
export const IconTarget = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>, p);
export const IconPackage = (p: IconProps) => wrap(<><path d="M16.5 9.4l-9-5.2L2 9.4v5.2l9 5.2 9-5.2V9.4z"/><path d="M16.5 9.4L12 12 7.5 9.4"/><path d="M12 12v5.2"/></>, p);
export const IconUserWorker = (p: IconProps) => wrap(<><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/><path d="M12 2v2M9 4h6"/></>, p);
export const IconWrench = (p: IconProps) => wrap(<><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></>, p);
export const IconChart = (p: IconProps) => wrap(<><path d="M18 20V10M12 20V4M6 20v-6"/></>, p);
export const IconClock = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>, p);
export const IconSave = (p: IconProps) => wrap(<><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><path d="M17 21v-8H7v8"/></>, p);
export const IconStore = (p: IconProps) => wrap(<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/></>, p);
export const IconCoins = (p: IconProps) => wrap(<><circle cx="8" cy="8" r="6"/><path d="M18 8a6 6 0 010 12"/><path d="M22 8a6 6 0 010 12"/></>, p);
export const IconLink = (p: IconProps) => wrap(<><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></>, p);
export const IconQuote = (p: IconProps) => wrap(<><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/></>, p);
export const IconDroplet = (p: IconProps) => wrap(<><path d="M12 2.69l5.66 5.66a8 8 0 11-11.31 0z"/></>, p);
export const IconSprout = (p: IconProps) => wrap(<><path d="M7 20h10"/><path d="M10 20c5.5-2.5.8-6.4 3-10"/><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7"/><path d="M14.1 6a7 7 0 00-5.7 3.8"/></>, p);
export const IconCircle = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/></>, p);
export const IconCircleDot = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></>, p);
export const IconCircleFill = (p: IconProps) => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill={p.color ?? defaultColor} style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}><circle cx="12" cy="12" r="8"/></svg>;
export const IconChevronUp = (p: IconProps) => wrap(<><path d="M18 15l-6-6-6 6"/></>, p);
export const IconChevronDown = (p: IconProps) => wrap(<><path d="M6 9l6 6 6-6"/></>, p);
export const IconGlobe = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></>, p);
export const IconFlame = (p: IconProps) => wrap(<><path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 2.5z"/></>, p);
export const IconBell = (p: IconProps) => wrap(<><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></>, p);
export const IconBellOff = (p: IconProps) => wrap(<><path d="M13.73 21a2 2 0 01-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0018 8"/><path d="M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 00-9.33-5"/><path d="M1 1l22 22"/></>, p);
export const IconImage = (p: IconProps) => wrap(<><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></>, p);
export const IconPaperclip = (p: IconProps) => wrap(<><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></>, p);
export const IconSun = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></>, p);
export const IconRingPlanet = (p: IconProps) => wrap(<><circle cx="12" cy="12" r="6"/><ellipse cx="12" cy="12" rx="12" ry="4" transform="rotate(-20 12 12)"/></>, p);
export const IconConstruction = (p: IconProps) => wrap(<><path d="M2 20h20M4 20v-8l7-4 7 4v8M9 20v-4h6v4"/></>, p);
export const IconHeart = (p: IconProps) => wrap(<><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></>, p);
export const IconThumbsUp = (p: IconProps) => wrap(<><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></>, p);
export const IconX = (p: IconProps) => wrap(<><path d="M18 6L6 18M6 6l12 12"/></>, p);
export const IconLogOut = (p: IconProps) => wrap(<><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></>, p);
export const IconVolume = (p: IconProps) => wrap(<><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></>, p);
export const IconPhone = (p: IconProps) => wrap(<><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></>, p);
export const IconEye = (p: IconProps) => wrap(<><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>, p);
export const IconHome = (p: IconProps) => wrap(<><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><path d="M9 22V12h6v10"/></>, p);

/* ── Helper: Achievement icon by emoji / id ── */
export function AchievementIcon({ icon, size = 22, color = "currentColor" }: { icon: string; size?: number; color?: string }) {
  switch (icon) {
    case '⚓':
    case 'anchor': return <IconAnchor size={size} color={color} />;
    case '⚙️':
    case 'gear': return <IconGear size={size} color={color} />;
    case '💎':
    case 'diamond': return <IconDiamond size={size} color={color} />;
    case '🛡️':
    case 'shield': return <IconShield size={size} color={color} />;
    case '🌌':
    case 'atlas': return <IconAtlas size={size} color={color} />;
    case '📡':
    case 'radio': return <IconRadio size={size} color={color} />;
    case '🏗️':
    case 'building': return <IconBuilding size={size} color={color} />;
    case '👑':
    case 'crown': return <IconCrown size={size} color={color} />;
    case '⚔️':
    case 'sword': return <IconSword size={size} color={color} />;
    case '💠':
    case 'gem': return <IconDiamond size={size} color={color} />;
    case '🏰':
    case 'castle': return <IconCastle size={size} color={color} />;
    case '🌠':
    case 'star': return <IconStar size={size} color={color} />;
    case '🚀':
    case 'rocket': return <IconRocket size={size} color={color} />;
    case '⚡':
    case 'bolt': return <IconBolt size={size} color={color} />;
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
