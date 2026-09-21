'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

/** UI identity only: permissions remain enforced by Supabase RLS. */
export function useRealtimeUserId(): string | null {
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      revision++;
      // Never await a Supabase call inside the auth callback (its lock is held).
      if (active) setUserId(session?.user.id ?? null);
    });
    const initialRevision = revision;
    void supabase.auth.getUser().then(({ data }) => {
      // An old request must not resurrect A's subscription after logout/login B.
      if (active && revision === initialRevision) setUserId(data.user?.id ?? null);
    }).catch(() => {
      if (active && revision === initialRevision) setUserId(null);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  return userId;
}
