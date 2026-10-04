import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_CONFIG_ERROR = "Supabase is not configured. Check your environment variables.";

function readSupabaseConfig() {
  const config = window.HOME_OPS_CONFIG || {};
  return {
    supabaseUrl: String(config.supabaseUrl || config.VITE_SUPABASE_URL || "").trim(),
    supabaseAnonKey: String(config.supabaseAnonKey || config.VITE_SUPABASE_ANON_KEY || "").trim(),
  };
}

function isPlaceholderConfig(value) {
  return !value || value.includes("YOUR_PROJECT") || value.includes("YOUR_PUBLIC") || value.includes("YOUR_SUPABASE");
}

function createSupabaseClient() {
  const config = readSupabaseConfig();
  const missingUrl = isPlaceholderConfig(config.supabaseUrl);
  const missingAnonKey = isPlaceholderConfig(config.supabaseAnonKey);

  if (missingUrl || missingAnonKey) {
    console.error("[Home Ops] Supabase configuration is missing or still using placeholders.", {
      hasSupabaseUrl: Boolean(config.supabaseUrl),
      hasSupabaseAnonKey: Boolean(config.supabaseAnonKey),
      supabaseUrlLooksConfigured: !missingUrl,
      supabaseAnonKeyLooksConfigured: !missingAnonKey,
      expectedConfig: "window.HOME_OPS_CONFIG.supabaseUrl and window.HOME_OPS_CONFIG.supabaseAnonKey",
      viteEnvNamesIfBundledLater: "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY",
    });
    return null;
  }

  try {
    return createClient(config.supabaseUrl, config.supabaseAnonKey);
  } catch (error) {
    console.error("[Home Ops] Supabase client failed to initialize.", {
      hasSupabaseUrl: Boolean(config.supabaseUrl),
      hasSupabaseAnonKey: Boolean(config.supabaseAnonKey),
      error,
    });
    return null;
  }
}

const supabase = createSupabaseClient();
const configured = Boolean(supabase);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TABLES = ["tasks", "reminders", "events", "bills", "routines", "routine_items", "routine_completions", "weekly_plans", "notification_settings", "notifications"];

const state = {
  session: null,
  profile: null,
  household: null,
  householdMembers: [],
  householdInvites: [],
  inviteToken: new URLSearchParams(window.location.search).get("invite") || "",
  authMode: "login",
  tab: "today",
  upcomingRange: "14",
  selectedDate: formatLocalDate(new Date()),
  calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  overlayOpen: false,
  loading: false,
  data: Object.fromEntries(TABLES.map((table) => [table, []])),
};

