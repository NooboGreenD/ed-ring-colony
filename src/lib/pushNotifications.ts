import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing env vars: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key);
}

function ensureVapid() {
  const vapidPublic = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:admin@ed-ring-colony.vercel.app";
  if (vapidPublic && vapidPrivate) {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  }
  return { vapidPublic, vapidPrivate };
}

// ============================================================
// Универсальная отправка push одному пользователю
// ============================================================
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  clickUrl: string,
  tag?: string
) {
  const { vapidPublic, vapidPrivate } = ensureVapid();
  if (!vapidPublic || !vapidPrivate) {
    console.warn("[push] VAPID keys not configured, skipping push");
    return;
  }

  const { data: pushSubs } = await getSupabase()
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (!pushSubs || pushSubs.length === 0) return;

  const payload = JSON.stringify({
    title,
    body,
    tag: tag || "default",
    url: clickUrl,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    requireInteraction: false,
  });

  const results = await Promise.allSettled(
    pushSubs.map((sub) =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload
      )
    )
  );

  const invalidEndpoints: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const err = result.reason as any;
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        invalidEndpoints.push(pushSubs[i].endpoint);
      }
    }
  });

  if (invalidEndpoints.length > 0) {
    await getSupabase().from("push_subscriptions").delete().in("endpoint", invalidEndpoints);
  }
}

// ============================================================
// Отправка push нескольким пользователям
// ============================================================
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  clickUrl: string,
  tag?: string
) {
  const { vapidPublic, vapidPrivate } = ensureVapid();
  if (!vapidPublic || !vapidPrivate) return;
  if (!userIds.length) return;

  const { data: pushSubs } = await getSupabase()
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth, user_id")
    .in("user_id", userIds);

  if (!pushSubs || pushSubs.length === 0) return;

  const payload = JSON.stringify({
    title,
    body,
    tag: tag || "default",
    url: clickUrl,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    requireInteraction: false,
  });

  const results = await Promise.allSettled(
    pushSubs.map((sub) =>
      webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload
      )
    )
  );

  const invalidEndpoints: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const err = result.reason as any;
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        invalidEndpoints.push(pushSubs[i].endpoint);
      }
    }
  });

  if (invalidEndpoints.length > 0) {
    await getSupabase().from("push_subscriptions").delete().in("endpoint", invalidEndpoints);
  }
}

// ============================================================
// Отправка push подписчикам темы форума
// ============================================================
export async function sendPushToThreadSubscribers(
  threadId: number,
  excludeUserId: string,
  title: string,
  body: string,
  clickUrl: string
) {
  const { vapidPublic, vapidPrivate } = ensureVapid();
  if (!vapidPublic || !vapidPrivate) return;

  const { data: subs } = await getSupabase()
    .from("forum_subscriptions")
    .select("user_id")
    .eq("thread_id", threadId)
    .neq("user_id", excludeUserId);

  if (!subs || subs.length === 0) return;

  const userIds = subs.map((s) => s.user_id);
  await sendPushToUsers(userIds, title, body, clickUrl, `forum-thread-${threadId}`);
}

// ============================================================
// Отправка push участникам проекта
// ============================================================
export async function sendPushToProjectMembers(
  projectId: number,
  excludeUserId: string | null,
  title: string,
  body: string,
  clickUrl: string,
  tag?: string
) {
  const { data: members } = await getSupabase()
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);

  if (!members?.length) return;

  const userIds = members
    .map((m) => m.user_id)
    .filter((id) => id !== excludeUserId);

  await sendPushToUsers(userIds, title, body, clickUrl, tag || `project-${projectId}`);
}

// ============================================================
// Отправка push участникам эскадрильи
// ============================================================
export async function sendPushToSquadronMembers(
  squadronId: number,
  excludeUserId: string | null,
  title: string,
  body: string,
  clickUrl: string,
  tag?: string
) {
  const { data: members } = await getSupabase()
    .from("squadron_members")
    .select("user_id")
    .eq("squadron_id", squadronId);

  if (!members?.length) return;

  const userIds = members
    .map((m) => m.user_id)
    .filter((id) => id !== excludeUserId);

  await sendPushToUsers(userIds, title, body, clickUrl, tag || `squadron-${squadronId}`);
}
