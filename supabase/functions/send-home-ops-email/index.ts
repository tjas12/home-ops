import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const from = Deno.env.get("HOME_OPS_FROM_EMAIL");
    if (!resendKey || !from) throw new Error("Email secrets are not configured.");

    const authorization = request.headers.get("Authorization");
    if (!authorization) throw new Error("Authentication required.");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error("Authentication required.");

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const { data: profile, error: profileError } = await admin
      .from("users")
      .select("id, email, household_id")
      .eq("id", authData.user.id)
      .single();
    if (profileError || !profile) throw new Error("Home Ops profile required.");

    const { data: membership } = await admin
      .from("household_members")
      .select("household_id")
      .eq("user_id", profile.id)
      .limit(1)
      .maybeSingle();
    const householdId = profile.household_id || membership?.household_id;
    if (!householdId) throw new Error("Join or create a household before sending email.");

    const body = await request.json();
    const recipient = body.to || profile.email;
    const { data: memberships } = await admin
      .from("household_members")
      .select("user_id")
      .eq("household_id", householdId);
    const memberIds = (memberships || []).map((member) => member.user_id);
    const { data: allowedRecipient } = memberIds.length
      ? await admin
          .from("users")
          .select("id")
          .in("id", memberIds)
          .eq("email", recipient.toLowerCase())
          .maybeSingle()
      : { data: null };
    if (!allowedRecipient) throw new Error("Recipient is not a member of this household.");

    const notificationId = crypto.randomUUID();
    await admin.from("notifications").insert({
      id: notificationId,
      household_id: householdId,
      user_id: profile.id,
      type: body.test ? "test_email" : "manual_email",
      title: body.subject,
      message: body.text,
      recipient,
      delivery_method: "email",
      status: "pending",
      scheduled_for: new Date().toISOString(),
    });

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: body.subject,
        text: body.text,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      await admin.from("notifications").update({
        status: "failed",
        error_message: result?.message || JSON.stringify(result),
      }).eq("id", notificationId);
      throw new Error(result?.message || "Resend rejected the email.");
    }

    await admin.from("notifications").update({
      status: "sent",
      sent_at: new Date().toISOString(),
      error_message: null,
    }).eq("id", notificationId);

    return new Response(JSON.stringify({ ok: true, id: result.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});