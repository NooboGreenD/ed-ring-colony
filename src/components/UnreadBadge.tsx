'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
export default function UnreadBadge() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const load = async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        setCount(0);
        return;
      }
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', u.user.id)
        .is('read_at', null);
      setCount(count ?? 0);
    };
    load();
    const t = setInterval(load, 20000);
    const channel = supabase
      .channel('unread')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => load())
      .subscribe();
    return () => {
      clearInterval(t);
      supabase.removeChannel(channel);
    };
  }, []);
  if (!count) return null;
  return (
    <Link href="/account" className="badge">
      Сообщения: {count}
    </Link>
  );
}