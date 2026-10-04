import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type PushItem = {
  household_id: string;
  source_type: string;
  source_id: string;
  occurrence_key: string;
  title: string;
  body: string;
  assigned_to?: string | null;
  assigned_user_id?: string | null;
  url: string;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-home-ops-cron",
    },
  });
}

function centralNowParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    weekday: "long",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}:00`,
    weekday: get("weekday"),
  };
}

function minutesSinceScheduled(nowDate: string, nowTime: string, itemDate: string, itemTime: string) {
  const now = Date.parse(`${nowDate}T${nowTime}Z`);
  const due = Date.parse(`${itemDate}T${itemTime}Z`);
  return Math.floor((now - due) / 60000);
}

function inDueWindow(nowDate: string, nowTime: string, itemDate: string, itemTime?: string | null) {
  if (!itemTime) return false;
  const delta = minutesSinceScheduled(nowDate, nowTime, itemDate, itemTime);
  return delta >= 0 && delta <= 5;
}

async function loadConfig() {
  const { data, error } = await admin
    .from("push_config")
    .select("public_key,private_key,subject,cron_secret")
    .eq("id", "default")
    .single();
  if (error || !data) throw error || new Error("Push config missing");
  webpush.setVapidDetails(data.subject, data.public_key, data.private_key);
  return data;
}

async function authenticateUser(req: Request) {
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

async function sendToSubscription(sub: any, payload: any) {
  try {
    await webpush.sendNotification({
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }, JSON.stringify(payload), { TTL: 60 * 60 });
    return { ok: true };
  } catch (error) {
    const statusCode = Number((error as any)?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      await admin.from("push_subscriptions").delete().eq("id", sub.id);
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function userPushEnabled(userId: string) {
  const { data } = await admin
    .from("user_notification_settings")
    .select("push_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.push_enabled !== false;
}

async function sendForUser(userId: string, householdId: string, title: string, body: string, url: string, notificationId?: string, sourceId?: string) {
  if (!(await userPushEnabled(userId))) return { attempted: 0, sent: 0, failed: 0 };
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("household_id", householdId);
  if (error) throw error;
  if (!subs?.length) return { attempted: 0, sent: 0, failed: 0 };

  const { count, error: badgeError } = await admin.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null).eq("status", "sent").lte("scheduled_for", new Date().toISOString());
  if (badgeError) throw badgeError;

  let sent = 0, failed = 0;
  for (const sub of subs) {
    const result = await sendToSubscription(sub, {
      title,
      body,
      url,
      icon: "./assets/icon.svg",
      badge: "./assets/icon.svg",
      notificationId,
      sourceId,
      userId,
      unreadCount: count || 0,
    });
    result.ok ? sent++ : failed++;
  }
  return { attempted: subs.length, sent, failed };
}

async function resolveTargets(householdId: string, assignedUserId?: string | null, assignedTo?: string | null) {
  const { data: memberships, error: membershipError } = await admin
    .from("household_members")
    .select("user_id")
    .eq("household_id", householdId);
  if (membershipError) throw membershipError;
  let userIds = (memberships || []).map((m) => m.user_id);
  if (assignedUserId) userIds = userIds.filter((id) => id === assignedUserId);
  if (!userIds.length) return [];

  const { data: users, error } = await admin
    .from("users")
    .select("id,role,name,email")
    .in("id", userIds);
  if (error) throw error;

  if (assignedUserId) return users || [];
  if (!assignedTo || assignedTo === "Shared") return users || [];
  return (users || []).filter((u) => u.role === assignedTo);
}

async function processItem(item: PushItem) {
  const { data: settings } = await admin
    .from("notification_settings")
    .select("push_enabled")
    .eq("household_id", item.household_id)
    .maybeSingle();
  if (settings?.push_enabled === false) return 0;

  const targets = await resolveTargets(item.household_id, item.assigned_user_id, item.assigned_to);
  let totalSent = 0;

  for (const user of targets) {
    if (!(await userPushEnabled(user.id))) continue;
    // Claim the unique occurrence before sending so overlapping cron runs cannot duplicate it.
    const { data: claim, error: claimError } = await admin.from("push_reminder_dispatches").insert({
      household_id: item.household_id, user_id: user.id, source_type: item.source_type,
      source_id: item.source_id, occurrence_key: item.occurrence_key,
    }).select("id").single();
    if (claimError?.code === "23505") continue;
    if (claimError) throw claimError;
    let notificationId: string | undefined;
    try {
      const { data: current, error: currentError } = await admin.from(`${item.source_type}s`).select("*").eq("id", item.source_id).eq("household_id", item.household_id).maybeSingle();
      if (currentError) throw currentError;
      if (!current || current.completed || current.status === "cancelled") continue;
      if (current.assigned_user_id && current.assigned_user_id !== user.id) continue;
      if (item.source_type === "task" && item.occurrence_key !== `${current.due_date}T${current.due_time}:${current.reminder_minutes}`) continue;
      if (item.source_type === "event" && item.occurrence_key !== `${current.event_date}T${current.start_time}:${current.reminder_minutes}`) continue;
      const { data: notification, error: notificationError } = await admin.from("notifications").insert({
        household_id: item.household_id,
        user_id: user.id,
        type: "reminder",
        title: item.title,
        message: item.body,
        recipient: user.email,
        related_item_type: item.source_type,
        related_item_id: item.source_id,
        scheduled_for: new Date().toISOString(),
        delivery_method: "push",
        status: "sent",
        sent_at: new Date().toISOString(),
      }).select("id,read_at").single();
      if (notificationError) throw notificationError;
      notificationId = notification.id;
      if (notification.read_at) continue;
      const result = await sendForUser(user.id, item.household_id, item.title, item.body, item.url, notificationId, item.source_id);
      totalSent += result.sent;
      if (!result.sent) {
        await admin.from("notifications").update({ status: "failed", read_at: new Date().toISOString() }).eq("id", notificationId);
        await admin.from("push_reminder_dispatches").delete().eq("id", claim.id);
      }
    } catch (error) {
      if (notificationId) await admin.from("notifications").update({ status: "failed", read_at: new Date().toISOString() }).eq("id", notificationId);
      // Retain an uncertain dispatch after a transport error to avoid duplicate delivery.
      console.error("Push dispatch failed", error);
    }
  }
  return totalSent;
}

async function processScheduled() {
  const now = centralNowParts();
  const items: PushItem[] = [];

  const [{ data: reminders, error: reminderError }, { data: dueItems, error: dueError }, { data: routines, error: routineError }] = await Promise.all([
    admin.from("reminders").select("*").eq("reminder_date", now.date).eq("completed", false),
    admin.rpc("home_ops_due_push_items"),
    admin.from("routines").select("*").eq("active", true).contains("days_of_week", [now.weekday]),
  ]);
  if (reminderError || dueError || routineError) throw reminderError || dueError || routineError;

  for (const x of reminders || []) if (inDueWindow(now.date, now.time, x.reminder_date, x.reminder_time)) {
    items.push({
      household_id: x.household_id, source_type: "reminder", source_id: x.id,
      occurrence_key: x.reminder_date, assigned_to: x.assigned_to, assigned_user_id: x.assigned_user_id,
      title: "Home Ops Reminder", body: x.title, url: "./?tab=today",
    });
  }
  for (const due of dueItems || []) {
    const x = due.item;
    items.push({
      household_id: x.household_id, source_type: due.source_type, source_id: x.id,
      occurrence_key: due.occurrence_key, assigned_to: x.assigned_to, assigned_user_id: x.assigned_user_id,
      title: due.source_type === "task" ? "Task Reminder" : "Event Reminder", body: x.title,
      url: due.source_type === "task" ? "./?tab=tasks" : "./?tab=calendar",
    });
  }
  for (const x of routines || []) if (inDueWindow(now.date, now.time, now.date, x.time)) {
    items.push({
      household_id: x.household_id, source_type: "routine", source_id: x.id,
      occurrence_key: now.date, assigned_to: x.assigned_to, assigned_user_id: x.assigned_user_id,
      title: "Routine Time", body: x.name, url: "./?tab=today",
    });
  }

  let sent = 0;
  for (const item of items) sent += await processItem(item);
  return { checked: items.length, sent, now };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-home-ops-cron",
  }});
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  try {
    const config = await loadConfig();
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode || "scheduled";

    if (mode === "test") {
      const user = await authenticateUser(req);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const { data: memberships, error: membershipError } = await admin
        .from("household_members")
        .select("household_id")
        .eq("user_id", user.id)
        .limit(1);
      if (membershipError || !memberships?.length) return json({ error: "Household membership not found" }, 404);
      const householdId = memberships[0].household_id;
      const result = await sendForUser(user.id, householdId, "Home Ops", "Push notifications are connected on this device.", "./?tab=settings");
      return json({ ok: true, ...result });
    }

    const cronSecret = req.headers.get("x-home-ops-cron") || "";
    if (!config.cron_secret || cronSecret !== config.cron_secret) return json({ error: "Unauthorized" }, 401);
    const result = await processScheduled();
    return json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
