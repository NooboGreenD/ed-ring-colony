"use client";

import React from "react";

interface CosmeticTitleProps {
  titleId?: string | null;
  className?: string;
}

export default function CosmeticTitle({ titleId, className = "" }: CosmeticTitleProps) {
  if (!titleId) return null;

  let title = "";
  let color = "#e67e22";
  let border = "rgba(230, 126, 34, 0.4)";
  let bg = "rgba(230, 126, 34, 0.1)";

  switch (titleId) {
    case "title-architect":
      title = "«Архитектор Нового Рубежа»";
      color = "#f97316";
      border = "rgba(249, 115, 22, 0.4)";
      bg = "rgba(249, 115, 22, 0.1)";
      break;

    case "title-trailblazer":
      title = "«Первопроходец Бездны»";
      color = "#c084fc";
      border = "rgba(192, 132, 252, 0.4)";
      bg = "rgba(192, 132, 252, 0.1)";
      break;

    case "title-jaques":
      title = "«Легенда Жак-Стейшн»";
      color = "#38bdf8";
      border = "rgba(56, 189, 248, 0.4)";
      bg = "rgba(56, 189, 248, 0.1)";
      break;

    case "title-marshal":
      title = "«Маршал Звездного Пути»";
      color = "#fbbf24";
      border = "rgba(251, 191, 36, 0.4)";
      bg = "rgba(251, 191, 36, 0.1)";
      break;

    default:
      return null;
  }

  return (
    <div
      className={`cmdr-honorary-title ${className}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 2,
        background: bg,
        border: `1px solid ${border}`,
        color,
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        fontWeight: 600,
        letterSpacing: "1px",
        textTransform: "uppercase",
      }}
    >
      {title}
    </div>
  );
}
