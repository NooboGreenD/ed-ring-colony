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
    }
  );
}

// Backward compatibility alias
export { createClient as createServerClient };
