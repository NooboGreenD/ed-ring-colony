'use client';

import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { GalaxyMapProps } from './GalaxyMap';

type GalaxyMapComponent = ComponentType<GalaxyMapProps>;

interface GalaxyMapClientProps extends GalaxyMapProps {
  loadingFallback?: ReactNode;
  errorFallback?: ReactNode;
}

/**
 * Load the WebGL map only after the browser has mounted this wrapper.
 *
 * This intentionally uses a native dynamic import instead of next/dynamic with
 * `ssr: false`: Next 16.4.2's CSR-bailout wrapper calls React.use(browser(...))
 * in the client bundle, which React 19.2 rejects (error #438). The resulting
 * React error unmounts R3F's Canvas and Three.js then reports a misleading
 * "WebGLRenderer: Context Lost" during renderer cleanup.
 */
export function GalaxyMapClient({
  loadingFallback = null,
  errorFallback,
  ...mapProps
}: GalaxyMapClientProps) {
  const [Map, setMap] = useState<GalaxyMapComponent | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void import('./GalaxyMap').then(
      ({ default: GalaxyMap }) => {
        if (active) setMap(() => GalaxyMap);
      },
      (error: unknown) => {
        console.error('[GalaxyMap] Failed to load the map chunk:', error);
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  if (Map) return <Map {...mapProps} />;
  if (failed) {
    return errorFallback ?? (
      <div role="alert" className="map-page-loading">
        Не удалось загрузить 3D-карту. Обновите страницу и попробуйте снова.
      </div>
    );
  }
  return <>{loadingFallback}</>;
}
