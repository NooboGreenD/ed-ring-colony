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
        setAll(cookiesToSet: { name: string; value: string; options: any }[]) {
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

  // A browser can still reach /login with an active email/password session.
  // In that situation Discord is an additional identity for the same account,
  // not an instruction to create/sign into a second account. Never merge a
  // different account solely because Discord returns a matching email.
  const { data: { user } } = await supabase.auth.getUser();
  const shouldLinkIdentity = mode === 'link' || Boolean(user);

  console.log('[ServerAction] Discord OAuth mode:', shouldLinkIdentity ? 'link' : 'login');

  if (shouldLinkIdentity) {
    const { data, error } = await supabase.auth.linkIdentity({ provider: 'discord', options });
    if (error) {
      console.error('[ServerAction] linkIdentity error:', error.message);
      throw new Error(error.message);
    }
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
