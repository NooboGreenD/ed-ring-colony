import { NextRequest, NextResponse } from "next/server";
import { getSupportRequestContext } from "@/lib/supportTickets";

export const dynamic = "force-dynamic";

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

export async function GET(req: NextRequest) {
  try {
    const context = await getSupportRequestContext(req);

    // This is an optional staff-only badge. Preserve its historical harmless
    // response for signed-out and regular users rather than exposing ticket
    // information or failing the rest of the support page.
    if (!context.user || !context.db || !context.isStaff) {
      return response({ count: 0 });
    }

    const { count, error } = await context.db
      .from("support_tickets")
      .select("*", { count: "exact", head: true })
      .in("status", ["open", "waiting_user"]);
    if (error) {
      console.error("[support/unread GET] Ticket count failed:", error.message);
      return response(
        { error: "Could not load support ticket count" },
        { status: 500 },
      );
    }

    return response({ count: count ?? 0 });
  } catch (error) {
    console.error("[support/unread GET] Unexpected error:", error);
    return response(
      { error: "Could not load support ticket count" },
      { status: 500 },
    );
  }
}