export function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTime12Hour(time) {
  if (!time) return "";
  const [hourString, minute = "00"] = time.slice(0, 5).split(":");
  const hour = Number(hourString);
  if (Number.isNaN(hour)) return time;
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? "PM" : "AM"}`;
}

function formatDateOnly(value, options = { month: "short", day: "numeric", year: "numeric" }) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", options).format(new Date(year, month - 1, day));
}

function todayString() {
  return formatLocalDate(new Date());
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

function safeDateString(value, fallback = todayString()) {
  return isDateString(value) ? value : fallback;
}

function timestampLocalDate(value) {
  return value ? formatLocalDate(new Date(value)) : "";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function id() {
  return crypto.randomUUID();
}

function toast(message, type = "success") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.textContent = message;
  $("#toast-root").append(item);
  setTimeout(() => item.remove(), 3300);
}

function errorMessage(error) {
  return error?.message || String(error || "Something went wrong.");
}

function friendlyErrorMessage(error, fallback = "Something went wrong. Please try again.") {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("invalid login") || message.includes("invalid credentials")) return "Email or password is incorrect.";
  if (message.includes("failed to fetch") || message.includes("network")) return "Network connection problem. Please try again.";
  if (message.includes("jwt") || message.includes("session")) return "Your session expired. Please sign in again.";
  if (message.includes("row-level security") || message.includes("permission denied")) return "You do not have permission to make that change.";
  if (message.includes("duplicate") || message.includes("unique")) return "That item already exists.";
  if (error instanceof Error && !("code" in error)) return error.message;
  return fallback;
}

function handleError(error, message = "Something went wrong.") {
  console.error(message, error);
  toast(`${message} ${friendlyErrorMessage(error)}`, "error");
}

function setButtonLoading(button, isLoading, label = "Save", loadingLabel = "Saving...") {
  if (!button) return;
  button.disabled = isLoading;
  button.setAttribute("aria-busy", String(isLoading));
  button.textContent = isLoading ? loadingLabel : label;
}

async function init() {
  bindGlobalEvents();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);

  if (!supabase) {
    showSupabaseConfigError();
    return;
  }

  $("#auth-message").textContent = "Checking your session...";
  const { data, error } = await supabase.auth.getSession();
  if (error) handleError(error, "Could not restore your session.");
  await applySession(data?.session || null);

  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => applySession(session), 0);
  });
}

function bindGlobalEvents() {
  $("#login-form").addEventListener("submit", handleAuthSubmit);
  $("#auth-mode-login")?.addEventListener("click", () => setAuthMode("login"));
  $("#auth-mode-signup")?.addEventListener("click", () => setAuthMode("signup"));
  $("#forgot-password")?.addEventListener("click", sendPasswordReset);
  $("#header-add").addEventListener("click", openQuickAdd);
  $("#fab").addEventListener("click", openQuickAdd);
  $("#bottom-nav").addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.tab = button.dataset.tab;
    render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.session) refreshAll();
  });
  window.addEventListener("focus", () => state.session && refreshAll());
  window.addEventListener("pageshow", () => state.session && refreshAll());
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isSignup = mode === "signup";
  $("#auth-name-row")?.classList.toggle("hidden", !isSignup);
  $("#login-form button[type='submit']").textContent = isSignup ? "Create account" : "Sign in";
  $("#auth-mode-login")?.classList.toggle("active", !isSignup);
  $("#auth-mode-signup")?.classList.toggle("active", isSignup);
  const message = $("#auth-message");
  if (message) message.textContent = state.inviteToken && isSignup ? "Create an account to join the household invitation." : "";
}

async function handleAuthSubmit(event) {
  if (state.authMode === "signup") return signup(event);
  return loginHardened(event);
}

async function login(event) {
  event.preventDefault();
  const message = $("#auth-message");
  message.textContent = "";
  if (!supabase) {
    showSupabaseConfigError();
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: $("#login-email").value.trim(),
      password: $("#login-password").value,
    });
    if (error) throw error;
  } catch (error) {
    console.error(error);
    message.textContent = friendlyErrorMessage(error, "Could not sign in. Please check your email and password.");
  } finally {
    button.disabled = false;
    button.textContent = "Sign in";
  }
}

async function signup(event) {
  event.preventDefault();
  const message = $("#auth-message");
  const button = event.submitter;
  if (message) message.textContent = "";
  if (!supabase) {
    showSupabaseConfigError();
    return;
  }
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const displayName = $("#signup-name")?.value.trim() || email.split("@")[0];
  setButtonLoading(button, true, "Create account", "Creating...");
  try {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: "https://tjas12.github.io/home-ops/", data: { display_name: displayName, name: displayName } },
    });
    if (error) throw error;
    if (message) message.textContent = "Account created. Check your email if Supabase asks you to confirm, then sign in.";
    setAuthMode("login");
  } catch (error) {
    console.error("Signup failed", error);
    if (message) message.textContent = friendlyErrorMessage(error, "Could not create that account.");
  } finally {
    setButtonLoading(button, false, "Create account", "Creating...");
  }
}

async function sendPasswordReset() {
  const message = $("#auth-message");
  const email = $("#login-email").value.trim();
  if (!email) {
    if (message) message.textContent = "Enter your email first, then tap Forgot password.";
    return;
  }
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: "https://tjas12.github.io/home-ops/" });
    if (error) throw error;
    if (message) message.textContent = "Password reset email sent.";
  } catch (error) {
    console.error("Password reset failed", error);
    if (message) message.textContent = friendlyErrorMessage(error, "Could not send reset email.");
  }
}

function showSupabaseConfigError() {
  const message = $("#auth-message");
  if (message) message.textContent = SUPABASE_CONFIG_ERROR;
  const button = $("#login-form button[type='submit']");
  if (button) button.disabled = true;
}

async function loginHardened(event) {
  event.preventDefault();
  const message = $("#auth-message");
  const button = event.submitter;
  if (message) message.textContent = "";
  if (!supabase) {
    showSupabaseConfigError();
    return;
  }

  setButtonLoading(button, true, "Sign in", "Signing in...");
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: $("#login-email").value.trim(),
      password: $("#login-password").value,
    });
    if (error) throw error;
  } catch (error) {
    console.error("Login failed", error);
    if (message) message.textContent = friendlyErrorMessage(error, "Could not sign in. Please check your email and password.");
  } finally {
    setButtonLoading(button, false, "Sign in", "Signing in...");
  }
}

async function applySession(session) {
  state.session = session;
  if (!session) {
    state.profile = null;
    state.household = null;
    state.householdMembers = [];
    state.householdInvites = [];
    $("#auth-view").classList.remove("hidden");
    await syncBadge();
    $("#shell").classList.add("hidden");
    if (state.inviteToken) setAuthMode("signup");
    return;
  }

  let { data: profile, error } = await supabase.from("users").select("*").eq("id", session.user.id).maybeSingle();
  if (error) {
    console.error("Profile lookup failed", error);
    $("#auth-message").textContent = friendlyErrorMessage(error, "Could not load your profile.");
    return;
  }
  if (!profile) {
    const displayName = session.user.user_metadata?.display_name || session.user.user_metadata?.name || session.user.email.split("@")[0];
    const result = await supabase.from("users").insert({
      id: session.user.id,
      email: session.user.email.toLowerCase(),
      name: displayName,
      display_name: displayName,
      role: "member",
    }).select("*").single();
    if (result.error) {
      console.error("Profile creation failed", result.error);
      $("#auth-message").textContent = friendlyErrorMessage(result.error, "Could not create your profile.");
      return;
    }
    profile = result.data;
  }

  state.profile = normalizeProfile(profile);
  $("#auth-view").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  if (state.inviteToken) {
    await acceptInviteToken(state.inviteToken, { quiet: false });
    state.inviteToken = "";
    window.history.replaceState({}, "", window.location.pathname);
  }
  await loadHouseholdContext();
  if (!state.profile.household_id) {
    state.tab = "settings";
    renderOnboarding();
    return;
  }
  await refreshAll();
  await readNotificationFromLocation();
}

function normalizeProfile(profile) {
  return {
    ...profile,
    display_name: profile.display_name || profile.name || profile.email,
    name: profile.name || profile.display_name || profile.email,
  };
}

async function loadHouseholdContext() {
  const { data: memberships, error } = await supabase
    .from("household_members")
    .select("*")
    .eq("user_id", state.profile.id)
    .order("joined_at");
  if (error) throw error;
  const membership = memberships?.find((item) => item.household_id === state.profile.household_id) || memberships?.[0];
  if (!membership) {
    state.profile.household_id = null;
    state.household = null;
    state.householdMembers = [];
    state.householdInvites = [];
    return;
  }
  state.profile.household_id = membership.household_id;
  state.profile.member_role = membership.role;
  await supabase.from("users").update({ household_id: membership.household_id }).eq("id", state.profile.id);
  const [{ data: household, error: householdError }, { data: members, error: membersError }] = await Promise.all([
    supabase.from("households").select("*").eq("id", membership.household_id).single(),
    supabase.from("household_members").select("*").eq("household_id", membership.household_id).order("joined_at"),
  ]);
  if (householdError) throw householdError;
  if (membersError) throw membersError;
  const userIds = (members || []).map((member) => member.user_id);
  const { data: users, error: usersError } = userIds.length
    ? await supabase.from("users").select("id,email,name,display_name,role,household_id").in("id", userIds)
    : { data: [], error: null };
  if (usersError) throw usersError;
  state.household = household;
  state.householdMembers = (members || []).map((member) => ({
    ...member,
    user: (users || []).find((user) => user.id === member.user_id) || {},
  }));
}

function isOwner() {
  return state.householdMembers.some((member) => member.user_id === state.profile?.id && member.role === "owner");
}

async function acceptInviteToken(token, { quiet = false } = {}) {
  try {
    const { error } = await supabase.rpc("accept_household_invite", { invite_token_text: token });
    if (error) throw error;
    if (!quiet) toast("Household invitation accepted.");
  } catch (error) {
    console.error("Invite acceptance failed", error);
    if (!quiet) toast(friendlyErrorMessage(error, "Could not accept that invitation."), "error");
  }
}

async function refreshAll({ quiet = false } = {}) {
  if (!state.profile?.household_id) return;
  const firstLoad = !TABLES.some((table) => Array.isArray(state.data[table]) && state.data[table].length);
  if (firstLoad) {
    state.loading = true;
    render();
  }
  try {
    await loadHouseholdContext();
    const householdId = state.profile.household_id;
    const queries = [
      supabase.from("tasks").select("*").eq("household_id", householdId).order("due_date", { ascending: true, nullsFirst: false }),
      supabase.from("reminders").select("*").eq("household_id", householdId).order("reminder_date"),
      supabase.from("events").select("*").eq("household_id", householdId).order("event_date").order("start_time"),
      supabase.from("bills").select("*").eq("household_id", householdId).order("due_date"),
      supabase.from("routines").select("*").eq("household_id", householdId).order("created_at"),
      supabase.from("routine_items").select("*").order("sort_order"),
      supabase.from("routine_completions").select("*").eq("completed_date", todayString()),
      supabase.from("weekly_plans").select("*").eq("household_id", householdId).order("week_start_date", { ascending: false }),
      supabase.from("notification_settings").select("*").eq("household_id", householdId).maybeSingle(),
      supabase.from("notifications").select("*").eq("household_id", householdId).order("created_at", { ascending: false }).limit(100),
    ];
    const results = await Promise.all(queries);
    const failure = results.find((result) => result.error);
    if (failure) throw failure.error;
    TABLES.forEach((table, index) => {
      state.data[table] = table === "notification_settings" ? (results[index].data || null) : (results[index].data || []);
    });
    if (isOwner()) {
      const { data: invites, error: invitesError } = await supabase
        .from("household_invites")
        .select("*")
        .eq("household_id", householdId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (invitesError) throw invitesError;
      state.householdInvites = invites || [];
    } else {
      state.householdInvites = [];
    }
    const scheduledResult = await supabase.from("weekly_plan_items").select("*").eq("household_id", householdId).order("scheduled_date", { nullsFirst: false }).order("scheduled_time", { nullsFirst: false });
    if (scheduledResult.error) console.warn("Scheduled items migration unavailable", scheduledResult.error);
    state.data.weekly_plan_items = scheduledResult.data || [];
    state.loading = false;
    render();
    await syncBadge();
  } catch (error) {
    console.error("Refresh failed", error);
    state.loading = false;
    render();
    if (!quiet) toast(`Could not refresh: ${friendlyErrorMessage(error, "Please refresh and try again.")}`, "error");
  }
}

function renderOnboarding() {
  $("#page-title").textContent = "Welcome";
  $("#auth-view").classList.add("hidden");
  $("#shell").classList.remove("hidden");
  $("#bottom-nav").classList.add("hidden-down");
  $("#fab").classList.add("hidden");
  $("#page").innerHTML = `<section class="hero">
    <p class="eyebrow">WELCOME TO HOME OPS</p>
    <h2>Create or join a household</h2>
    <p>Each household gets its own private workspace. Your tasks, calendar, routines, bills, and members stay isolated from every other family.</p>
  </section>
  <section class="card">
    <h2>Create Household</h2>
    <p class="muted-copy">Start a new private Home Ops workspace and become the household owner.</p>
    <form id="create-household-form">
      ${field("household_name", "Household name", "text", "", { required: true })}
      <button class="primary wide" type="submit">Create Household</button>
    </form>
  </section>
  <section class="card">
    <h2>Join Household</h2>
    <p class="muted-copy">Paste an invite code or open the invite link you received.</p>
    <form id="join-household-form">
      ${field("invite_token", "Invite code", "text", state.inviteToken, { required: true })}
      <button class="secondary wide" type="submit">Join Household</button>
    </form>
  </section>
  <section class="card"><button id="logout" class="secondary wide">Log out</button></section>`;
  $("#create-household-form").addEventListener("submit", createHousehold);
  $("#join-household-form").addEventListener("submit", joinHousehold);
  $("#logout")?.addEventListener("click", () => supabase.auth.signOut());
}

async function createHousehold(event) {
  event.preventDefault();
  const button = event.submitter;
  setButtonLoading(button, true, "Create Household", "Creating...");
  try {
    const name = $('[name="household_name"]').value.trim();
    if (!name) throw new Error("Add a household name.");
    const { data: household, error: householdError } = await supabase
      .from("households")
      .insert({ id: id(), name, created_by: state.profile.id })
      .select("*")
      .single();
    if (householdError) throw householdError;
    const { error: memberError } = await supabase.from("household_members").insert({
      household_id: household.id,
      user_id: state.profile.id,
      role: "owner",
    });
    if (memberError) throw memberError;
    await supabase.from("users").update({ household_id: household.id, role: "owner" }).eq("id", state.profile.id);
    state.profile.household_id = household.id;
    state.profile.member_role = "owner";
    $("#bottom-nav").classList.remove("hidden-down");
    $("#fab").classList.remove("hidden");
    state.tab = "today";
    await refreshAll({ quiet: true });
    toast("Household created.");
  } catch (error) {
    handleError(error, "Could not create household.");
  } finally {
    setButtonLoading(button, false, "Create Household", "Creating...");
  }
}

async function joinHousehold(event) {
  event.preventDefault();
  const button = event.submitter;
  setButtonLoading(button, true, "Join Household", "Joining...");
  try {
    const token = $('[name="invite_token"]').value.trim();
    if (!token) throw new Error("Enter an invite code.");
    await acceptInviteToken(token, { quiet: true });
    await loadHouseholdContext();
    $("#bottom-nav").classList.remove("hidden-down");
    $("#fab").classList.remove("hidden");
    state.tab = "today";
    await refreshAll({ quiet: true });
    toast("Joined household.");
  } catch (error) {
    handleError(error, "Could not join household.");
  } finally {
    setButtonLoading(button, false, "Join Household", "Joining...");
  }
}

function render() {
  if (!state.profile) return;
  const titles = { today: "Today", routines: "Routines", calendar: "Calendar", tasks: "Tasks", weekly: "Weekly Reset", settings: "Settings" };
  $("#page-title").textContent = titles[state.tab];
  $$("#bottom-nav [data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === state.tab));
  $("#fab").classList.toggle("hidden", state.tab === "settings");
  const pages = { today: renderToday, routines: renderRoutines, calendar: renderCalendar, tasks: renderTasks, weekly: renderWeekly, settings: renderSettings };
  $("#page").innerHTML = state.loading ? renderLoadingPage() : pages[state.tab]();
  setOverlayOpen(state.overlayOpen);
  bindPageEvents();
}

function itemTable(type) {
  return type === "weeklyItem" ? "weekly_plan_items" : type === "routineItem" ? "routine_items" : `${type}s`;
}

function overlaps(event, start, end) {
  return event.event_date <= end && (event.end_date || event.event_date) >= start;
}

function upcomingEnd(start, range) {
  const date = new Date(`${start}T12:00:00`);
  if (range === "month") {
    const day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + 1);
    date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  } else date.setDate(date.getDate() + 13);
  return formatLocalDate(date);
}

function eventOrder(a, b) {
  return `${a.event_date}${a.start_time || ""}`.localeCompare(`${b.event_date}${b.start_time || ""}`);
}

function reminderField(item) {
  return field("reminder_minutes", "Reminder", "select", String(item?.reminder_minutes || ""), { values: [["", "No reminder"], ["5", "5 minutes before"], ["30", "30 minutes before"], ["60", "1 hour before"]] });
}

let badgeRequest = 0;
async function readNotificationFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const userId = state.session?.user?.id;
  if (!params.get("notification") || params.get("notificationUser") !== userId) return;
  try {
    const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", params.get("notification")).eq("user_id", userId);
    if (error) throw error;
    params.delete("notification"); params.delete("notificationUser");
    window.history.replaceState({}, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    await syncBadge();
  } catch (error) { console.warn("Notification read unavailable", error); }
}

async function syncBadge() {
  const request = ++badgeRequest;
  try {
    const userId = state.session?.user?.id;
    let count = 0;
    if (userId) {
      const result = await supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null).eq("status", "sent").lte("scheduled_for", new Date().toISOString());
      if (result.error) throw result.error;
      count = result.count || 0;
    }
    if (request !== badgeRequest || userId !== state.session?.user?.id) return;
    if (count && navigator.setAppBadge) await navigator.setAppBadge(count);
    else if (!count && navigator.clearAppBadge) await navigator.clearAppBadge();
    navigator.serviceWorker?.controller?.postMessage({ type: "HOME_OPS_BADGE", count });
  } catch (error) { console.warn("Badge refresh unavailable", error); }
}

window.addEventListener("focus", () => syncBadge());
navigator.serviceWorker?.addEventListener("message", async (event) => {
  if (event.data?.type === "HOME_OPS_NOTIFICATION_READ" && event.data.userId === state.session?.user?.id && event.data.id) {
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", event.data.id).eq("user_id", state.session.user.id);
  }
  if (event.data?.type === "HOME_OPS_PUSH" || event.data?.type === "HOME_OPS_NOTIFICATION_READ") await syncBadge();
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncBadge(); });
try { state.upcomingRange = localStorage.getItem("home-ops-upcoming-range") === "month" ? "month" : "14"; } catch {}

function bindPageEvents() {
  $("#upcoming-range")?.addEventListener("change", (event) => {
    state.upcomingRange = event.target.value;
    try { localStorage.setItem("home-ops-upcoming-range", state.upcomingRange); } catch {}
    render();
  });
  $$(".js-read-notification").forEach((button) => button.addEventListener("click", async () => {
    const { error } = await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", button.dataset.id).eq("user_id", state.profile.id);
    if (error) return handleError(error, "Could not mark notification read.");
    navigator.serviceWorker?.controller?.postMessage({ type: "HOME_OPS_CLOSE_NOTIFICATION", id: button.dataset.id, userId: state.profile.id });
    await refreshAll({ quiet: true });
  }));
  $$(".js-add").forEach((button) => button.addEventListener("click", () => openEditor(button.dataset.type, null, { date: button.dataset.date })));
  $$(".js-edit").forEach((button) => button.addEventListener("click", () => openEditor(button.dataset.type, getItem(button.dataset.type, button.dataset.id))));
  $$(".js-delete").forEach((button) => button.addEventListener("click", () => deleteItem(button.dataset.type, button.dataset.id)));
  $$(".js-toggle").forEach((button) => button.addEventListener("click", () => toggleComplete(button.dataset.type, button.dataset.id)));
  $$(".js-routine-toggle").forEach((button) => button.addEventListener("click", () => toggleRoutineItem(button.dataset.routineId, button.dataset.itemId)));
  $("#quick-add-inline")?.addEventListener("click", openQuickAdd);
  $("#calendar-prev")?.addEventListener("click", () => changeMonth(-1));
  $("#calendar-next")?.addEventListener("click", () => changeMonth(1));
  $$(".day[data-date]").forEach((button) => button.addEventListener("click", () => {
    state.selectedDate = button.dataset.date;
    const [year, month] = state.selectedDate.split("-").map(Number);
    state.calendarMonth = new Date(year, month - 1, 1);
    render();
  }));
  $("#generate-week")?.addEventListener("click", generateWeek);
  $("#save-week")?.addEventListener("click", saveWeek);
  $("#logout")?.addEventListener("click", () => supabase.auth.signOut());
  $("#test-email")?.addEventListener("click", sendTestEmail);
  $("#save-notification-settings")?.addEventListener("click", saveNotificationSettings);
  $("#save-household")?.addEventListener("click", saveHouseholdSettings);
  $("#invite-member")?.addEventListener("click", createHouseholdInvite);
  $$(".js-remove-member").forEach((button) => button.addEventListener("click", () => removeHouseholdMember(button.dataset.memberId)));
}

function getItem(type, itemId) {
  const table = itemTable(type);
  return state.data[table]?.find((item) => item.id === itemId);
}

function personLabel(value) {
  return escapeHtml(value || "Shared");
}

function memberDisplayName(user = {}) {
  return user.display_name || user.name || user.email || "Household member";
}

function memberByUserId(userId) {
  return state.householdMembers.find((member) => member.user_id === userId);
}

function assigneeLabel(item = {}) {
  if (item.assigned_user_id) {
    const member = memberByUserId(item.assigned_user_id);
    return escapeHtml(member ? memberDisplayName(member.user) : "Household member");
  }
  return personLabel(item.assigned_to === "Shared" ? "Everyone" : item.assigned_to || "Everyone");
}

function itemCard(type, item, options = {}) {
  const complete = type === "bill" ? item.status === "paid" : Boolean(item.completed);
  const date = item.due_date || item.reminder_date || item.event_date || item.scheduled_date;
  const time = item.due_time || item.reminder_time || item.start_time || item.scheduled_time;
  const priority = item.priority || item.category || item.item_type;
  const completable = options.completable !== false;
  return `
    <article class="card item-card ${complete ? "completed" : ""}">
      ${completable ? `<button class="check ${complete ? "checked" : ""} js-toggle" data-type="${type}" data-id="${item.id}" aria-label="${complete ? "Mark incomplete" : "Mark complete"}">${complete ? "✓" : ""}</button>` : "<span></span>"}
      <div>
        <p class="item-title">${escapeHtml(item.title || item.name)}</p>
        <div class="meta">
          <span class="pill">${assigneeLabel(item)}</span>
          ${date ? `<span>${formatDateOnly(date)}${item.end_date && item.end_date !== date ? ` - ${formatDateOnly(item.end_date)}` : ""}${time ? ` · ${formatTime12Hour(time)}` : ""}</span>` : ""}
          ${priority ? `<span class="pill ${String(priority).toLowerCase()}">${escapeHtml(priority)}</span>` : ""}
          ${complete ? `<span class="pill completed">${type === "bill" ? "Paid" : "Completed"}</span>` : ""}
        </div>
      </div>
      <div class="actions">
        <button class="ghost-icon js-edit" data-type="${type}" data-id="${item.id}" aria-label="Edit">✎</button>
        <button class="ghost-icon js-delete" data-type="${type}" data-id="${item.id}" aria-label="Delete">×</button>
      </div>
    </article>`;
}

function renderLoadingPage() {
  return `<section class="card loading-card" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <div>
      <h2>Loading Home Ops...</h2>
      <p class="muted-copy">Getting the latest household plan.</p>
    </div>
  </section>`;
}

function emptyState(message, actionType = "", actionLabel = "") {
  return `<div class="empty">
    <p>${escapeHtml(message)}</p>
    ${actionType ? `<button class="soft-button js-add" data-type="${escapeHtml(actionType)}">${escapeHtml(actionLabel || `Add ${actionType}`)}</button>` : ""}
  </div>`;
}

function section(title, items, renderer, emptyContent = "Nothing here right now.") {
  const emptyMarkup = emptyContent.includes("<") ? emptyContent : emptyState(emptyContent);
  return `<section class="section">
    <div class="section-head"><h2>${title}</h2><span class="count">${items.length}</span></div>
    <div class="stack">${items.length ? items.map(renderer).join("") : emptyMarkup}</div>
  </section>`;
}

function renderToday() {
  const today = todayString();
  const dayName = DAY_NAMES[new Date().getDay()];
  const dueTasks = state.data.tasks.filter((item) => item.due_date === today && !item.completed);
  const reminders = state.data.reminders.filter((item) => item.reminder_date === today && !item.completed);
  const end = upcomingEnd(today, state.upcomingRange);
  const events = state.data.events.filter((item) => !item.completed && item.status !== "cancelled" && overlaps(item, today, end)).sort(eventOrder);
  const scheduled = state.data.weekly_plan_items || [];
  const dueBills = state.data.bills.filter((item) => daysBetween(today, item.due_date) >= 0 && daysBetween(today, item.due_date) <= 3 && item.status !== "paid");
  const overdue = [
    ...state.data.tasks.filter((item) => item.due_date && item.due_date < today && !item.completed).map((item) => ({ type: "task", item })),
    ...state.data.reminders.filter((item) => item.reminder_date < today && !item.completed).map((item) => ({ type: "reminder", item })),
    ...state.data.bills.filter((item) => item.due_date < today && item.status !== "paid").map((item) => ({ type: "bill", item })),
  ];
  const routineRows = routinesForDate(today);
  const completedToday = [
    ...scheduled.filter((item) => item.completed && timestampLocalDate(item.completed_at) === today).map((item) => ({ type: "weeklyItem", item })),
    ...state.data.tasks.filter((item) => item.completed && timestampLocalDate(item.completed_at) === today).map((item) => ({ type: "task", item })),
    ...state.data.reminders.filter((item) => item.completed && timestampLocalDate(item.completed_at) === today).map((item) => ({ type: "reminder", item })),
    ...state.data.events.filter((item) => item.completed && timestampLocalDate(item.completed_at) === today).map((item) => ({ type: "event", item })),
    ...state.data.bills.filter((item) => item.status === "paid" && timestampLocalDate(item.paid_at) === today).map((item) => ({ type: "bill", item })),
  ];

  const routineTotal = routineRows.reduce((sum, row) => sum + row.items.length, 0);
  const routineDone = routineRows.reduce((sum, row) => sum + row.items.filter((entry) => entry.completed).length, 0);
  const progressItems = [
    ...scheduled.filter((item) => item.scheduled_date === today),
    ...state.data.tasks.filter((item) => item.due_date === today),
    ...state.data.reminders.filter((item) => item.reminder_date === today),
    ...state.data.bills.filter((item) => item.due_date === today),
  ];
  const completeCount = progressItems.filter((item) => item.completed || item.status === "paid").length + routineDone;
  const total = progressItems.length + routineTotal;
  const percent = total ? Math.round((completeCount / total) * 100) : 100;
  const firstName = (state.profile.name || state.profile.role || "there").split(" ")[0];

  return `
    <section class="hero">
      <div class="date">${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date())}</div>
      <h2>Good ${greetingPeriod()}, ${escapeHtml(firstName)}.</h2>
      <p>${dayName} is ${percent}% complete — ${completeCount} of ${total} items done.</p>
      <div class="progress-track"><div style="width:${percent}%"></div></div>
    </section>
    <div class="quick-row"><button id="quick-add-inline" class="primary">Quick Add</button><button class="secondary js-add" data-type="task">+ Task</button></div>
    ${section("Due Today", dueTasks, (item) => itemCard("task", item), emptyState("No tasks due today. Add one if something needs attention.", "task", "Add a task"))}
    ${renderTodayRoutines(routineRows)}
    ${section("Reminders", reminders, (item) => itemCard("reminder", item), emptyState("No reminders today. Add one for anything easy to forget.", "reminder", "Add a reminder"))}
    ${scheduled.some((item) => item.scheduled_date === today && !item.completed) ? section("Scheduled Today", scheduled.filter((item) => item.scheduled_date === today && !item.completed), (item) => itemCard("weeklyItem", item)) : ""}
    ${section(`Upcoming Events <select id="upcoming-range" aria-label="Upcoming event range"><option value="14" ${state.upcomingRange !== "month" ? "selected" : ""}>Next 2 Weeks</option><option value="month" ${state.upcomingRange === "month" ? "selected" : ""}>Next Month</option></select>`, events, (item) => itemCard("event", item), emptyState("No events in this range.", "event", "Add an event"))}
    ${scheduled.some((item) => item.scheduled_date > today && item.scheduled_date <= end && !item.completed) ? section("Upcoming Scheduled Items", scheduled.filter((item) => item.scheduled_date > today && item.scheduled_date <= end && !item.completed).sort((a, b) => `${a.scheduled_date}${a.scheduled_time || ""}`.localeCompare(`${b.scheduled_date}${b.scheduled_time || ""}`)), (item) => itemCard("weeklyItem", item)) : ""}
    ${section("Bills Due Soon", dueBills, (item) => itemCard("bill", item), "No bills due in the next three days.")}
    ${section("Overdue", overdue, ({ type, item }) => itemCard(type, item), "Nothing overdue. Nice.")}
    ${section("Completed Today", completedToday, ({ type, item }) => itemCard(type, item), "Completed items will collect here.")}`;
}

function greetingPeriod() {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
}

function daysBetween(from, to) {
  if (!from || !to) return Infinity;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function routinesForDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const dayName = DAY_NAMES[new Date(year, month - 1, day).getDay()];
  return state.data.routines
    .filter((routine) => routine.active && (routine.days_of_week || []).includes(dayName))
    .map((routine) => ({
      routine,
      items: state.data.routine_items
        .filter((item) => item.routine_id === routine.id)
        .map((item) => ({
          ...item,
          completed: state.data.routine_completions.some(
            (completion) => completion.routine_item_id === item.id && completion.completed_date === dateString
          ),
        })),
    }));
}

function renderTodayRoutines(rows) {
  const total = rows.reduce((sum, row) => sum + row.items.length, 0);
  return `<section class="section">
    <div class="section-head"><h2>Routines for Today</h2><span class="count">${total}</span></div>
    <div class="stack">${rows.length ? rows.map(({ routine, items }) => `
      <article class="card">
        <div class="section-head"><div><strong>${escapeHtml(routine.name)}</strong><div class="meta">${assigneeLabel(routine)}${routine.time ? ` · ${formatTime12Hour(routine.time)}` : ""}</div></div><span class="count">${items.filter((item) => item.completed).length}/${items.length}</span></div>
        <div class="stack">${items.map((item) => `
          <div class="item-card ${item.completed ? "completed" : ""}">
            <button class="check ${item.completed ? "checked" : ""} js-routine-toggle" data-routine-id="${routine.id}" data-item-id="${item.id}">${item.completed ? "✓" : ""}</button>
            <span class="item-title">${escapeHtml(item.title)}</span><span></span>
          </div>`).join("") || `<div class="empty">No checklist items.</div>`}</div>
      </article>`).join("") : emptyState("No routines are scheduled for today. Create a routine to make repeat work easier.", "routine", "Create a routine")}</div>
  </section>`;
}

function renderTasks() {
  const tasks = [...state.data.tasks].sort((a, b) => Number(a.completed) - Number(b.completed) || (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  return `<div class="quick-row"><button class="primary js-add" data-type="task">+ Add Task</button><span></span></div>
    ${section("All Tasks", tasks, (item) => itemCard("task", item), emptyState("Your task list is clear. Add your first task to start tracking household work.", "task", "Add your first task"))}`;
}

function renderRoutines() {
  return `<div class="quick-row"><button class="primary js-add" data-type="routine">+ Add Routine</button><span></span></div>
    <div class="stack">${state.data.routines.length ? state.data.routines.map((routine) => {
      const items = state.data.routine_items.filter((item) => item.routine_id === routine.id);
      return `<article class="card">
        <div class="section-head">
          <div><h2>${escapeHtml(routine.name)}</h2><div class="meta"><span class="pill">${assigneeLabel(routine)}</span><span>${(routine.days_of_week || []).map((day) => day.slice(0, 3)).join(", ")}</span>${routine.time ? `<span>${formatTime12Hour(routine.time)}</span>` : ""}</div></div>
          <div class="actions"><button class="ghost-icon js-edit" data-type="routine" data-id="${routine.id}">✎</button><button class="ghost-icon js-delete" data-type="routine" data-id="${routine.id}">×</button></div>
        </div>
        <div class="meta"><span class="pill">${items.length} checklist item${items.length === 1 ? "" : "s"}</span><span class="pill">${routine.active ? "Active" : "Inactive"}</span></div>
      </article>`;
    }).join("") : emptyState("No routines yet. Create a routine for chores, bedtime, pets, or weekly reset habits.", "routine", "Create a routine")}</div>`;
}

function renderCalendar() {
  const month = state.calendarMonth;
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const value = formatLocalDate(date);
    const eventsForDay = state.data.events.filter((event) => overlaps(event, value, value));
    eventsForDay.push(...(state.data.weekly_plan_items || []).filter((item) => item.item_type === "appointment" && item.scheduled_date === value));
    return { date, value, eventsForDay };
  });
  const selected = state.data.events.filter((event) => overlaps(event, state.selectedDate, state.selectedDate));
  selected.push(...(state.data.weekly_plan_items || []).filter((item) => item.item_type === "appointment" && item.scheduled_date === state.selectedDate));

  return `<div class="quick-row"><button class="primary js-add" data-type="event" data-date="${escapeHtml(state.selectedDate)}">+ Add Event</button><span></span></div>
    <section class="card">
      <div class="calendar-head"><button id="calendar-prev" class="ghost-icon">‹</button><h2>${new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(month)}</h2><button id="calendar-next" class="ghost-icon">›</button></div>
      <div class="calendar-grid">
        ${SHORT_DAYS.map((day) => `<div class="weekday">${day}</div>`).join("")}
        ${cells.map(({ date, value, eventsForDay }) => `<button class="day ${date.getMonth() !== month.getMonth() ? "outside" : ""} ${value === todayString() ? "today" : ""} ${value === state.selectedDate ? "selected" : ""}" data-date="${value}">
          ${date.getDate()}${eventsForDay.length ? `<span class="event-dot"></span>${eventsForDay.length > 1 ? `<span class="event-count">${eventsForDay.length}</span>` : ""}` : ""}
        </button>`).join("")}
      </div>
    </section>
    ${section(formatDateOnly(state.selectedDate, { weekday: "long", month: "long", day: "numeric" }), selected, (item) => itemCard(item.item_type ? "weeklyItem" : "event", item), emptyState("No events on this day. Add one for the selected date.", "event", "Add an event"))}`;
}

function changeMonth(delta) {
  state.calendarMonth = new Date(state.calendarMonth.getFullYear(), state.calendarMonth.getMonth() + delta, 1);
  state.selectedDate = formatLocalDate(state.calendarMonth);
  render();
}

function weekStartString() {
  const date = new Date();
  date.setDate(date.getDate() - date.getDay());
  return formatLocalDate(date);
}

function renderWeekly() {
  const plan = state.data.weekly_plans.find((item) => item.week_start_date === weekStartString()) || {};
  const field = (name, title, placeholder) => `<label>${title}<textarea id="week-${name}" placeholder="${placeholder}">${escapeHtml(plan[name] || "")}</textarea></label>`;
  return `<div class="quick-row"><button id="generate-week" class="soft-button">Generate This Week</button><button id="save-week" class="primary">Save Plan</button></div>
    <section class="card">
      <p class="eyebrow">WEEK OF ${formatDateOnly(weekStartString()).toUpperCase()}</p>
      ${field("top_priorities", "This week’s top priorities", "The three things that matter most…")}
      ${field("chores", "Chores", "Household jobs to divide…")}
      ${field("bills_due", "Bills due", "What needs to be paid…")}
      ${field("meal_plan", "Meal planning", "A loose plan is still a plan…")}
      ${field("appointments", "Appointments", "Where you need to be…")}
      ${field("shopping_list", "Things to buy", "Groceries and household items…")}
      ${field("notes", "Notes", "Anything else for the week…")}
    </section>
    <section class="section"><div class="section-head"><h2>Scheduled Items</h2><button class="soft-button js-add" data-type="weeklyItem">+ Add Scheduled Item</button></div>
    <div class="stack">${(state.data.weekly_plan_items || []).filter((item) => item.weekly_plan_id === plan.id).map((item) => itemCard("weeklyItem", item)).join("") || emptyState("No scheduled items this week.")}</div></section>`;
}

function renderSettings() {
  const notifications = state.data.notifications.slice(0, 30);
  const settings = state.data.notification_settings || {};
  const owner = isOwner();
  const memberRows = state.householdMembers.map((member) => `<article class="member-row">
    <div>
      <strong>${escapeHtml(memberDisplayName(member.user))}</strong>
      <div class="meta">${escapeHtml(member.user.email || "")} · ${escapeHtml(member.role)}</div>
    </div>
    ${owner && member.user_id !== state.profile.id ? `<button class="danger js-remove-member" data-member-id="${member.id}">Remove</button>` : `<span class="pill">${member.user_id === state.profile.id ? "You" : member.role}</span>`}
  </article>`).join("");
  const inviteRows = state.householdInvites.filter((invite) => invite.status === "pending").map((invite) => {
    const link = inviteLink(invite.invite_token);
    return `<article class="card invite-card">
      <div class="section-head"><strong>Pending invite</strong><span class="pill">${escapeHtml(invite.status)}</span></div>
      <input readonly value="${escapeHtml(link)}" />
      <div class="meta"><span>Expires ${new Date(invite.expires_at).toLocaleDateString()}</span></div>
    </article>`;
  }).join("");
  return `<section class="card">
      <h2>Account</h2>
      <p><strong>${escapeHtml(state.profile.display_name || state.profile.name || state.profile.email)}</strong><br><span class="meta">${escapeHtml(state.profile.member_role || state.profile.role || "member")} · ${escapeHtml(state.profile.email)}</span></p>
      <button id="logout" class="secondary wide">Log out</button>
    </section>
    <section class="section card">
      <h2>Household</h2>
      <label>Household name<input name="household_name_settings" value="${escapeHtml(state.household?.name || "")}" ${owner ? "" : "disabled"} /></label>
      <p class="muted-copy">${owner ? "Owners can update household settings and invite members." : "Only a household owner can change household settings."}</p>
      ${owner ? `<button id="save-household" class="secondary wide">Save Household</button>` : ""}
    </section>
    <section class="section card">
      <div class="section-head"><h2>Members</h2><span class="count">${state.householdMembers.length}</span></div>
      <div class="stack">${memberRows || "No members found."}</div>
      ${owner ? `<br><button id="invite-member" class="primary wide">Invite Household Member</button>` : ""}
    </section>
    ${owner ? `<section class="section card">
      <h2>Invitations</h2>
      <p class="muted-copy">Share the invite link with someone you trust. Links expire and can only be accepted by a signed-in user.</p>
      <div class="stack">${inviteRows || "No pending invitations."}</div>
    </section>` : ""}
    <section class="section card">
      <h2>App Settings</h2>
      <p class="muted-copy">Home Ops is running as one shared app with private household workspaces enforced by Supabase RLS.</p>
      <div class="meta"><span class="pill">Household sync on</span><span class="pill">PWA ready</span><span class="pill">Email reminders server-side</span></div>
    </section>
    <section class="section card">
      <h2>Notifications</h2>
      <div class="switch-row"><span>In-app notifications</span><input id="setting-in-app" type="checkbox" ${settings.in_app_enabled !== false ? "checked" : ""} /></div>
      <div class="switch-row"><span>Email notifications</span><input id="setting-email" type="checkbox" ${settings.email_enabled !== false ? "checked" : ""} /></div>
      <div class="switch-row"><span>SMS notifications</span><input id="setting-sms" type="checkbox" ${settings.sms_enabled ? "checked" : ""} /></div>
      <div class="form-grid">
        ${field("husband_email", "Primary email", "email", settings.husband_email || state.profile.email)}
        ${field("wife_email", "Secondary email", "email", settings.wife_email)}
        ${field("husband_phone", "Primary phone", "tel", settings.husband_phone)}
        ${field("wife_phone", "Secondary phone", "tel", settings.wife_phone)}
        ${field("quiet_hours_start", "Quiet hours start", "time", settings.quiet_hours_start)}
        ${field("quiet_hours_end", "Quiet hours end", "time", settings.quiet_hours_end)}
      </div>
      <p class="meta">Email delivery runs securely on the server. SMS is reserved for a later Twilio integration.</p>
      <button id="save-notification-settings" class="secondary wide">Save Notification Settings</button>
      <br><br>
      <button id="test-email" class="primary wide">Send Test Email</button>
    </section>
    ${section("Notifications Log", notifications, (item) => `<article class="card">
      <div class="section-head"><strong>${escapeHtml(item.title)}</strong><span class="pill ${item.status}">${escapeHtml(item.status)}</span></div>
      <div class="meta"><span>${escapeHtml(item.recipient || "")}</span><span>${escapeHtml(item.delivery_method)}</span><span>${item.scheduled_for ? new Date(item.scheduled_for).toLocaleString() : ""}</span></div>
      ${item.error_message ? `<p class="form-message">${escapeHtml(item.error_message)}</p>` : ""}
      ${item.user_id === state.profile.id && !item.read_at && item.status === "sent" ? `<button class="soft-button js-read-notification" data-id="${item.id}">Mark Read</button>` : ""}
    </article>`, "No notifications have been queued yet. Test emails and scheduled reminders will appear here.")}`;
}

function inviteLink(token) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("invite", token);
  return url.toString();
}

async function saveHouseholdSettings() {
  if (!isOwner()) return toast("Only household owners can update household settings.", "error");
  const button = $("#save-household");
  setButtonLoading(button, true, "Save Household", "Saving...");
  try {
    const name = $('[name="household_name_settings"]').value.trim();
    if (!name) throw new Error("Household name is required.");
    const { data, error } = await supabase
      .from("households")
      .update({ name, updated_at: new Date().toISOString() })
      .eq("id", state.profile.household_id)
      .select("*")
      .single();
    if (error) throw error;
    state.household = data;
    toast("Household saved.");
    render();
  } catch (error) {
    handleError(error, "Could not save household.");
  } finally {
    setButtonLoading(button, false, "Save Household", "Saving...");
  }
}

async function createHouseholdInvite() {
  if (!isOwner()) return toast("Only household owners can invite members.", "error");
  const button = $("#invite-member");
  setButtonLoading(button, true, "Invite Household Member", "Creating invite...");
  try {
    const { data, error } = await supabase
      .from("household_invites")
      .insert({
        household_id: state.profile.household_id,
        invited_by: state.profile.id,
      })
      .select("*")
      .single();
    if (error) throw error;
    state.householdInvites = [data, ...state.householdInvites];
    render();
    const link = inviteLink(data.invite_token);
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link created and copied.");
    } catch {
      toast("Invite link created. Copy it from Settings.");
    }
  } catch (error) {
    handleError(error, "Could not create invite.");
  } finally {
    setButtonLoading(button, false, "Invite Household Member", "Creating invite...");
  }
}

async function removeHouseholdMember(memberId) {
  const member = state.householdMembers.find((item) => item.id === memberId);
  if (!member) return;
  if (!confirm(`Remove ${memberDisplayName(member.user)} from this household?`)) return;
  try {
    const { error } = await supabase.rpc("remove_household_member", { member_row_id: memberId });
    if (error) throw error;
    await refreshAll({ quiet: true });
    toast("Member removed.");
  } catch (error) {
    handleError(error, "Could not remove member.");
  }
}

function openModal(title, body, options = {}) {
  closeModal();
  setOverlayOpen(true);
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop">
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="sheet-head"><h2>${escapeHtml(title)}</h2><button class="ghost-icon js-close-modal" aria-label="Close">×</button></div>
      <div class="sheet-body">${body}<p class="form-message" id="modal-message"></p></div>
      ${options.footer === false ? "" : `<div class="sheet-foot">
        <button class="secondary js-cancel-modal">Cancel</button>
        <button class="primary" id="modal-save">${escapeHtml(options.saveLabel || "Save")}</button>
      </div>`}
    </section>
  </div>`;
  $(".js-close-modal", root)?.addEventListener("click", closeModal);
  $(".js-cancel-modal", root)?.addEventListener("click", closeModal);
  $(".modal-backdrop", root)?.addEventListener("click", (event) => {
    if (event.target.classList.contains("modal-backdrop")) closeModal();
  });
  document.addEventListener("keydown", escapeModal);
}

