import { NextRequest, NextResponse } from "next/server";
import {
  getSupportRequestContext,
  loadSupportProfiles,
} from "@/lib/supportTickets";

export const dynamic = "force-dynamic";

const TICKET_STATUSES = new Set([
  "open",
  "in_progress",
  "waiting_user",
  "resolved",
  "closed",
]);
const TICKET_CATEGORIES = new Set([
  "bug",
  "feature_request",
  "account_issue",
  "other",
]);
const TICKET_PRIORITIES = new Set(["low", "normal", "high", "critical"]);

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

function boundedInteger(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function publicProfile(
  profile: { cmdr_name: string | null; avatar_url: string | null } | undefined,
) {
  return profile
    ? { cmdr_name: profile.cmdr_name, avatar_url: profile.avatar_url }
    : null;
}

export async function GET(req: NextRequest) {
  try {
    const context = await getSupportRequestContext(req);
    if (!context.user || !context.db) {
      return response({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(req.url);
    const requestedStatus = url.searchParams.get("status")?.trim() || null;
    if (requestedStatus && !TICKET_STATUSES.has(requestedStatus)) {
      return response({ error: "Invalid ticket status" }, { status: 400 });
    }
    const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, 100);
    const offset = boundedInteger(
      url.searchParams.get("offset"),
      0,
      0,
      100_000,
    );

    // An exact count makes PostgREST run an additional full count query. The
    // client does not consume a cross-page total, and this inexpensive list
    // endpoint must remain available while the tickets table grows.
    let query = context.db
      .from("support_tickets")
      .select("*");

    // Service-role access intentionally bypasses RLS for reliable staff
    // listing, so enforce the owner restriction in the route for everyone
    // who is not an approved support role.
    if (!context.isStaff) {
      query = query.eq("user_id", context.user.id);
    }
    if (requestedStatus) {
      query = query.eq("status", requestedStatus);
    }

    const {
      data: ticketRows,
      error,
    } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) {
      console.error(
        "[support/tickets GET] Ticket query failed:",
        error.message,
      );
      return response(
        { error: "Could not load support tickets" },
        { status: 500 },
      );
    }

    // Do not use `profiles!support_tickets_*_fkey` here. Those FKs reference
    // auth.users, so PostgREST cannot reliably infer a public.profiles join.
    const profiles = await loadSupportProfiles(
      context.db,
      (ticketRows || []).flatMap((ticket: any) => [
        ticket.user_id,
        ticket.assigned_to,
      ]),
    );
    const tickets = (ticketRows || []).map((ticket: any) => ({
      ...ticket,
      user: publicProfile(profiles.get(ticket.user_id)),
      assigned: publicProfile(profiles.get(ticket.assigned_to)),
    }));

    return response({ tickets, total: tickets.length });
  } catch (error) {
    console.error("[support/tickets GET] Unexpected error:", error);
    return response(
      { error: "Could not load support tickets" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const context = await getSupportRequestContext(req);
    if (!context.user || !context.db) {
      return response({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return response({ error: "Invalid JSON body" }, { status: 400 });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const category =
      typeof body.category === "string" ? body.category : "other";
    const priority =
      typeof body.priority === "string" ? body.priority : "normal";
    const pageUrl =
      typeof body.page_url === "string" ? body.page_url.trim() : "";

    if (!title || !content) {
      return response({ error: "title and content required" }, { status: 400 });
    }
    if (
      title.length > 300 ||
      content.length > 20_000 ||
      pageUrl.length > 2_000
    ) {
      return response({ error: "Ticket fields are too long" }, { status: 400 });
    }
    if (!TICKET_CATEGORIES.has(category) || !TICKET_PRIORITIES.has(priority)) {
      return response(
        { error: "Invalid category or priority" },
        { status: 400 },
      );
    }

    const { data: ticket, error: ticketError } = await context.db
      .from("support_tickets")
      .insert({
        user_id: context.user.id,
        title,
        category,
        priority,
        page_url: pageUrl || null,
        status: "open",
      })
      .select("*")
      .single();
    if (ticketError || !ticket) {
      console.error(
        "[support/tickets POST] Ticket insert failed:",
        ticketError?.message,
      );
      return response(
        { error: "Could not create support ticket" },
        { status: 500 },
      );
    }

    const { error: messageError } = await context.db
      .from("support_messages")
      .insert({
        ticket_id: ticket.id,
        sender_id: context.user.id,
        content,
        is_internal: false,
      });
    if (messageError) {
      // The ticket was committed before the initial-message insert. Preserve
      // that successful result instead of encouraging the user to retry and
      // create duplicates; callers can show the warning if needed.
      console.error(
        "[support/tickets POST] Initial message insert failed:",
        messageError.message,
      );
      return response(
        {
          ticket,
          warning: "Ticket was created but its initial message could not be saved",
        },
        { status: 201 },
      );
    }

    return response({ ticket }, { status: 201 });
  } catch (error) {
    console.error("[support/tickets POST] Unexpected error:", error);
    return response(
      { error: "Could not create support ticket" },
      { status: 500 },
    );
  }
}
