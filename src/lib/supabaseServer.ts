import { createServerClient } from "@supabase/ssr";
import { createClient as createJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function assertEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function createClient() {
  const cookieStore = cookies();
  return createServerClient(
    assertEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    assertEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Component cannot set cookies, middleware handles refresh
          }
        },
      },
    }
  );
}

// For API routes — parse cookies directly from request header
export function createRouteClient(request: Request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const parsedCookies: { name: string; value: string }[] = [];

  if (cookieHeader) {
    cookieHeader.split(';').forEach((cookie) => {
      const idx = cookie.indexOf('=');
      if (idx > 0) {
        parsedCookies.push({
          name: cookie.slice(0, idx).trim(),
          value: decodeURIComponent(cookie.slice(idx + 1).trim()),
        });
      }
    });
  }

  return createServerClient(
    assertEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    assertEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      cookies: {
        getAll() {
          return parsedCookies;
        },
        setAll() {
          // API routes don't set cookies — middleware handles refresh
        },
      },
    }
  );
}

// Service role client — bypasses RLS, use only in server API routes
export function createServiceClient() {
  return createJsClient(
    assertEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    assertEnv('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: 'no-store' }),
      },
    }
  );
}

// User client for API routes — passes Authorization header through to PostgREST
// This makes RLS work correctly because PostgREST reads JWT from the header
export async function createUserClient(request: Request) {
  const authHeader = request.headers.get('authorization') || '';
  
  const client = createJsClient(
    assertEnv('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    assertEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        headers: authHeader ? { Authorization: authHeader } : {},
      },
    }
  );
  
  // If we have a Bearer token, set it as the active session so getUser() works
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    await client.auth.setSession({ access_token: token, refresh_token: token });
  }
  
  return client;
}

// Backward compatibility alias
export { createClient as createServerClient };

// For API routes — try Authorization header first, then cookies
export async function authFromRequest(request: Request) {
  const supabase = await createUserClient(request);
  
  // createUserClient already set the session from Authorization header
  // So getUser() will work without arguments
  const { data: { user }, error } = await supabase.auth.getUser();
  if (user && !error) {
    return { user, supabase };
  }
  
  return { user: null, supabase };
}