function escapeModal(event) {
  if (event.key === "Escape") closeModal();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
  setOverlayOpen(false);
  document.removeEventListener("keydown", escapeModal);
}

function setOverlayOpen(isOpen) {
  state.overlayOpen = isOpen;
  document.body.classList.toggle("modal-open", isOpen);
  $("#bottom-nav")?.classList.toggle("hidden-down", isOpen);
  $("#fab")?.classList.toggle("hidden-down", isOpen);
}

function openQuickAdd() {
  openModal("Quick Add", `<div class="choice-grid">
    <button class="choice" data-quick-type="task"><span>✓</span>Task</button>
    <button class="choice" data-quick-type="reminder"><span>◷</span>Reminder</button>
    <button class="choice" data-quick-type="event"><span>□</span>Event</button>
    <button class="choice" data-quick-type="bill"><span>$</span>Bill</button>
    <button class="choice" data-quick-type="routineItem"><span>↻</span>Routine Item</button>
  </div>`, { footer: false });
  $$("[data-quick-type]").forEach((button) => button.addEventListener("click", () => openEditor(button.dataset.quickType, null, {
    date: state.tab === "calendar" ? state.selectedDate : todayString(),
  })));
}

function field(name, label, type = "text", value = "", options = {}) {
  if (type === "textarea") return `<label>${label}<textarea name="${name}" ${options.required ? "required" : ""}>${escapeHtml(value || "")}</textarea></label>`;
  if (type === "select") return `<label>${label}<select name="${name}">${options.values.map((entry) => {
    const [stored, shown = stored] = Array.isArray(entry) ? entry : [entry, entry];
    return `<option value="${escapeHtml(stored)}" ${stored === value ? "selected" : ""}>${escapeHtml(shown)}</option>`;
  }).join("")}</select></label>`;
  return `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value || "")}" ${options.step ? `step="${options.step}"` : ""} ${options.required ? "required" : ""} /></label>`;
}

