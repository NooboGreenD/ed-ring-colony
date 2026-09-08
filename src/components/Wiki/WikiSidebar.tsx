'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function WikiSidebar() {
  const pathname = usePathname();
  const [categories, setCategories] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/wiki/categories')
      .then(r => r.json())
      .then(data => setCategories(data || []))
      .catch(() => {});
  }, []);

  return (
    <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--line)', padding: '20px 16px', minHeight: 'calc(100vh - 60px)' }}>
      <Link href="/wiki" style={{ fontSize: 14, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--orange)', display: 'block', marginBottom: 20 }}>
        ВИКИПЕДИЯ
      </Link>
      <div style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 12 }}>
        Категории
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {categories.map((cat: any) => (
          <Link
            key={cat.id}
            href={`/wiki/category/${cat.slug}`}
            style={{
              padding: '8px 12px',
              fontSize: 13,
              color: pathname === `/wiki/category/${cat.slug}` ? 'var(--orange)' : 'var(--text)',
              background: pathname === `/wiki/category/${cat.slug}` ? 'rgba(230,126,34,0.08)' : 'transparent',
              borderRadius: 2,
              textDecoration: 'none',
              transition: 'all 0.2s',
              borderLeft: pathname === `/wiki/category/${cat.slug}` ? '2px solid var(--orange)' : '2px solid transparent',
            }}
          >
            {cat.name}
          </Link>
        ))}
      </div>
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        <Link href="/wiki/create" className="btn" style={{ width: '100%', textAlign: 'center', padding: '10px', fontSize: 11 }}>
          + Создать статью
        </Link>
      </div>
    </div>
  );
}
