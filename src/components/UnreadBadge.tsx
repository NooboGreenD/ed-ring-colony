'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { useRealtimeUserId } from '@/hooks/useRealtimeUserId';

export default function UnreadBadge() {
  const userId = useRealtimeUserId();
  const [count, setCount] = useState(0);
  useEffect(() => {
    setCount(0);
    if (!userId) return;
    let active = true;
    const load = async () => {
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', userId)
        .is('read_at', null);
      if (active) setCount(count ?? 0);
    };
    void load();
    const t = setInterval(() => void load(), 20000);
    const channel = supabase
      .channel(`unread:${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'messages', filter: `recipient_id=eq.${userId}`,
      }, () => { if (active) void load(); })
      .subscribe();
    return () => {
      active = false;
      clearInterval(t);
      void supabase.removeChannel(channel);
    };
  }, [userId]);
  if (!count) return null;
  return (
    <Link href="/account/messages" className="badge">
      Сообщения: {count}
    </Link>
  );
}
