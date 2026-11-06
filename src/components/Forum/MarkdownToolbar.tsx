"use client";
import { IconLink, IconQuote } from "@/components/Icons";

import { useRef } from "react";
import { useI18n } from "@/lib/i18n/I18nContext";

interface MarkdownToolbarProps {
  textareaRef?: React.RefObject<HTMLTextAreaElement | null> | null;
  onChange: (value: string) => void;
  getValue: () => string;
}

export function MarkdownToolbar({ textareaRef, onChange, getValue }: MarkdownToolbarProps) {
  const { t } = useI18n();
  const insert = (before: string, after: string = "") => {
    const el = textareaRef?.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const text = getValue();
    const selected = text.slice(start, end);
    const replacement = before + selected + after;
    const newText = text.slice(0, start) + replacement + text.slice(end);
    onChange(newText);
    setTimeout(() => {
      el.focus();
      const newCursor = start + before.length + (selected ? selected.length : 0);
      el.setSelectionRange(newCursor, newCursor);
    }, 0);
  };

  const wrap = (marker: string) => insert(marker, marker);

  const buttons = [
    { label: "B", title: t("mtb.bold"), action: () => wrap("**"), style: { fontWeight: 700 } },
    { label: "I", title: t("mtb.italic"), action: () => wrap("*"), style: { fontStyle: "italic" } },
    { label: "</>", title: t("mtb.inlineCode"), action: () => wrap("`"), style: { fontFamily: "monospace" } },
    { label: "{}" , title: t("mtb.codeBlock"), action: () => insert("```\n", "\n```") },
    { label: "link", icon: <IconLink size={13} />, title: t("mtb.link"), action: () => insert("[", "](url)") },
    { label: "quote", icon: <IconQuote size={13} />, title: t("mtb.quote"), action: () => insert("> ", "") },
    { label: "•", title: t("mtb.list"), action: () => insert("- ", "") },
    { label: "—", title: t("mtb.hr"), action: () => insert("\n---\n", "") },
  ];

  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
      {buttons.map((btn) => (
        <button
          key={btn.label}
          type="button"
          onClick={btn.action}
          title={btn.title}
          style={{
            padding: "4px 10px",
            fontSize: 13,
            background: "#25282b",
            border: "1px solid #323538",
            borderRadius: 4,
            color: "#9ca3af",
            cursor: "pointer",
            minWidth: 32,
            ...btn.style,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "#e67e22";
            e.currentTarget.style.color = "#eeeeee";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "#323538";
            e.currentTarget.style.color = "#9ca3af";
          }}
        >
          {btn.icon || btn.label}
        </button>
      ))}
    </div>
  );
}
