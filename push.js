import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const config = window.HOME_OPS_CONFIG || {};
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

function toast(message, type = "success") {
  const root = document.querySelector("#toast-root");
  if (!root) return;
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  root.appendChild(item);
  setTimeout(() => item.remove(), 3500);
}

function pushSupported() {
  return "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

function permissionLabel(subscription) {
  if (!pushSupported()) return "Not supported";
  if (Notification.permission === "denied") return "Blocked";
  if (Notification.permission !== "granted") return "Not enabled";
  return subscription ? "Enabled on this device" : "Permission allowed";
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function getContext() {
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData?.session?.user;
  if (!user) throw new Error("Sign in to Home Ops first.");

  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("id,household_id")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) throw profileError;

  let householdId = profile?.household_id || null;
  if (!householdId) {
    const { data: membership, error: membershipError } = await supabase
      .from("household_members")
      .select("household_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    if (membershipError) throw membershipError;
    householdId = membership?.household_id || null;
  }
  if (!householdId) throw new Error("Join or create a household first.");
  return { userId: user.id, householdId };
}

async function getSubscription() {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function enablePush(button) {
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "Enabling...";
  try {
    if (!pushSupported()) {
      throw new Error("Push is not available here. On iPhone, add Home Ops to your Home Screen and open the installed app.");
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");

    const [{ data: publicKey, error: keyError }, context] = await Promise.all([
      supabase.rpc("get_push_public_key"),
      getContext(),
    ]);
    if (keyError) throw keyError;
    if (!publicKey) throw new Error("Push notification key is not configured.");

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      throw new Error("This device did not return a complete push subscription.");
    }

    const { error: subscriptionError } = await supabase
      .from("push_subscriptions")
      .upsert({
        household_id: context.householdId,
        user_id: context.userId,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString(),
      }, { onConflict: "endpoint" });
    if (subscriptionError) throw subscriptionError;

    const { error: userSettingsError } = await supabase
      .from("user_notification_settings")
      .upsert({
        user_id: context.userId,
        push_enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (userSettingsError) throw userSettingsError;

    await supabase
      .from("notification_settings")
      .upsert({
        household_id: context.householdId,
        push_enabled: true,
        updated_at: new Date().toISOString(),
      }, { onConflict: "household_id" });

    toast("Push notifications enabled on this device.");
    await refreshCard();
  } catch (error) {
    console.error("[Home Ops Push] enable failed", error);
    toast(error?.message || "Could not enable push notifications.", "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function disablePush(button) {
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "Disabling...";
  try {
    const context = await getContext();
    const subscription = await getSubscription();
    if (subscription) {
      const { error } = await supabase
        .from("push_subscriptions")
        .delete()
        .eq("endpoint", subscription.endpoint)
        .eq("user_id", context.userId);
      if (error) throw error;
      await subscription.unsubscribe();
    }

    const { error: settingsError } = await supabase
      .from("user_notification_settings")
      .upsert({
        user_id: context.userId,
        push_enabled: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (settingsError) throw settingsError;

    toast("Push notifications disabled on this device.");
    await refreshCard();
  } catch (error) {
    console.error("[Home Ops Push] disable failed", error);
    toast(error?.message || "Could not disable push notifications.", "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function testPush(button) {
  button.disabled = true;
  const oldText = button.textContent;
  button.textContent = "Sending...";
  try {
    const subscription = await getSubscription();
    if (!subscription) throw new Error("Enable push notifications on this device first.");

    const { data, error } = await supabase.functions.invoke("send-home-ops-push", {
      body: { mode: "test" },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    if (!data?.sent) throw new Error("No active push subscription was found for this device.");

    toast("Test push sent.");
  } catch (error) {
    console.error("[Home Ops Push] test failed", error);
    toast(error?.message || "Test push failed.", "error");
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
}

async function buildCard() {
  const existing = document.querySelector("#push-notifications-card");
  if (existing) return existing;

  const page = document.querySelector("#page");
  const pageTitle = document.querySelector("#page-title");
  if (!page || pageTitle?.textContent?.trim() !== "Settings") return null;

  const card = document.createElement("section");
  card.id = "push-notifications-card";
  card.className = "section card";
  card.innerHTML = `
    <h2>Push Notifications</h2>
    <p class="muted-copy">Get task, reminder, event, and routine alerts on this device even when Home Ops is not open.</p>
    <div class="switch-row"><span>Device status</span><span id="push-device-status" class="pill">Checking...</span></div>
    <div class="form-grid">
      <button id="enable-push-device" class="primary" type="button">Enable Push on This Device</button>
      <button id="test-push-device" class="secondary" type="button">Send Test Push</button>
    </div>
    <br>
    <button id="disable-push-device" class="secondary wide" type="button">Disable Push on This Device</button>
    <p class="meta">On iPhone, install Home Ops to the Home Screen first, then open the installed app and enable push here.</p>
  `;

  const notificationsHeading = [...page.querySelectorAll("h2")].find((node) => node.textContent?.trim() === "Notifications");
  const notificationsSection = notificationsHeading?.closest("section");
  if (notificationsSection) notificationsSection.before(card);
  else page.appendChild(card);

  card.querySelector("#enable-push-device")?.addEventListener("click", (event) => enablePush(event.currentTarget));
  card.querySelector("#test-push-device")?.addEventListener("click", (event) => testPush(event.currentTarget));
  card.querySelector("#disable-push-device")?.addEventListener("click", (event) => disablePush(event.currentTarget));

  return card;
}

async function refreshCard() {
  const card = await buildCard();
  if (!card) return;
  const status = card.querySelector("#push-device-status");
  try {
    const subscription = await getSubscription();
    status.textContent = permissionLabel(subscription);
  } catch {
    status.textContent = pushSupported() ? "Unavailable" : "Not supported";
  }
}

let refreshTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshCard, 50);
});

observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("focus", refreshCard);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshCard();
});
refreshCard();