function legacyAssigneeToUserId(value) {
  if (!value || value === "Shared") return "";
  const lower = String(value).toLowerCase();
  const match = state.householdMembers.find((member) => {
    const user = member.user || {};
    return String(user.role || "").toLowerCase() === lower
      || String(user.name || "").toLowerCase() === lower
      || String(user.display_name || "").toLowerCase() === lower;
  });
  return match?.user_id || "";
}

function commonAssignee(itemOrValue = null) {
  const selected = typeof itemOrValue === "object" && itemOrValue
    ? (itemOrValue.assigned_user_id || legacyAssigneeToUserId(itemOrValue.assigned_to))
    : legacyAssigneeToUserId(itemOrValue || "Shared");
  const values = [["", "Everyone"], ...state.householdMembers.map((member) => [member.user_id, memberDisplayName(member.user)])];
  return field("assigned_user_id", "Assigned to", "select", selected, { values });
}

function openEditor(type, item = null, options = {}) {
  if (type === "routine") return openRoutineEditor(item);
  if (type === "routineItem") return openRoutineItemEditor();
  const todayDefault = safeDateString(options.date || (state.tab === "calendar" ? state.selectedDate : todayString()));
  const forms = {
    weeklyItem: () => `<form id="editor-form">
      ${field("title", "Title", "text", item?.title, { required: true })}
      ${field("item_type", "Type", "select", item?.item_type || "priority", { values: ["priority", "chore", "bill", "meal", "appointment", "shopping", "note"] })}
      <div class="form-grid">${field("scheduled_date", "Date", "date", item?.scheduled_date)}${field("scheduled_time", "Time (optional)", "time", item?.scheduled_time)}</div>
      ${commonAssignee(item)}
    </form>`,
    task: () => `
      <form id="editor-form">
        ${field("title", "Task title", "text", item?.title, { required: true })}
        ${field("description", "Description", "textarea", item?.description)}
        ${commonAssignee(item)}
        <div class="form-grid">${field("due_date", "Due date", "date", item?.due_date || todayDefault)}${field("due_time", "Due time", "time", item?.due_time)}</div>
        ${reminderField(item)}
        <div class="form-grid">${field("priority", "Priority", "select", item?.priority || "Medium", { values: ["Low", "Medium", "High"] })}${field("category", "Category", "text", item?.category)}</div>
        ${field("repeat", "Repeat", "select", item?.repeat || "none", { values: ["none", "daily", "weekly", "monthly"] })}
      </form>`,
    reminder: () => `
      <form id="editor-form">
        ${field("title", "Reminder title", "text", item?.title, { required: true })}
        ${commonAssignee(item)}
        <div class="form-grid">${field("reminder_date", "Date", "date", item?.reminder_date || todayDefault, { required: true })}${field("reminder_time", "Time", "time", item?.reminder_time)}</div>
        ${field("priority", "Priority", "select", item?.priority || "Medium", { values: ["Low", "Medium", "High"] })}
        ${field("notes", "Notes", "textarea", item?.notes)}
      </form>`,
    event: () => `
      <form id="editor-form">
        ${field("title", "Event title", "text", item?.title, { required: true })}
        ${field("event_date", "Start Date", "date", item?.event_date || todayDefault, { required: true })}
        ${field("end_date", "End Date (optional)", "date", item?.end_date)}
        <div class="form-grid">${field("start_time", "Start time", "time", item?.start_time)}${field("end_time", "End time", "time", item?.end_time)}</div>
        ${reminderField(item)}
        ${commonAssignee(item)}
        <div class="form-grid">${field("location", "Location", "text", item?.location)}${field("category", "Category", "text", item?.category)}</div>
        ${field("notes", "Notes", "textarea", item?.notes)}
      </form>`,
    bill: () => `
      <form id="editor-form">
        ${field("name", "Bill name", "text", item?.name, { required: true })}
        <div class="form-grid">${field("amount", "Amount", "number", item?.amount, { step: "0.01" })}${field("due_date", "Due date", "date", item?.due_date || todayDefault, { required: true })}</div>
        ${commonAssignee(item)}
        <div class="form-grid">${field("repeat", "Repeat", "select", item?.repeat || "monthly", { values: ["none", "weekly", "monthly", "yearly"] })}${field("autopay", "Autopay", "select", String(item?.autopay ?? false), { values: [["false", "No"], ["true", "Yes"]] })}</div>
        ${field("notes", "Notes", "textarea", item?.notes)}
      </form>`,
  };
  if (!forms[type]) return;
  openModal(`${item ? "Edit" : "Add"} ${capitalize(type)}`, `${forms[type]()}
    ${item ? "" : `<label class="switch-row"><span>Save & Add Another</span><input id="add-another" type="checkbox" /></label>`}`);
  $("#modal-save").addEventListener("click", () => saveEditor(type, item));
  $("#editor-form input")?.focus();
}

