import { createBrowserClient } from "@supabase/ssr";
import { getPublicSupabaseUrl, supabaseCookieOptions } from '@/lib/supabaseUrl';

const url = getPublicSupabaseUrl();
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.dummy";

// One browser client owns the Supabase SSR cookie session for the whole app.
// The explicit name keeps sessions valid when the public endpoint is moved
// behind the site-origin gateway while server code talks to Kong directly.
export const supabase = createBrowserClient(url, key, {
  auth: { detectSessionInUrl: false },
  cookieOptions: supabaseCookieOptions(),
});

export function createSupabaseClient() {
  return supabase;
}

export function getAuthenticatedSupabase() {
  return supabase;
}

export async function getAccessToken(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  return session?.access_token ?? null;
}

/**
 * Resolve the active user through the Supabase session instead of reading a
 * project-specific storage key. Falling back to the session user keeps the UI
 * usable during a transient getUser network failure, while a missing session
 * is always treated as signed out.
 */
export async function getCurrentUser() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) return null;

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  return user ?? (error ? session.user : null);
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Fetch an app endpoint with the current Supabase access token. Cookie
 * credentials are retained as a fallback for routes rendered around an SSR
 * session, but callers no longer depend on a hard-coded localStorage key.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const token = await getAccessToken();

  // Allow an explicit caller-provided Authorization header (for example, an
  // integration token) to take precedence.
  if (token && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  return fetch(input, {
    ...init,
    headers,
    credentials: init?.credentials ?? "include",
  });
}
