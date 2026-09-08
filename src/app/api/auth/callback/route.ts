import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  if (error || errorDescription) {
    const msg = errorDescription || error || 'Unknown OAuth error';
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(msg)}`, 302);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`, 302);
  }

  const cookieHeader = request.headers.get('cookie') || '';
  const response = NextResponse.redirect(`${origin}/account`, 302);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieHeader.split(';').map((c) => {
            const [name, ...rest] = c.trim().split('=');
            return { name, value: decodeURIComponent(rest.join('=') || '') };
          }).filter((c) => c.name);
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  const { data, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

  if (sessionError) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(sessionError.message)}`, 302);
  }

  if (data?.session) {
    // Pass tokens to client via non-HttpOnly cookie so createClient (localStorage) can pick them up
    response.cookies.set('sb-session', JSON.stringify({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    }), {
      path: '/',
      maxAge: 60,
      sameSite: 'lax',
      secure: true,
      httpOnly: false,
    });

    try {
      await fetch(`${origin}/api/auth/ensure-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.session.user.id, email: data.session.user.email }),
      });
    } catch (e) {
      console.error('[Auth Callback] ensure-profile error:', e);
    }
  }

  return response;
}