function openRoutineItemEditor() {
  if (!state.data.routines.length) {
    toast("Add a routine before adding a routine item.", "error");
    state.tab = "routines";
    render();
    closeModal();
    return;
  }
  openModal("Add Routine Item", `<form id="editor-form">
    ${field("routine_id", "Routine", "select", state.data.routines[0].id, {
      values: state.data.routines.map((routine) => [routine.id, routine.name]),
    })}
    ${field("title", "Checklist item", "text", "", { required: true })}
  </form>`);
  $("#modal-save").addEventListener("click", saveRoutineItem);
}

async function saveRoutineItem() {
  const form = $("#editor-form");
  if (!form.reportValidity()) return;
  const values = formObject(form);
  const siblings = state.data.routine_items.filter((item) => item.routine_id === values.routine_id);
  const button = $("#modal-save");
  setButtonLoading(button, true, "Save", "Saving...");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const { error } = await supabase.from("routine_items").insert({
      id: id(),
      routine_id: values.routine_id,
      title: values.title,
      sort_order: siblings.length,
    });
    if (error) throw error;
    await refreshAll({ quiet: true });
    closeModal();
    toast("Routine item added.");
  } catch (error) {
    console.error("Routine item save failed", error);
    $("#modal-message").textContent = friendlyErrorMessage(error, "Could not save that checklist item.");
    setButtonLoading(button, false, "Save", "Saving...");
  }
}

