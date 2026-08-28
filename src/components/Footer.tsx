"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import SiteFooter from "@/components/SiteFooter";
import { footerFromContent, DEFAULT_FOOTER } from "@/lib/siteFooter";

export default function Footer() {
  const [footerData, setFooterData] = useState(DEFAULT_FOOTER);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase
          .from("site_content")
          .select("footer_copyright, footer_discord, footer_edsm, footer_inara")
          .eq("id", 1)
          .maybeSingle();
        setFooterData(footerFromContent(data));
      } catch {
        // fallback на дефолт
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  if (!loaded) return null;
  return <SiteFooter {...footerData} />;
}
