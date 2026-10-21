'use client';

import { GalaxyMapClient } from "@/components/GalaxyMap/GalaxyMapClient";

function MapLoadingFallback() {
  return (
    <div className="map-page-loading">
      <div className="map-page-spinner" />
      <div className="map-page-text">Инициализация 3D-движка...</div>
    </div>
  );
}

export default function MapPage() {
  return (
    <div className="map-page" style={{ margin: "-16px -20px", width: "calc(100% + 40px)", height: "calc(100vh - 52px)" }}>
      <GalaxyMapClient showOnlyMainRoute loadingFallback={<MapLoadingFallback />} />
    </div>
  );
}
