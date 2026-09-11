import { NextRequest, NextResponse } from "next/server";
import { getSupportRequestContext } from "@/lib/supportTickets";

export const dynamic = "force-dynamic";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { ...init, headers });
}

export async function POST(req: NextRequest) {
  try {
    const context = await getSupportRequestContext(req);
    if (!context.user || !context.db) {
      return response({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const candidate = formData.get("file");
    const ticketId = String(formData.get("ticket_id") ?? "").trim();
    if (!(candidate instanceof File) || !ticketId) {
      return response({ error: "file and ticket_id required" }, { status: 400 });
    }
    if (!UUID_PATTERN.test(ticketId)) {
      return response({ error: "Invalid ticket id" }, { status: 400 });
    }
    if (!ALLOWED_TYPES.has(candidate.type)) {
      return response(
        {
          error:
            "File type not allowed. Allowed: jpg, png, gif, webp, pdf, txt",
        },
        { status: 400 },
      );
    }
    if (candidate.size <= 0 || candidate.size > MAX_FILE_SIZE) {
      return response({ error: "File too large (max 5 MB)" }, { status: 400 });
    }

    // Service-role access bypasses RLS, so verify ticket ownership explicitly
    // before using it for the storage path or attachment record.
    const { data: ticket, error: ticketError } = await context.db
      .from("support_tickets")
      .select("user_id")
      .eq("id", ticketId)
      .maybeSingle();
    if (ticketError) {
      console.error("[support/upload POST] Ticket query failed:", ticketError.message);
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

    const extension = candidate.name.split(".").pop()?.toLowerCase() || "bin";
    const path = `tickets/${ticketId}/${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}.${extension}`;
    const buffer = Buffer.from(await candidate.arrayBuffer());
    const storage = context.db.storage.from("support-attachments");
    const { error: uploadError } = await storage.upload(path, buffer, {
      contentType: candidate.type,
      upsert: false,
    });
    if (uploadError) {
      console.error("[support/upload POST] Storage upload failed:", uploadError.message);
      return response({ error: "Could not upload attachment" }, { status: 500 });
    }

    const { data: urlData } = storage.getPublicUrl(path);
    const { data: attachment, error: attachmentError } = await context.db
      .from("support_attachments")
      .insert({
        ticket_id: ticketId,
        file_name: candidate.name.slice(0, 255),
        file_type: candidate.type,
        file_size: candidate.size,
        storage_path: path,
        public_url: urlData.publicUrl,
        uploaded_by: context.user.id,
      })
      .select("*")
      .single();
    if (attachmentError || !attachment) {
      // Avoid accumulating private/orphaned storage objects when the metadata
      // insert is rejected by a database constraint or RLS policy.
      const { error: removeError } = await storage.remove([path]);
      if (removeError) {
        console.warn(
          "[support/upload POST] Could not remove orphaned upload:",
          removeError.message,
        );
      }
      console.error(
        "[support/upload POST] Attachment insert failed:",
        attachmentError?.message,
      );
      return response(
        { error: "Could not save attachment" },
        { status: 500 },
      );
    }

    return response({ attachment }, { status: 201 });
  } catch (error) {
    console.error("[support/upload POST] Unexpected error:", error);
    return response({ error: "Upload failed" }, { status: 500 });
  }
}
