"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import Link from "next/link";

export default function MessagesPage() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.auth.getUser();
      let u = data.user;
      if (u && !(u.identities ?? []).length) {
        const { data: sess } = await supabase.auth.getSession();
        u = sess.session?.user ?? u;
      }
      setUser(u);
    };
    load();
  }, []);

  if (!user)
    return (
      <div>
        <p>
          Сначала войдите на странице <a href="/login" style={{ color: "#e67e22" }}>/login</a>
        </p>
      </div>
    );

  return (
    <div>
      <h2>Личные сообщения</h2>
      <div style={{ textAlign: "center", padding: "40px 20px", color: "#9ca3af" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>💬</div>
        <p>Личные сообщения теперь доступны только друзьям.</p>
        <p style={{ marginTop: 12 }}>
          Перейдите в раздел{" "}
          <Link href="/account/friends" style={{ color: "#e67e22" }}>Друзья</Link>
          , чтобы найти пилотов и начать переписку.
        </p>
      </div>
    </div>
  );
}
