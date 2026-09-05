"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import FriendsPanel from "@/components/FriendsPanel";
import { avatarFromUser, nickFromUser } from "@/lib/authProfile";

export default function FriendsPage() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.auth.getUser();
      let u = data.user;
      if (!u) {
        const { data: sess } = await supabase.auth.getSession();
        u = sess.session?.user ?? null;
      } else if (!(u.identities ?? []).length) {
        const { data: sess } = await supabase.auth.getSession();
        u = sess.session?.user ?? u;
      }
      setUser(u);
      if (u) {
        const { data: p } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", u.id)
          .maybeSingle();
        setProfile(p);
      }
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => load());
    return () => sub.subscription.unsubscribe();
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
      <h2>Друзья</h2>
      <FriendsPanel
        userId={user.id}
        myName={nickFromUser(user, profile)}
        myAvatar={avatarFromUser(user, profile)}
      />
    </div>
  );
}
