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
const TICKET_PRIORITIES = new Set(["low", "normal", "high", "critical"]);

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

function profileLabel(
  profile:
    | {
        cmdr_name: string | null;
        avatar_url: string | null;
        email?: string | null;
      }
    | undefined,
  includeEmail: boolean,
) {
  if (!profile) return null;
  return {
    cmdr_name: profile.cmdr_name,
    avatar_url: profile.avatar_url,
    ...(includeEmail ? { email: profile.email ?? null } : {}),
  };
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const context = await getSupportRequestContext(req);
    if (!context.user || !context.db) {
      return response({ error: "Unauthorized" }, { status: 401 });
    }

    const id = params.id;
    const { data: ticket, error: ticketError } = await context.db
      .from("support_tickets")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (ticketError) {
      console.error(
        "[support/ticket GET] Ticket query failed:",
        ticketError.message,
      );
      return response(
        { error: "Could not load support ticket" },
        { status: 500 },
      );
    }
    if (!ticket) {
      return response({ error: "Not found" }, { status: 404 });
    }
    if (!context.isStaff && ticket.user_id !== context.user.id) {
      return response({ error: "Forbidden" }, { status: 403 });
    }

    let messageQuery = context.db
      .from("support_messages")
      .select("*")
      .eq("ticket_id", id)
      .order("created_at", { ascending: true });
    if (!context.isStaff) {
      messageQuery = messageQuery.eq("is_internal", false);
    }

    const [
      { data: messageRows, error: messagesError },
      { data: attachmentRows, error: attachmentsError },
    ] = await Promise.all([
      messageQuery,
      context.db
        .from("support_attachments")
        .select("*")
        .eq("ticket_id", id)
        .order("created_at", { ascending: true }),
    ]);
    if (messagesError) {
      console.error(
        "[support/ticket GET] Messages query failed:",
        messagesError.message,
      );
      return response(
        { error: "Could not load ticket messages" },
        { status: 500 },
      );
    }
    if (attachmentsError) {
      console.error(
        "[support/ticket GET] Attachments query failed:",
        attachmentsError.message,
      );
      return response(
        { error: "Could not load ticket attachments" },
        { status: 500 },
      );
    }

    const profiles = await loadSupportProfiles(
      context.db,
      [
        ticket.user_id,
        ticket.assigned_to,
        ...(messageRows || []).map((message: any) => message.sender_id),
      ],
      context.isStaff,
    );
    const reporter = profiles.get(ticket.user_id);
    const enrichedTicket = {
      ...ticket,
      user: profileLabel(reporter, context.isStaff),
      assigned: profileLabel(profiles.get(ticket.assigned_to), false),
    };
    const messages = (messageRows || []).map((message: any) => ({
      ...message,
      sender: profileLabel(profiles.get(message.sender_id), false),
    }));

    return response({
      ticket: enrichedTicket,
      messages,
      attachments: attachmentRows || [],
    });
  } catch (error) {
    console.error("[support/ticket GET] Unexpected error:", error);
    return response(
      { error: "Could not load support ticket" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const context = await getSupportRequestContext(req);
    if (!context.user || !context.db) {
      return response({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return response({ error: "Invalid JSON body" }, { status: 400 });
    }

    const updates: Record<string, string | null> = {};
    if (context.isStaff) {
      if (body.status !== undefined) {
        if (
          typeof body.status !== "string" ||
          !TICKET_STATUSES.has(body.status)
        ) {
          return response({ error: "Invalid ticket status" }, { status: 400 });
        }
        updates.status = body.status;
        if (body.status === "resolved") {
          updates.resolved_at = new Date().toISOString();
        }
        if (body.status === "closed") {
          updates.closed_at = new Date().toISOString();
        }
      }
      if (body.priority !== undefined) {
        if (
          typeof body.priority !== "string" ||
          !TICKET_PRIORITIES.has(body.priority)
        ) {
          return response(
            { error: "Invalid ticket priority" },
            { status: 400 },
          );
        }
        updates.priority = body.priority;
      }
      if (body.assigned_to !== undefined) {
        if (body.assigned_to !== null && typeof body.assigned_to !== "string") {
          return response({ error: "Invalid assignee" }, { status: 400 });
        }
        updates.assigned_to = body.assigned_to || null;
      }
    } else {
      // The public UI offers ticket owners a close action. Allow only that
      // narrow transition and explicitly verify ownership because the service
      // client, when present, bypasses the table's normal RLS policy.
      if (
        body.status !== "closed" ||
        Object.keys(body).some((key) => key !== "status")
      ) {
        return response({ error: "Forbidden" }, { status: 403 });
      }

      const { data: existingTicket, error: existingTicketError } =
        await context.db
          .from("support_tickets")
          .select("user_id,status")
          .eq("id", params.id)
          .maybeSingle();
      if (existingTicketError) {
        console.error(
          "[support/ticket PATCH] Ticket ownership query failed:",
          existingTicketError.message,
        );
        return response(
          { error: "Could not load support ticket" },
          { status: 500 },
        );
      }
      if (!existingTicket) {
        return response({ error: "Not found" }, { status: 404 });
      }
      if (existingTicket.user_id !== context.user.id) {
        return response({ error: "Forbidden" }, { status: 403 });
      }
      if (!["open", "waiting_user"].includes(existingTicket.status)) {
        return response(
          { error: "Only open tickets can be closed by their owner" },
          { status: 409 },
        );
      }

      updates.status = "closed";
      updates.closed_at = new Date().toISOString();
    }

    if (Object.keys(updates).length === 0) {
      return response({ error: "Nothing to update" }, { status: 400 });
    }
    updates.updated_at = new Date().toISOString();

    let updateQuery = context.db
      .from("support_tickets")
      .update(updates)
      .eq("id", params.id);
    if (!context.isStaff) {
      updateQuery = updateQuery
        .eq("user_id", context.user.id)
        .in("status", ["open", "waiting_user"]);
    }
    const { data: ticket, error: updateError } = await updateQuery
      .select("*")
      .maybeSingle();
    if (updateError) {
      console.error(
        "[support/ticket PATCH] Ticket update failed:",
        updateError.message,
      );
      return response(
        { error: "Could not update support ticket" },
        { status: 500 },
      );
    }
    if (!ticket) {
      return response({ error: "Not found" }, { status: 404 });
    }

    return response({ ticket });
  } catch (error) {
    console.error("[support/ticket PATCH] Unexpected error:", error);
    return response(
      { error: "Could not update support ticket" },
      { status: 500 },
    );
  }
}
