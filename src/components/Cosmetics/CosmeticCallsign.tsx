"use client";

import React from "react";

interface CosmeticCallsignProps {
  name: string;
  glowId?: string | null;
  tag?: string | null;
  tier?: string | null;
  className?: string;
  fontSize?: number;
}

export default function CosmeticCallsign({
  name,
  glowId,
  tag,
  tier,
  className = "",
  fontSize = 16,
}: CosmeticCallsignProps) {
  let textStyle: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontWeight: 700,
    letterSpacing: "1px",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    fontSize,
  };

  let nameStyle: React.CSSProperties = {
    color: "#eeeeee",
    transition: "all 0.3s ease",
  };

  if (glowId === "glow-hyperspace") {
    nameStyle = {
      background: "linear-gradient(90deg, #ec4899, #8b5cf6, #06b6d4, #ec4899)",
      backgroundSize: "200% auto",
      WebkitBackgroundClip: "text",
      WebkitTextFillColor: "transparent",
      filter: "drop-shadow(0 0 8px rgba(139, 92, 246, 0.6))",
      animation: "hyperGlow 4s linear infinite",
    };
  } else if (glowId === "glow-neutron") {
    nameStyle = {
      color: "#e0f2fe",
      textShadow: "0 0 10px #38bdf8, 0 0 20px #0284c7, 0 0 30px #0369a1",
      letterSpacing: "1.5px",
    };
  } else if (glowId === "glow-solar") {
    nameStyle = {
      color: "#fef08a",
      textShadow: "0 0 8px #f59e0b, 0 0 16px #d97706",
    };
  } else if (glowId === "glow-voidpulse") {
    nameStyle = {
      color: "#f3e8ff",
      textShadow: "0 0 10px #9333ea, 0 0 18px #7e22ce",
    };
  }

  return (
    <span className={`cmdr-callsign ${className}`} style={textStyle}>
      <style>{`
        @keyframes hyperGlow {
          0% { background-position: 0% center; }
          100% { background-position: 200% center; }
        }
      `}</style>

      {tier && (
        <span
          style={{
            fontSize: 10,
            padding: "1px 5px",
            borderRadius: 2,
            background:
              tier === "VIP ADMIRAL"
                ? "rgba(155, 89, 182, 0.2)"
                : tier === "ELITE"
                ? "rgba(230, 126, 34, 0.2)"
                : "rgba(52, 152, 219, 0.2)",
            border: `1px solid ${
              tier === "VIP ADMIRAL"
                ? "#9b59b6"
                : tier === "ELITE"
                ? "#e67e22"
                : "#3498db"
            }`,
            color:
              tier === "VIP ADMIRAL"
                ? "#c084fc"
                : tier === "ELITE"
                ? "#f39c12"
                : "#60a5fa",
            fontWeight: 700,
            letterSpacing: 1,
          }}
        >
          {tier}
        </span>
      )}

      {tag && (
        <span style={{ color: "var(--muted, #9ca3af)", fontSize: fontSize * 0.85 }}>
          [{tag}]
        </span>
      )}

      <span style={nameStyle}>{name}</span>
    </span>
  );
}