function capitalize(value) {
  if (value === "weeklyItem") return "Scheduled item";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function saveEditor(type, item) {
  const form = $("#editor-form");
  if (!form.reportValidity()) return;
  const button = $("#modal-save");
  const message = $("#modal-message");
  setButtonLoading(button, true, "Save", "Saving...");
  button.disabled = true;
  button.textContent = "Saving…";
  message.textContent = "";
  const values = formObject(form);
  const addAnother = $("#add-another")?.checked;
  try {
    const table = itemTable(type);
    const payload = normalizePayload(type, values);
    if (type === "event" && payload.end_date && payload.end_date < payload.event_date) throw new Error("End Date cannot be before Start Date.");
    if (payload.reminder_minutes && (!(type === "task" ? payload.due_date && payload.due_time : payload.event_date && payload.start_time))) throw new Error("Choose a date and time for this reminder.");
    if (type === "weeklyItem") {
      delete payload.assigned_to;
      if (payload.scheduled_time && !payload.scheduled_date) throw new Error("Choose a date when setting a time.");
      if (!item) {
        let plan = state.data.weekly_plans.find((entry) => entry.week_start_date === weekStartString());
        if (!plan) {
          const result = await supabase.from("weekly_plans").upsert({ household_id: state.profile.household_id, week_start_date: weekStartString() }, { onConflict: "household_id,week_start_date" }).select().single();
          if (result.error) throw result.error;
          plan = result.data;
        }
        payload.weekly_plan_id = plan.id;
      }
    }
    let result;
    if (item) {
      payload.updated_at = new Date().toISOString();
      result = await supabase.from(table).update(payload).eq("id", item.id).eq("household_id", state.profile.household_id).select().single();
    } else {
      Object.assign(payload, {
        id: id(),
        household_id: state.profile.household_id,
        created_by: state.profile.id,
      });
      result = await supabase.from(table).insert(payload).select().single();
    }
    if (result.error) throw result.error;
    toast(`${capitalize(type)} ${item ? "updated" : "added"}.`);
    await refreshAll({ quiet: true });
    if (addAnother && !item) openEditor(type);
    else closeModal();
  } catch (error) {
    console.error(`${type} save failed`, error);
    message.textContent = friendlyErrorMessage(error, `Could not save this ${type}.`);
  } finally {
    if (document.contains(button)) {
      setButtonLoading(button, false, "Save", "Saving...");
    }
  }
}

function normalizePayload(type, values) {
  const clean = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === "" ? null : value]));
  if ("reminder_minutes" in clean) clean.reminder_minutes = clean.reminder_minutes == null ? null : Number(clean.reminder_minutes);
  if ("assigned_user_id" in clean) {
    const member = clean.assigned_user_id ? memberByUserId(clean.assigned_user_id) : null;
    clean.assigned_to = member ? (member.user.role || memberDisplayName(member.user)) : "Shared";
  }
  if (type === "bill") {
    clean.amount = clean.amount ? Number(clean.amount) : null;
    clean.autopay = clean.autopay === "true";
  }
  return clean;
}

