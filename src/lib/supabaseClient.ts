import { createBrowserClient } from "@supabase/ssr";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createBrowserClient(url, key);

export function createSupabaseClient() {
  return supabase;
}

export function getAuthenticatedSupabase() {
  return supabase;
}

export async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token || null;
}

export function getAuthHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem('sb-sgukfplhxdhmkqponwft-auth-token');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const token = Array.isArray(parsed) ? parsed[0] : parsed?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const authHeaders = getAuthHeaders();
  const headers = new Headers();
  if (init?.headers) {
    const existing = new Headers(init.headers);
    existing.forEach((v, k) => headers.set(k, v));
  }
  Object.entries(authHeaders).forEach(([k, v]) => headers.set(k, v));
  return fetch(input, { ...init, headers, credentials: 'include' });
}
