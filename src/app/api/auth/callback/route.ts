import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  if (error || errorDescription) {
    const msg = errorDescription || error || "Unknown OAuth error";
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(msg)}`, 302);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`, 302);
  }

  const cookieHeader = request.headers.get("cookie") || "";
  const response = NextResponse.redirect(`${origin}/account`, 302);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
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
                return { name, value: encodedValue };
              }
            })
            .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
        },
        setAll(cookiesToSet: { name: string; value: string; options: any }[]) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const { data, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);

  if (sessionError) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(sessionError.message)}`,
      302,
    );
  }

  const session = data.session;
  if (session) {
    // exchangeCodeForSession above writes the normal Supabase SSR cookies onto
    // this redirect response. The browser client reads the same session for
    // both OAuth and email/password logins; no duplicate JS-readable token
    // cookie is needed.
    response.cookies.delete("sb-session");

    try {
      const profileResponse = await fetch(`${origin}/api/auth/ensure-profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ id: session.user.id, email: session.user.email }),
      });

      if (!profileResponse.ok) {
        console.error("[Auth Callback] ensure-profile failed:", profileResponse.status);
      }
    } catch (profileError) {
      console.error("[Auth Callback] ensure-profile error:", profileError);
    }
  }

  return response;
}
