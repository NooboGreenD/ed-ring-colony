"use client";

import React from "react";
import { IconProfile } from "@/components/Icons";

interface CosmeticAvatarProps {
  avatarUrl?: string | null;
  cmdrName?: string | null;
  frameId?: string | null;
  size?: number;
  className?: string;
  showScanlines?: boolean;
}

export default function CosmeticAvatar({
  avatarUrl,
  cmdrName,
  frameId,
  size = 64,
  className = "",
  showScanlines = false,
}: CosmeticAvatarProps) {
  const pad = frameId ? Math.max(4, Math.round(size * 0.08)) : 0;
  const innerSize = size - pad * 2;

  // Render frame overlay based on frameId
  const renderFrameDecoration = () => {
    if (!frameId) return null;

    if (frameId === "frame-singularity") {
      return (
        <>
          {/* Gravitational ring */}
          <div
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: "50%",
              background: "conic-gradient(from 0deg, #9333ea, #3b82f6, #ec4899, #9333ea)",
              opacity: 0.85,
              animation: "spin 6s linear infinite",
              filter: "blur(1px)",
              zIndex: 1,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: -1,
              borderRadius: "50%",
              boxShadow: "0 0 12px rgba(147, 51, 234, 0.8), inset 0 0 8px rgba(59, 130, 246, 0.5)",
              zIndex: 3,
              pointerEvents: "none",
            }}
          />
        </>
      );
    }

    if (frameId === "frame-vanguard") {
      return (
        <>
          {/* Tactical HUD brackets */}
          <div
            style={{
              position: "absolute",
              inset: -4,
              border: "2px solid #e67e22",
              boxShadow: "0 0 10px rgba(230, 126, 34, 0.5)",
              clipPath:
                "polygon(0% 25%, 25% 0%, 75% 0%, 100% 25%, 100% 75%, 75% 100%, 25% 100%, 0% 75%)",
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
          {/* Corner telemetry dots */}
          <span style={{ position: "absolute", top: -2, left: -2, width: 4, height: 4, background: "#f39c12", zIndex: 4 }} />
          <span style={{ position: "absolute", top: -2, right: -2, width: 4, height: 4, background: "#f39c12", zIndex: 4 }} />
          <span style={{ position: "absolute", bottom: -2, left: -2, width: 4, height: 4, background: "#f39c12", zIndex: 4 }} />
          <span style={{ position: "absolute", bottom: -2, right: -2, width: 4, height: 4, background: "#f39c12", zIndex: 4 }} />
        </>
      );
    }

    if (frameId === "frame-subzero") {
      return (
        <>
          <div
            style={{
              position: "absolute",
              inset: -3,
              border: "2px solid #06b6d4",
              borderRadius: "14%",
              boxShadow: "0 0 12px rgba(6, 182, 212, 0.75), inset 0 0 6px rgba(56, 189, 248, 0.4)",
              animation: "pulseSubzero 3s ease-in-out infinite alternate",
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
        </>
      );
    }

    if (frameId === "frame-solar") {
      return (
        <>
          <div
            style={{
              position: "absolute",
              inset: -3,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(249,115,22,0.8) 0%, rgba(234,179,8,0.2) 70%, transparent 100%)",
              boxShadow: "0 0 16px rgba(249, 115, 22, 0.9), 0 0 6px rgba(234, 179, 8, 0.6)",
              border: "2px solid #f97316",
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
        </>
      );
    }

    if (frameId === "frame-stealth") {
      return (
        <>
          <div
            style={{
              position: "absolute",
              inset: -2,
              border: "2px solid #ef4444",
              borderRadius: "4px",
              boxShadow: "0 0 8px rgba(239, 68, 68, 0.5)",
              zIndex: 2,
              pointerEvents: "none",
            }}
          />
          {/* Laser targeting crosshairs */}
          <div style={{ position: "absolute", top: -4, left: "50%", width: 2, height: 4, background: "#ef4444", zIndex: 4, transform: "translateX(-50%)" }} />
          <div style={{ position: "absolute", bottom: -4, left: "50%", width: 2, height: 4, background: "#ef4444", zIndex: 4, transform: "translateX(-50%)" }} />
          <div style={{ position: "absolute", left: -4, top: "50%", width: 4, height: 2, background: "#ef4444", zIndex: 4, transform: "translateY(-50%)" }} />
          <div style={{ position: "absolute", right: -4, top: "50%", width: 4, height: 2, background: "#ef4444", zIndex: 4, transform: "translateY(-50%)" }} />
        </>
      );
    }

    return null;
  };

  const isSquarish = frameId === "frame-vanguard" || frameId === "frame-stealth" || frameId === "frame-subzero";
  const avatarBorderRadius = isSquarish ? "4px" : "50%";

  return (
    <div
      className={`cosmetic-avatar-wrapper ${className}`}
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes pulseSubzero {
          0% { box-shadow: 0 0 6px rgba(6, 182, 212, 0.4); opacity: 0.8; }
          100% { box-shadow: 0 0 16px rgba(6, 182, 212, 0.9); opacity: 1; }
        }
      `}</style>

      {renderFrameDecoration()}

      <div
        style={{
          position: "relative",
          width: innerSize,
          height: innerSize,
          borderRadius: avatarBorderRadius,
          overflow: "hidden",
          background: "#25282b",
          border: frameId ? "none" : "1px solid var(--line, #3a3d40)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 2,
        }}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={cmdrName || "CMDR"}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#323538",
            }}
          >
            <IconProfile size={Math.round(innerSize * 0.55)} color="#9ca3af" />
          </div>
        )}

        {showScanlines && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 2px)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