function openRoutineEditor(routine = null) {
  const existingItems = routine
    ? state.data.routine_items
        .filter((item) => item.routine_id === routine.id)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    : [];
  const selectedDays = routine?.days_of_week || ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  openModal(`${routine ? "Edit" : "Add"} Routine`, `
    <form id="editor-form">
      ${field("name", "Routine name", "text", routine?.name, { required: true })}
      ${commonAssignee(routine)}
      <label>Days of week</label>
      <div class="days">${SHORT_DAYS.map((short, index) => `<button type="button" class="day-toggle ${selectedDays.includes(DAY_NAMES[index]) ? "active" : ""}" data-day="${DAY_NAMES[index]}">${short}</button>`).join("")}</div>
      <div class="form-grid">${field("time", "Optional time", "time", routine?.time)}${field("category", "Category", "text", routine?.category)}</div>
      ${field("active", "Status", "select", String(routine?.active ?? true), { values: [["true", "Active"], ["false", "Inactive"]] })}
      <label>Checklist items</label>
      <div id="routine-items" class="routine-items"></div>
      <button type="button" id="add-routine-item" class="soft-button wide">+ Add checklist item</button>
    </form>`);
  const itemContainer = $("#routine-items");
  const addRow = (value = "", itemId = "") => {
    const row = document.createElement("div");
    row.className = "routine-item-input";
    if (itemId) row.dataset.itemId = itemId;
    row.innerHTML = `<input class="routine-item-title" value="${escapeHtml(value)}" placeholder="Checklist item" /><button type="button" class="danger">×</button>`;
    $("button", row).addEventListener("click", () => {
      if (row.dataset.itemId && !confirm("Remove this checklist item? This will be deleted when you save the routine.")) return;
      row.remove();
    });
    itemContainer.append(row);
  };
  (existingItems.length ? existingItems : [{ title: "" }]).forEach((item) => addRow(item.title, item.id));
  $("#add-routine-item").addEventListener("click", () => addRow());
  $$(".day-toggle").forEach((button) => button.addEventListener("click", () => button.classList.toggle("active")));
  $("#modal-save").addEventListener("click", () => saveRoutine(routine));
}

async function saveRoutine(existing) {
  const form = $("#editor-form");
  if (!form.reportValidity()) return;
  const values = formObject(form);
  const selectedDays = $$(".day-toggle.active").map((button) => button.dataset.day);
  const itemRows = $$(".routine-item-input")
    .map((row) => ({
      id: row.dataset.itemId || null,
      title: $(".routine-item-title", row).value.trim(),
    }))
    .filter((item) => item.title);
  const payload = {
    name: values.name,
    assigned_user_id: values.assigned_user_id || null,
    assigned_to: values.assigned_user_id ? (memberByUserId(values.assigned_user_id)?.user?.role || memberDisplayName(memberByUserId(values.assigned_user_id)?.user || {})) : "Shared",
    days_of_week: selectedDays,
    time: values.time || null,
    category: values.category || null,
    active: values.active === "true",
    updated_at: new Date().toISOString(),
  };
  const button = $("#modal-save");
  const message = $("#modal-message");
  setButtonLoading(button, true, "Save", "Saving...");
  button.disabled = true;
  button.textContent = "Saving...";
  message.textContent = "";
  try {
    if (!payload.name?.trim()) throw new Error("Add a routine name before saving.");
    if (!selectedDays.length) throw new Error("Choose at least one day for this routine.");
    let routineId = existing?.id;
    if (existing) {
      const { error } = await supabase
        .from("routines")
        .update(payload)
        .eq("id", existing.id)
        .eq("household_id", state.profile.household_id)
        .select("id")
        .single();
      if (error) throw error;
    } else {
      routineId = id();
      const { error } = await supabase.from("routines").insert({
        ...payload,
        id: routineId,
        household_id: state.profile.household_id,
        created_by: state.profile.id,
      });
      if (error) throw error;
    }

    const existingItems = existing ? state.data.routine_items.filter((item) => item.routine_id === routineId) : [];
    const submittedExistingIds = new Set(itemRows.map((item) => item.id).filter(Boolean));
    const removedIds = existingItems.map((item) => item.id).filter((itemId) => !submittedExistingIds.has(itemId));
    if (removedIds.length) {
      const { error } = await supabase.from("routine_items").delete().in("id", removedIds);
      if (error) throw error;
    }

    const now = new Date().toISOString();
    const updates = itemRows
      .map((item, index) => ({ ...item, sort_order: index }))
      .filter((item) => item.id);
    await Promise.all(updates.map(async (item) => {
      const { error } = await supabase
        .from("routine_items")
        .update({ title: item.title, sort_order: item.sort_order, updated_at: now })
        .eq("id", item.id);
      if (error) throw error;
    }));

    const newItems = itemRows
      .map((item, index) => ({ ...item, sort_order: index }))
      .filter((item) => !item.id);
    if (newItems.length) {
      const { error } = await supabase.from("routine_items").insert(
        newItems.map((item) => ({ id: id(), routine_id: routineId, title: item.title, sort_order: item.sort_order }))
      );
      if (error) throw error;
    }

    await refreshAll({ quiet: true });
    closeModal();
    toast(`Routine ${existing ? "updated" : "added"}.`);
  } catch (error) {
    console.error("Routine save failed", error);
    message.textContent = friendlyErrorMessage(error, "Could not save this routine.");
  } finally {
    if (document.contains(button)) {
      setButtonLoading(button, false, "Save", "Saving...");
    }
  }
}

