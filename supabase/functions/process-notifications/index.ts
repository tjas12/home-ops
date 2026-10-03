import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (request) => {
  try {
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret || request.headers.get("x-cron-secret") !== cronSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("HOME_OPS_FROM_EMAIL");
    if (!resendKey || !from) throw new Error("Email secrets are not configured.");

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const chicagoParts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "long",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date()).map((part) => [part.type, part.value])
    );
    const localDate = `${chicagoParts.year}-${chicagoParts.month}-${chicagoParts.day}`;
    const localTime = `${chicagoParts.hour}:${chicagoParts.minute}`;
    const todayStart = new Date(`${localDate}T00:00:00-05:00`).toISOString();

    // Generate routine nudges server-side so they do not depend on an open browser.
    const { data: routines } = await admin
      .from("routines")
      .select("id, household_id, name, assigned_user_id, assigned_to, days_of_week, time, routine_items(id)")
      .eq("active", true)
      .contains("days_of_week", [chicagoParts.weekday])
      .not("time", "is", null)
      .lte("time", localTime);
    for (const routine of routines || []) {
      const itemIds = (routine.routine_items || []).map((item) => item.id);
      if (!itemIds.length) continue;
      const { count } = await admin
        .from("routine_completions")
        .select("id", { count: "exact", head: true })
        .in("routine_item_id", itemIds)
        .eq("completed_date", localDate);
      if ((count || 0) >= itemIds.length) continue;

      const { data: memberships } = await admin
        .from("household_members")
        .select("user_id")
        .eq("household_id", routine.household_id);
      const memberIds = (memberships || []).map((member) => member.user_id);
      if (!memberIds.length) continue;
      const { data: members } = await admin
        .from("users")
        .select("id, email")
        .in("id", memberIds);
      for (const member of members || []) {
        if (routine.assigned_user_id && routine.assigned_user_id !== member.id) continue;
        const { data: existing } = await admin
          .from("notifications")
          .select("id")
          .eq("type", "routine_incomplete")
          .eq("related_item_id", routine.id)
          .eq("user_id", member.id)
          .gte("created_at", todayStart)
          .maybeSingle();
        if (!existing) {
          await admin.from("notifications").insert({
            household_id: routine.household_id,
            user_id: member.id,
            type: "routine_incomplete",
            title: `Routine waiting: ${routine.name}`,
            message: `${routine.name} still has unchecked items today.`,
            recipient: member.email,
            related_item_type: "routines",
            related_item_id: routine.id,
            scheduled_for: new Date().toISOString(),
            delivery_method: "email",
          });
        }
      }
    }

    // Queue one Weekly Reset nudge per household each Sunday.
    if (chicagoParts.weekday === "Sunday") {
      const { data: memberships } = await admin.from("household_members").select("household_id, user_id");
      const userIds = [...new Set((memberships || []).map((member) => member.user_id))];
      const { data: users } = userIds.length
        ? await admin.from("users").select("id, email").in("id", userIds)
        : { data: [] };
      for (const membership of memberships || []) {
        const member = (users || []).find((user) => user.id === membership.user_id);
        if (!member) continue;
        const { data: existing } = await admin
          .from("notifications")
          .select("id")
          .eq("type", "weekly_reset")
          .eq("user_id", membership.user_id)
          .gte("created_at", todayStart)
          .maybeSingle();
        if (!existing) {
          await admin.from("notifications").insert({
            household_id: membership.household_id,
            user_id: membership.user_id,
            type: "weekly_reset",
            title: "Time for the Weekly Reset",
            message: "Open Home Ops and make a simple plan for the week ahead.",
            recipient: member.email,
            scheduled_for: new Date().toISOString(),
            delivery_method: "email",
          });
        }
      }
    }

    const { data: pending, error } = await admin
      .from("notifications")
      .select("*")
      .eq("status", "pending")
      .eq("delivery_method", "email")
      .lte("scheduled_for", new Date().toISOString())
      .limit(100);
    if (error) throw error;

    const results = [];
    for (const notification of pending || []) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [notification.recipient],
            subject: notification.title,
            text: notification.message,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.message || JSON.stringify(result));

        await admin.from("notifications").update({
          status: "sent",
          sent_at: new Date().toISOString(),
          error_message: null,
        }).eq("id", notification.id);
        results.push({ id: notification.id, status: "sent" });
      } catch (sendError) {
        console.error(sendError);
        await admin.from("notifications").update({
          status: "failed",
          error_message: sendError.message,
        }).eq("id", notification.id);
        results.push({ id: notification.id, status: "failed" });
      }
    }

    return Response.json({ processed: results.length, results });
  } catch (error) {
    console.error(error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});