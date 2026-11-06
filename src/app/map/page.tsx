'use client';

import { GalaxyMapClient } from "@/components/GalaxyMap/GalaxyMapClient";
import { useI18n } from "@/lib/i18n/I18nContext";

function MapLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="map-page-loading">
      <div className="map-page-spinner" />
      <div className="map-page-text">{t('map.engineInit')}</div>
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
