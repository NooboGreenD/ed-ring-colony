"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useI18n } from "@/lib/i18n/I18nContext";
import SiteFooter from "@/components/SiteFooter";
import { footerFromContent, DEFAULT_FOOTER } from "@/lib/siteFooter";

export default function Footer() {
  const { locale } = useI18n();
  const [footerData, setFooterData] = useState(DEFAULT_FOOTER);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // `select('*')`: список колонок с *_ru/*_en ломал весь запрос на базах,
        // где миграция переводов ещё не применена, и подвал навсегда оставался
        // дефолтным — правки из админки не было видно.
        const { data } = await supabase
          .from("site_content")
          .select("*")
          .eq("id", 1)
          .maybeSingle();
        if (!cancelled) setFooterData(footerFromContent(data as Record<string, unknown> | null, locale));
      } catch {
        // fallback на дефолт
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [locale]);

  if (!loaded) return null;
  return <SiteFooter {...footerData} />;
}
