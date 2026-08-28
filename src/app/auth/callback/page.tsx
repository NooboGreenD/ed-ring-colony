'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { oauthErrorMessage } from '@/lib/discordOAuth';
import { supabase } from '@/lib/supabaseClient';

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState('');

  useEffect(() => {
    const run = async () => {
      // detectSessionInUrl: true automatically exchanges code for session
      // Give it a moment to process the URL
      await new Promise((r) => setTimeout(r, 600));

      const { data: { session }, error: sessionError } = await supabase.auth.getSession();

      if (sessionError) {
        setError(oauthErrorMessage(sessionError.message));
        return;
      }

      if (session) {
        // Ensure profile exists
        try {
          await fetch('/api/auth/ensure-profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: session.user.id, email: session.user.email }),
          });
        } catch (e) {
          console.error('[AuthCallback] ensure-profile error:', e);
        }

        router.replace('/account');
        router.refresh();
        return;
      }

      // Check for OAuth error in URL
      const url = new URL(window.location.href);
      const desc = url.searchParams.get('error_description') || url.searchParams.get('error') || '';
      if (desc) {
        setError(oauthErrorMessage(desc.replace(/\+/g, ' ')));
        return;
      }

      setError('Не получен код авторизации от Discord. Попробуйте привязать снова.');
    };

    run();
  }, [router]);

  if (error) {
    return (
      <main className="card auth-card">
        <div className="kicker">Discord</div>
        <h1>Привязка не выполнена</h1>
        <p className="auth-error">{error}</p>
        <a href="/account" className="btn btn-cyan">
          В кабинет
        </a>
      </main>
    );
  }

  return (
    <main className="card auth-card">
      <p>Завершение входа через Discord…</p>
    </main>
  );
}
