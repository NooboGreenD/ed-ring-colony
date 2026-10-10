'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconX } from '@/components/Icons';
import styles from './OutfittingAdmin.module.css';

/** Native dialog supplies focus trapping, inert background and Escape support. */
export default function OutfittingDialog({ title, eyebrow, children, onClose, busy = false, compact = false }: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    else dialog?.setAttribute('open', '');
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <dialog ref={ref} aria-labelledby={titleId} aria-modal="true"
      className={`${styles.dialog} ${compact ? styles.compactDialog : ''}`}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || busy) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}>
      <header className={styles.dialogHeader}>
        <div>{eyebrow && <span className={styles.eyebrow}>{eyebrow}</span>}<h2 id={titleId}>{title}</h2></div>
        <button type="button" className={styles.iconButton} aria-label="Закрыть окно" disabled={busy} onClick={onClose}><IconX size={18} color="currentColor" /></button>
      </header>
      {children}
    </dialog>, document.body,
  );
}
