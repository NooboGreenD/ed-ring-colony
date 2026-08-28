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
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: 'No code provided' }, { status: 400 });
  }

  const cookieHeader = request.headers.get('cookie') || '';

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
        setAll() {
          // Server route — cookies handled via response
        },
      },
    }
  );

  const { error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

  if (sessionError) {
    console.error('[Auth Callback API] exchangeCodeForSession error:', sessionError.message);
    return NextResponse.json({ error: sessionError.message }, { status: 400 });
  }

  // Ensure profile exists
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    try {
      await fetch(`${origin}/api/auth/ensure-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: user.id, email: user.email }),
      });
    } catch (e) {
      console.error('[Auth Callback API] ensure-profile error:', e);
    }
  }

  return NextResponse.json({ ok: true });
}