async function deleteItem(type, itemId) {
  const labels = {
    task: "Delete this task? This cannot be undone.",
    event: "Delete this event? This cannot be undone.",
    routine: "Delete this routine and its checklist items? This cannot be undone.",
    reminder: "Delete this reminder? This cannot be undone.",
    bill: "Delete this bill? This cannot be undone.",
  };
  if (!confirm(labels[type] || `Delete this ${type}? This cannot be undone.`)) return;
  const activeButton = document.activeElement?.matches?.(".js-delete") ? document.activeElement : null;
  if (activeButton) activeButton.disabled = true;
  try {
    const table = itemTable(type);
    const { error } = await supabase.from(table).delete().eq("id", itemId).eq("household_id", state.profile.household_id);
    if (error) throw error;
    state.data[table] = state.data[table].filter((item) => item.id !== itemId);
    if (type === "routine") state.data.routine_items = state.data.routine_items.filter((item) => item.routine_id !== itemId);
    navigator.serviceWorker?.controller?.postMessage({ type: "HOME_OPS_COMPLETED", sourceId: itemId, userId: state.profile.id });
    await syncBadge();
    render();
    toast(`${capitalize(type)} deleted.`);
    refreshAll({ quiet: true });
  } catch (error) {
    handleError(error, `Could not delete ${type}.`);
  } finally {
    if (activeButton && document.contains(activeButton)) activeButton.disabled = false;
  }
}

async function toggleComplete(type, itemId) {
  const table = itemTable(type);
  const item = state.data[table].find((entry) => entry.id === itemId);
  if (!item) return;
  const isComplete = type === "bill" ? item.status === "paid" : item.completed;
  const now = new Date().toISOString();
  const payload = type === "bill"
    ? { status: isComplete ? "unpaid" : "paid", paid_at: isComplete ? null : now, updated_at: now }
    : {
        completed: !isComplete,
        status: type === "event" ? (isComplete ? "scheduled" : "completed") : (isComplete ? "not_started" : "completed"),
        completed_at: isComplete ? null : now,
        completed_by: isComplete ? null : state.profile.id,
        updated_at: now,
      };
  if (type === "weeklyItem") delete payload.status;
  try {
    const { data, error } = await supabase.from(table).update(payload).eq("id", itemId).eq("household_id", state.profile.household_id).select().single();
    if (error) throw error;
    state.data[table] = state.data[table].map((entry) => entry.id === itemId ? data : entry);
    if (!isComplete) navigator.serviceWorker?.controller?.postMessage({ type: "HOME_OPS_COMPLETED", sourceId: itemId, userId: state.profile.id });
    await syncBadge();
    render();
    toast(`${capitalize(type)} ${isComplete ? "marked incomplete" : type === "bill" ? "paid" : "completed"}.`);
  } catch (error) {
    handleError(error, `Could not update ${type}.`);
  }
}

async function toggleRoutineItem(routineId, itemId) {
  const today = todayString();
  const completion = state.data.routine_completions.find(
    (item) => item.routine_item_id === itemId && item.completed_date === today
  );
  try {
    if (completion) {
      const { error } = await supabase.from("routine_completions").delete().eq("id", completion.id);
      if (error) throw error;
      state.data.routine_completions = state.data.routine_completions.filter((item) => item.id !== completion.id);
    } else {
      const payload = {
        id: id(),
        routine_id: routineId,
        routine_item_id: itemId,
        completed_date: today,
        completed_by: state.profile.id,
      };
      const { data, error } = await supabase.from("routine_completions").insert(payload).select().single();
      if (error) throw error;
      state.data.routine_completions.push(data);
    }
    render();
  } catch (error) {
    handleError(error, "Could not update the routine.");
  }
}

function generatedWeekContent() {
  const today = todayString();
  const inSevenDays = new Date();
  inSevenDays.setDate(inSevenDays.getDate() + 7);
  const end = formatLocalDate(inSevenDays);
  return {
    top_priorities: state.data.tasks.filter((item) => !item.completed && item.priority === "High").slice(0, 5).map((item) => `• ${item.title}`).join("\n"),
    chores: state.data.tasks.filter((item) => !item.completed && /chore|home|clean/i.test(item.category || "")).map((item) => `• ${item.title}`).join("\n"),
    bills_due: state.data.bills.filter((item) => item.status !== "paid" && item.due_date >= today && item.due_date <= end).map((item) => `• ${item.name} — ${formatDateOnly(item.due_date)}`).join("\n"),
    appointments: state.data.events.filter((item) => !item.completed && item.status !== "cancelled" && overlaps(item, today, end)).map((item) => `• ${item.title} — ${formatDateOnly(item.event_date)}${item.end_date ? ` - ${formatDateOnly(item.end_date)}` : ""}${item.start_time ? ` at ${formatTime12Hour(item.start_time)}` : ""}`).join("\n"),
  };
}

function generateWeek() {
  const generated = generatedWeekContent();
  Object.entries(generated).forEach(([key, value]) => {
    const input = $(`#week-${key}`);
    if (input && value) input.value = value;
  });
  toast("This week’s plan has been drafted.");
}

async function saveWeek() {
  const button = $("#save-week");
  setButtonLoading(button, true, "Save Plan", "Saving...");
  const existing = state.data.weekly_plans.find((item) => item.week_start_date === weekStartString());
  const fields = ["top_priorities", "chores", "bills_due", "meal_plan", "appointments", "shopping_list", "notes"];
  const payload = Object.fromEntries(fields.map((name) => [name, $(`#week-${name}`).value]));
  Object.assign(payload, { household_id: state.profile.household_id, week_start_date: weekStartString(), updated_at: new Date().toISOString() });
  try {
    const result = existing
      ? await supabase.from("weekly_plans").update(payload).eq("id", existing.id).eq("household_id", state.profile.household_id)
      : await supabase.from("weekly_plans").insert({ ...payload, id: id() });
    if (result.error) throw result.error;
    await refreshAll({ quiet: true });
    toast("Weekly plan saved.");
  } catch (error) {
    handleError(error, "Could not save the weekly plan.");
  } finally {
    setButtonLoading(button, false, "Save Plan", "Saving....");
  }
}

async function sendTestEmail() {
  const button = $("#test-email");
  setButtonLoading(button, true, "Send Test Email", "Sending...");
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const { data, error } = await supabase.functions.invoke("send-home-ops-email", {
      body: {
        to: state.profile.email,
        subject: "Home Ops Test Email",
        text: "Your Home Ops email notifications are connected.",
        test: true,
      },
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    toast("Test email sent.");
    await refreshAll({ quiet: true });
  } catch (error) {
    handleError(error, "Test email failed.");
  } finally {
    setButtonLoading(button, false, "Send Test Email", "Sending...");
  }
}

async function saveNotificationSettings() {
  const button = $("#save-notification-settings");
  setButtonLoading(button, true, "Save Notification Settings", "Saving...");
  button.disabled = true;
  button.textContent = "Saving…";
  const payload = {
    household_id: state.profile.household_id,
    in_app_enabled: $("#setting-in-app").checked,
    email_enabled: $("#setting-email").checked,
    sms_enabled: $("#setting-sms").checked,
    husband_email: $('[name="husband_email"]').value || null,
    wife_email: $('[name="wife_email"]').value || null,
    husband_phone: $('[name="husband_phone"]').value || null,
    wife_phone: $('[name="wife_phone"]').value || null,
    quiet_hours_start: $('[name="quiet_hours_start"]').value || null,
    quiet_hours_end: $('[name="quiet_hours_end"]').value || null,
    updated_at: new Date().toISOString(),
  };
  try {
    const { error } = await supabase.from("notification_settings").upsert(payload, { onConflict: "household_id" });
    if (error) throw error;
    state.data.notification_settings = payload;
    toast("Notification settings saved.");
  } catch (error) {
    handleError(error, "Could not save notification settings.");
  } finally {
    setButtonLoading(button, false, "Save Notification Settings", "Saving...");
  }
}

init();

