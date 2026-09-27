'use client';

import { useEffect, useState } from 'react';
import { avatarColor, avatarInitials, resolveAvatarUrl } from '@/lib/avatarUrl';

interface AvatarProps {
  url?: string | null;
  name?: string | null;
  size?: number;
  /** Круглый (по умолчанию) или со скруглением как у карточек. */
  rounded?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

/**
 * Аватар пилота, который никогда не показывает «битую» картинку.
 *
 * Адрес приводится к текущему Supabase (см. `src/lib/avatarUrl.ts`: после
 * переезда в базе остались ссылки на прежний хост), а если файл всё равно не
 * открылся — рисуются инициалы. Раньше на месте недоступного аватара
 * оставался системный значок сломанного изображения, из-за чего казалось, что
 * «картинки профиля не загружаются» у всего сайта.
 */
export default function Avatar({
  url,
  name,
  size = 32,
  rounded = true,
  className,
  style,
  title,
}: AvatarProps) {
  const resolved = resolveAvatarUrl(url);
  const [failed, setFailed] = useState(false);

  // Новый адрес — новая попытка: иначе после смены аватарки остались бы
  // инициалы от прежней неудачи.
  useEffect(() => setFailed(false), [resolved]);

  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: rounded ? '50%' : Math.max(4, Math.round(size * 0.18)),
    flexShrink: 0,
    objectFit: 'cover',
    display: 'block',
    ...style,
  };

  if (!resolved || failed) {
    return (
      <span
        className={className}
        title={title ?? name ?? undefined}
        aria-label={name ?? 'CMDR'}
        style={{
          ...base,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: avatarColor(name),
          color: '#e5e7eb',
          fontSize: Math.max(9, Math.round(size * 0.4)),
          fontWeight: 600,
          letterSpacing: 0.5,
          userSelect: 'none',
          lineHeight: 1,
        }}
      >
        {avatarInitials(name)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolved}
      alt={name ?? ''}
      title={title ?? name ?? undefined}
      className={className}
      style={base}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
