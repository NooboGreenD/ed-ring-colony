import { NextRequest, NextResponse } from "next/server";
import {
  getSupportRequestContext,
  loadSupportProfiles,
} from "@/lib/supportTickets";

export const dynamic = "force-dynamic";

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const context = await getSupportRequestContext(req);
    if (!context.user || !context.db) {
      return response({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const content =
      typeof body?.content === "string" ? body.content.trim() : "";
    if (!content) {
      return response({ error: "content required" }, { status: 400 });
    }
    if (content.length > 20_000) {
      return response({ error: "Message is too long" }, { status: 400 });
    }

    const id = params.id;
    const { data: ticket, error: ticketError } = await context.db
      .from("support_tickets")
      .select("user_id,status")
      .eq("id", id)
      .maybeSingle();
    if (ticketError) {
      console.error(
        "[support/messages POST] Ticket query failed:",
        ticketError.message,
      );
      return response(
        { error: "Could not load support ticket" },
        { status: 500 },
      );
    }
    if (!ticket) {
      return response({ error: "Ticket not found" }, { status: 404 });
    }
    if (!context.isStaff && ticket.user_id !== context.user.id) {
      return response({ error: "Forbidden" }, { status: 403 });
    }
    if (!context.isStaff && body?.is_internal) {
      return response(
        { error: "Cannot send internal message" },
        { status: 403 },
      );
    }

    const { data: message, error: messageError } = await context.db
      .from("support_messages")
      .insert({
        ticket_id: id,
        sender_id: context.user.id,
        content,
        is_internal: context.isStaff ? Boolean(body?.is_internal) : false,
      })
      .select("*")
      .single();
    if (messageError || !message) {
      console.error(
        "[support/messages POST] Message insert failed:",
        messageError?.message,
      );
      return response(
        { error: "Could not send ticket message" },
        { status: 500 },
      );
    }

    // A reply to a resolved/closed ticket reopens it. This uses a simple
    // table update; no PostgREST relationship inference is involved.
    if (ticket.status === "resolved" || ticket.status === "closed") {
      const { error: reopenError } = await context.db
        .from("support_tickets")
        .update({ status: "open", updated_at: new Date().toISOString() })
        .eq("id", id);
      if (reopenError) {
        console.warn(
          "[support/messages POST] Could not reopen ticket:",
          reopenError.message,
        );
      }
    }

    const profiles = await loadSupportProfiles(context.db, [context.user.id]);
    const sender = profiles.get(context.user.id);
    return response(
      {
        message: {
          ...message,
          sender: sender
            ? { cmdr_name: sender.cmdr_name, avatar_url: sender.avatar_url }
            : null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[support/messages POST] Unexpected error:", error);
    return response(
      { error: "Could not send ticket message" },
      { status: 500 },
    );
  }
}
