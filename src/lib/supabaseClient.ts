import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function createSupabaseClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'sb-sgukfplhxdhmkqponwft-auth-token',
      },
    }
  );
}

// Export a singleton for backward compatibility, but it may be stale (created during SSR)
export const supabase = createSupabaseClient();

// Get access token from localStorage (client-side only)
// Supabase v2 stores session as JSON string: {"access_token":"...","refresh_token":"..."}
// But sometimes it stores just the access_token string directly
export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem('sb-sgukfplhxdhmkqponwft-auth-token');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    // Format 1: {"access_token":"...","refresh_token":"..."}
    if (parsed && typeof parsed === 'object' && parsed.access_token) {
      return parsed.access_token;
    }
    // Format 2: just the token string
    if (typeof parsed === 'string' && parsed.startsWith('eyJ')) {
      return parsed;
    }
    return null;
  } catch {
    // Not JSON, maybe raw token string
    if (raw.startsWith('eyJ')) return raw;
    return null;
  }
}

// Build auth headers for fetch requests
export function getAuthHeaders(): Record<string, string> {
  const token = getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Fetch with automatic Authorization header from localStorage
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const authHeaders = getAuthHeaders();
  const headers: Record<string, string> = {
    ...authHeaders,
    ...(options.headers as Record<string, string> || {}),
  };
  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });
}

// Create a fresh authenticated Supabase client (for Realtime, etc.)
export async function getAuthenticatedSupabase(): Promise<SupabaseClient> {
  const client = createSupabaseClient();
  const token = getAccessToken();
  if (token) {
    await client.auth.setSession({ access_token: token, refresh_token: token });
  }
  return client;
}
