/**
 * Общие стили панелей «Архитектора».
 *
 * Вынесены в модуль, чтобы панели публикации, прогресса и «где купить»
 * выглядели одинаково и не тащили в себя `ArchitectWorkspace` (иначе тесты
 * компонентов собирают всё дерево целиком).
 *
 * Границы везде разбиты на составляющие: рядом с `borderColor` из активного
 * состояния шортхенд `border` вызывает предупреждение React о смешении свойств.
 */

import type { CSSProperties } from 'react';

export const cardStyle: CSSProperties = {
  background: 'var(--panel)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  borderRadius: 4,
  padding: 14,
};

export const inputStyle: CSSProperties = {
  background: 'var(--bg)',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--text)',
  padding: '8px 10px',
  borderRadius: 3,
  fontSize: 13,
};

export const primaryButton: CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--orange)',
  color: 'var(--orange)',
  padding: '7px 14px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: 'ui-monospace, monospace',
};

export const ghostButton: CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--muted)',
  padding: '6px 12px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
};

export const chipStyle: CSSProperties = {
  background: 'transparent',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--line)',
  color: 'var(--muted)',
  padding: '3px 9px',
  borderRadius: 3,
  cursor: 'pointer',
  fontSize: 12,
};

export const chipActive: CSSProperties = {
  borderColor: 'var(--cyan)',
  color: 'var(--cyan)',
};

export const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  color: 'var(--text)',
  fontFamily: 'ui-monospace, monospace',
  letterSpacing: 0.5,
};

export const mutedText: CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
};

export const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
};

export const errorText: CSSProperties = {
  fontSize: 12,
  color: 'var(--red)',
};

export const goodText: CSSProperties = {
  fontSize: 12,
  color: 'var(--green)',
};

export const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 12,
  color: 'var(--text)',
};

export const thStyle: CSSProperties = {
  textAlign: 'left',
  color: 'var(--muted)',
  fontWeight: 400,
  borderBottom: '1px solid var(--line)',
  padding: '4px 6px',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

export const tdStyle: CSSProperties = {
  borderBottom: '1px solid var(--line)',
  padding: '5px 6px',
  verticalAlign: 'top',
};

export const barTrack: CSSProperties = {
  height: 6,
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  borderRadius: 3,
  overflow: 'hidden',
};
