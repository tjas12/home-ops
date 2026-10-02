import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CONFIG_ERROR = "Supabase is not configured. Check your environment variables.";
const cfg = window.HOME_OPS_CONFIG || {};
const supabaseUrl = String(cfg.supabaseUrl || cfg.VITE_SUPABASE_URL || "").trim();
const supabaseAnonKey = String(cfg.supabaseAnonKey || cfg.VITE_SUPABASE_ANON_KEY || "").trim();
const missingConfig = !supabaseUrl || !supabaseAnonKey || supabaseUrl.includes("YOUR_") || supabaseAnonKey.includes("YOUR_");
if (missingConfig) console.error("[Home Ops] Missing Supabase config", { hasUrl: Boolean(supabaseUrl), hasAnonKey: Boolean(supabaseAnonKey) });
const supabase = missingConfig ? null : createClient(supabaseUrl, supabaseAnonKey);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const today = () => new Date().toISOString().slice(0, 10);
const id = () => crypto.randomUUID();
const state = { tab: "today", session: null, profile: null, loading: false, tasks: [], events: [], routines: [] };

function safe(text = "") { return String(text).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[c])); }
function niceDate(value) { return value ? new Date(`${value}T00:00:00`).toLocaleDateString([], { month: "short", day: "numeric" }) : "No date"; }
function toast(message, type = "success") { const el = document.createElement("div"); el.className = `toast ${type}`; el.textContent = message; $("#toast-root").append(el); setTimeout(() => el.remove(), 3000); }
function errorMessage(error) { const msg = String(error?.message || error || "Something went wrong.").toLowerCase(); if (msg.includes("invalid")) return "Email or password is incorrect."; if (msg.includes("fetch") || msg.includes("network")) return "Network problem. Please try again."; if (msg.includes("permission") || msg.includes("row-level")) return "You do not have permission to make that change."; return "Something went wrong. Please try again."; }
function setBusy(button, busy, label = "Save") { if (!button) return; button.disabled = busy; button.textContent = busy ? "Working..." : label; }

function requireConfig() { if (supabase) return true; const msg = $("#auth-message"); if (msg) msg.textContent = CONFIG_ERROR; return false; }
async function init() {
  bindShell();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.error);
  if (!requireConfig()) return;
  $("#auth-message").textContent = "Checking your session...";
  const { data, error } = await supabase.auth.getSession();
  if (error) console.error("Session restore failed", error);
  await applySession(data?.session || null);
  supabase.auth.onAuthStateChange((_event, session) => setTimeout(() => applySession(session), 0));
}

function bindShell() {
  $("#login-form").addEventListener("submit", login);
  $("#bottom-nav").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (!b) return; state.tab = b.dataset.tab; render(); });
  $("#header-add").addEventListener("click", quickAdd);
  $("#fab").addEventListener("click", quickAdd);
}

async function login(event) {
  event.preventDefault();
  if (!requireConfig()) return;
  const button = event.submitter;
  const msg = $("#auth-message");
  msg.textContent = "";
  setBusy(button, true, "Sign in");
  try {
    const { error } = await supabase.auth.signInWithPassword({ email: $("#login-email").value.trim(), password: $("#login-password").value });
    if (error) throw error;
  } catch (error) {
    console.error("Login failed", error);
    msg.textContent = errorMessage(error);
  } finally { setBusy(button, false, "Sign in"); }
}

async function applySession(session) {
  state.session = session;
  if (!session) { state.profile = null; $("#auth-view").classList.remove("hidden"); $("#shell").classList.add("hidden"); $("#auth-message").textContent = ""; return; }
  const { data, error } = await supabase.from("users").select("*").eq("id", session.user.id).maybeSingle();
  if (error || !data?.household_id) { console.error("Profile load failed", error); await supabase.auth.signOut(); $("#auth-message").textContent = "This Home Ops dashboard is private."; return; }
  state.profile = data;
  $("#auth-view").classList.add("hidden"); $("#shell").classList.remove("hidden");
  await refresh();
}

async function refresh() {
  if (!state.profile?.household_id) return;
  state.loading = true; render();
  try {
    const h = state.profile.household_id;
    const [tasks, events, routines] = await Promise.all([
      supabase.from("tasks").select("*").eq("household_id", h).order("due_date", { ascending: true, nullsFirst: false }),
      supabase.from("events").select("*").eq("household_id", h).order("event_date", { ascending: true }),
      supabase.from("routines").select("*").eq("household_id", h).order("created_at"),
    ]);
    for (const result of [tasks, events, routines]) if (result.error) throw result.error;
    state.tasks = tasks.data || []; state.events = events.data || []; state.routines = routines.data || [];
  } catch (error) { console.error("Refresh failed", error); toast(errorMessage(error), "error"); }
  finally { state.loading = false; render(); }
}

function render() {
  if (!state.profile) return;
  const titles = { today: "Today", tasks: "Tasks", calendar: "Calendar", routines: "Routines", weekly: "Weekly Reset", settings: "Settings" };
  $("#page-title").textContent = titles[state.tab];
  $$("#bottom-nav [data-tab]").forEach(b => b.classList.toggle("active", b.dataset.tab === state.tab));
  $("#fab").classList.toggle("hidden", state.tab === "settings");
  const views = { today: todayView, tasks: tasksView, calendar: eventsView, routines: routinesView, weekly: weeklyView, settings: settingsView };
  $("#page").innerHTML = state.loading ? `<section class="card loading-card"><div class="spinner"></div><div><h2>Loading Home Ops</h2><p class="muted-copy">Getting the latest household info...</p></div></section>` : views[state.tab]();
  bindPage();
}

