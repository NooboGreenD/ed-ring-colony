import { createServerClient } from "@supabase/ssr";
import { createClient as createJsClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

function assertEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function getSupabaseUrl() {
  return assertEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

function getSupabaseConfig() {
  return {
    url: getSupabaseUrl(),
    key: assertEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };
}

export function createClient() {
  const cookieStore = cookies();
  const { url, key } = getSupabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: any }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Route handlers and Server Components cannot always write cookies.
        }
      },
    },
  });
}

export function createRouteClient(request: NextRequest) {
  const { url, key } = getSupabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll() {
        // This helper is read-only. Middleware refreshes browser auth cookies.
      },
    },
  });
}

export function createServiceClient() {
  const url = getSupabaseUrl();

  return createJsClient(
    url,
    assertEnv("SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, cache: "no-store" }),
      },
    },
  );
}

function bearerToken(authorization: string | null): string | null {
  if (!authorization?.toLowerCase().startsWith("bearer ")) return null;

  const token = authorization.slice(7).trim();
  return token || null;
}

function createBearerClient(url: string, key: string, accessToken: string) {
  return createJsClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    // Keep the bearer token on PostgREST requests, but do not configure the
    // Supabase client's accessToken option. That option creates a token-only
    // client and makes auth.getUser() throw; request authentication still
    // needs getUser(token) to verify the caller before applying RLS queries.
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function requestCookies(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";

  return cookieHeader
    .split(";")
    .map((part) => {
      const separator = part.indexOf("=");
      if (separator < 1) return null;

      const name = part.slice(0, separator).trim();
      const encodedValue = part.slice(separator + 1).trim();
      if (!name) return null;

      try {
        return { name, value: decodeURIComponent(encodedValue) };
      } catch {
        // A malformed unrelated cookie must not prevent auth from reading the
        // Supabase cookies that follow it.
        return { name, value: encodedValue };
      }
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

function createRequestCookieClient(request: Request, url: string, key: string) {
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return requestCookies(request);
      },
      setAll() {
        // API handlers only need to validate the cookie session here. Browser
        // middleware performs refreshes and sends replacement cookies back.
      },
    },
  });
}

export async function createUserClient(request: Request) {
  const { url, key } = getSupabaseConfig();
  const token = bearerToken(request.headers.get("authorization"));

  return token
    ? createBearerClient(url, key, token)
    : createJsClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
}

export { createClient as createServerClient };

/**
 * Authenticate API requests from either an explicit Bearer token or the
 * standard Supabase SSR cookie session. The returned client is bound to the
 * verified user token so its database calls retain the user's RLS context.
 */
export async function authFromRequest(request: Request) {
  const { url, key } = getSupabaseConfig();
  const token = bearerToken(request.headers.get("authorization"));

  if (token) {
    const supabase = createBearerClient(url, key, token);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    return { user: error ? null : user, supabase };
  }

  const supabase = createRequestCookieClient(request, url, key);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  return { user: error ? null : user, supabase };
}
