'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import styles from './AdminShell.module.css';

/** Only the displayed slice changes; callers retain the full route for bulk actions. */
export function useRoutePagination<T>(rows: T[], resetKey = '') {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages);
  useEffect(() => { setPage(1); }, [resetKey, pageSize]);
  useEffect(() => { setPage(p => Math.min(p, pages)); }, [pages]);
  const offset = (currentPage - 1) * pageSize;
  return { rows: rows.slice(offset, offset + pageSize), total: rows.length, page: currentPage,
    pages, pageSize, offset, onPage: setPage, onPageSize: setPageSize };
}

export function RoutePagination({ total, page, pages, pageSize, offset, onPage, onPageSize }: {
  total: number; page: number; pages: number; pageSize: number; offset: number;
  onPage: (page: number) => void; onPageSize: (size: number) => void;
}) {
  const { t } = useI18n();
  return <nav className={styles.pagination} aria-label={t('admin.routePagination')}>
    <span role="status">{t('admin.shown')} {total ? offset + 1 : 0}–{Math.min(offset + pageSize, total)} / {total}</span>
    <label>{t('admin.rowsPerPage')}
      <select value={pageSize} onChange={event => onPageSize(Number(event.target.value))}>
        {[50, 100, 250].map(size => <option key={size} value={size}>{size}</option>)}
      </select>
    </label>
    <div className={styles.paginationActions}>
      <button type="button" onClick={() => onPage(1)} disabled={page <= 1} aria-label={t('admin.firstPage')}>«</button>
      <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label={t('admin.previousPage')}>‹</button>
      <label>{t('admin.page')}
        <select value={page} onChange={event => onPage(Number(event.target.value))}>
          {Array.from({ length: pages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
        </select> / {pages}
      </label>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label={t('admin.nextPage')}>›</button>
      <button type="button" onClick={() => onPage(pages)} disabled={page >= pages} aria-label={t('admin.lastPage')}>»</button>
    </div>
  </nav>;
}