function card(type, item) {
  const date = item.due_date || item.event_date;
  const done = item.completed || item.status === "completed";
  return `<article class="card item-card ${done ? "completed" : ""}">
    ${type === "routine" ? "<span></span>" : `<button class="check ${done ? "checked" : ""}" data-toggle="${type}" data-id="${item.id}">${done ? "✓" : ""}</button>`}
    <div><p class="item-title">${safe(item.title || item.name)}</p><div class="meta"><span class="pill">${type === "routine" ? safe((item.days_of_week || []).join(", ") || "Routine") : niceDate(date)}</span><span class="pill">${safe(item.assigned_to || "Shared")}</span></div></div>
    <div class="actions"><button class="ghost-icon" data-delete="${type}" data-id="${item.id}" aria-label="Delete">🗑</button></div>
  </article>`;
}
function empty(copy, action) { return `<div class="empty"><p>${copy}</p><button class="soft-button" data-add>${action}</button></div>`; }
function todayView() { const t = state.tasks.filter(x => !x.completed).slice(0, 5); const e = state.events.filter(x => x.event_date >= today()).slice(0, 5); return `<section class="hero"><p class="date">${new Date().toLocaleDateString([], { weekday:"long", month:"long", day:"numeric" })}</p><h2>Welcome home.</h2><p>${t.length} open tasks · ${e.length} upcoming events</p></section><section class="section"><div class="section-head"><h2>Up next</h2><span class="count">${t.length + e.length}</span></div><div class="stack">${[...t.map(x => card("task", x)), ...e.map(x => card("event", x))].join("") || empty("Nothing urgent yet. Add the first thing to track.", "Add first item")}</div></section>`; }
function tasksView() { return `<section class="section"><div class="section-head"><h2>Tasks</h2><button class="soft-button" data-add>Add task</button></div><div class="stack">${state.tasks.map(x => card("task", x)).join("") || empty("No tasks yet.", "Add your first task")}</div></section>`; }
function eventsView() { return `<section class="section"><div class="section-head"><h2>Events</h2><button class="soft-button" data-add>Add event</button></div><div class="stack">${state.events.map(x => card("event", x)).join("") || empty("No events on the calendar yet.", "Add your first event")}</div></section>`; }
function routinesView() { return `<section class="section"><div class="section-head"><h2>Routines</h2><button class="soft-button" data-add>Add routine</button></div><div class="stack">${state.routines.map(x => card("routine", x)).join("") || empty("No routines yet.", "Create a routine")}</div></section>`; }
function weeklyView() { return `<section class="card"><h2>Weekly reset</h2><p class="muted-copy">For now, use this space as a simple review: check open tasks, upcoming events, and routines for the week.</p><button class="primary" data-tab-jump="tasks">Review tasks</button></section>`; }
function settingsView() { return `<section class="card"><h2>Account</h2><p class="muted-copy">Signed in as ${safe(state.profile.email || state.session.user.email)}</p><button id="logout" class="danger wide">Log out</button></section><section class="card"><h2>Household settings</h2><p class="muted-copy">Shared preferences and notifications are coming next.</p></section>`; }

function bindPage() {
  $$('[data-add]').forEach(b => b.addEventListener('click', quickAdd));
  $$('[data-delete]').forEach(b => b.addEventListener('click', () => removeItem(b.dataset.delete, b.dataset.id)));
  $$('[data-toggle]').forEach(b => b.addEventListener('click', () => toggleComplete(b.dataset.toggle, b.dataset.id)));
  $('[data-tab-jump]')?.addEventListener('click', e => { state.tab = e.target.dataset.tabJump; render(); });
  $('#logout')?.addEventListener('click', () => supabase.auth.signOut());
}

async function quickAdd() {
  const type = state.tab === "calendar" ? "event" : state.tab === "routines" ? "routine" : "task";
  const title = prompt(`Add ${type}:`);
  if (!title?.trim()) return;
  const base = { household_id: state.profile.household_id, created_by: state.profile.id, assigned_to: "Shared" };
  const payloads = {
    task: { ...base, title: title.trim(), due_date: today(), priority: "Medium", status: "not_started", completed: false },
    event: { ...base, title: title.trim(), event_date: prompt("Event date (YYYY-MM-DD):", today()) || today(), status: "scheduled", completed: false },
    routine: { ...base, name: title.trim(), days_of_week: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], active: true },
  };
  try { const { error } = await supabase.from(`${type}s`).insert({ id: id(), ...payloads[type] }); if (error) throw error; toast(`${type[0].toUpperCase() + type.slice(1)} added.`); await refresh(); }
  catch (error) { console.error(`${type} add failed`, error); toast(errorMessage(error), "error"); }
}

async function removeItem(type, itemId) {
  if (!confirm(`Delete this ${type}? This cannot be undone.`)) return;
  try { const { error } = await supabase.from(`${type}s`).delete().eq("id", itemId).eq("household_id", state.profile.household_id); if (error) throw error; toast("Deleted."); await refresh(); }
  catch (error) { console.error(`${type} delete failed`, error); toast(errorMessage(error), "error"); }
}

async function toggleComplete(type, itemId) {
  const list = type === "event" ? state.events : state.tasks;
  const item = list.find(x => x.id === itemId); if (!item) return;
  const done = !item.completed;
  const patch = type === "event" ? { completed: done, status: done ? "completed" : "scheduled", completed_at: done ? new Date().toISOString() : null, completed_by: done ? state.profile.id : null } : { completed: done, status: done ? "completed" : "not_started", completed_at: done ? new Date().toISOString() : null, completed_by: done ? state.profile.id : null };
  try { const { error } = await supabase.from(`${type}s`).update(patch).eq("id", itemId).eq("household_id", state.profile.household_id); if (error) throw error; await refresh(); }
  catch (error) { console.error(`${type} update failed`, error); toast(errorMessage(error), "error"); }
}

init();
