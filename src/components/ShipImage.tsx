'use client';

import React, { useState } from 'react';

interface ShipImageProps {
  src: string;
  alt?: string;
  color?: string;
  label?: string;
  width?: number;
  height?: number;
}

/**
 * Картинка корабля с fallback на цветной плейсхолдер при 404.
 * Работает на клиенте: если изображение не загрузилось (ошибка сети, 404),
 * показывается цветная плашка с эмодзи 🚀 вместо проваливающегося фона.
 */
export function ShipImage({
  src,
  alt = '',
  color = '#3a3d40',
  label,
  width = 260,
  height = 140,
}: ShipImageProps) {
  const [error, setError] = useState(false);

  return (
    <div
      style={{
        width,
        height,
        background: error ? color : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {!error && (
        <img
          src={src}
          alt={alt}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            objectPosition: 'center',
            display: 'block',
          }}
          onError={() => setError(true)}
        />
      )}
      {error && (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#eeeeee',
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          <div style={{ fontSize: 48, marginBottom: 8 }}>🚀</div>
          {label && (
            <div style={{ fontSize: 11, opacity: 0.8 }}>{label}</div>
          )}
        </div>
      )}
    </div>
  );
}
