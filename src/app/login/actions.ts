'use server';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function getBaseUrl() {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  return 'https://ed-ring-colony.vercel.app';
}

export async function startDiscordOAuthAction(mode: 'login' | 'link') {
  const cookieStore = await cookies();
  
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );

  const redirectTo = `${getBaseUrl()}/api/auth/callback`;
  
  const options = {
    redirectTo,
    scopes: 'identify email' as const,
    skipBrowserRedirect: true,
  };

  console.log('[ServerAction] Discord OAuth mode:', mode, 'redirectTo:', redirectTo);

  if (mode === 'link') {
    const { data, error } = await supabase.auth.linkIdentity({ provider: 'discord', options });
    if (error) {
      console.error('[ServerAction] linkIdentity error:', error.message);
      throw new Error(error.message);
    }
    console.log('[ServerAction] linkIdentity URL:', data?.url ? 'present' : 'missing');
    return data?.url;
  }

  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'discord', options });
  if (error) {
    console.error('[ServerAction] signInWithOAuth error:', error.message);
    throw new Error(error.message);
  }
  console.log('[ServerAction] signInWithOAuth URL:', data?.url ? 'present' : 'missing');
  return data?.url;
}
