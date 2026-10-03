const chunkFiles = [
  "./app.bundle.001.b64",
  "./app.bundle.002.b64",
  "./app.bundle.003.b64",
  "./app.bundle.004.b64",
  "./app.bundle.005.b64",
  "./app.bundle.006.b64",
  "./app.bundle.007.b64",
  "./app.bundle.008.b64",
  "./app.bundle.009.b64",
  "./app.bundle.010.b64",
];

function replaceOnce(source, before, after) {
  return source.includes(after) ? source : source.replace(before, after);
}

function patchHomeOpsSource(source) {
  source = replaceOnce(
    source,
    '  authMode: "login",\r\n  tab: "today",',
    '  authMode: "login",\r\n  upcomingEventDays: 14,\r\n  tab: "today",'
  );

  source = replaceOnce(
    source,
    '  $("#calendar-next")?.addEventListener("click", () => changeMonth(1));',
    '  $("#calendar-next")?.addEventListener("click", () => changeMonth(1));\r\n  $("#upcoming-event-range")?.addEventListener("change", (event) => {\r\n    state.upcomingEventDays = Number(event.target.value) || 14;\r\n    render();\r\n  });'
  );

  source = replaceOnce(
    source,
    '  const time = item.due_time || item.reminder_time || item.start_time;\r\n  const priority = item.priority || item.category;',
    '  const time = item.due_time || item.reminder_time || item.start_time;\r\n  const dateLabel = type === "event" && item.event_date && item.end_date && item.end_date !== item.event_date\r\n    ? \`${formatDateOnly(item.event_date)} – ${formatDateOnly(item.end_date)}\`\r\n    : (date ? formatDateOnly(date) : "");\r\n  const priority = item.priority || item.category;'
  );

  source = replaceOnce(
    source,
    '          ${date ? \`<span>${formatDateOnly(date)}${time ? \` · ${formatTime12Hour(time)}\` : ""}</span>\` : ""}',
    '          ${dateLabel ? \`<span>${dateLabel}${time ? \` · ${formatTime12Hour(time)}\` : ""}</span>\` : ""}'
  );

  source = replaceOnce(
    source,
    '  const dueTasks = state.data.tasks.filter((item) => item.due_date === today && !item.completed);\r\n  const reminders = state.data.reminders.filter((item) => item.reminder_date === today && !item.completed);\r\n  const events = state.data.events.filter((item) => item.event_date === today && !item.completed);',
    '  const dueTasks = state.data.tasks.filter((item) => item.due_date === today && !item.completed);\r\n  const reminders = state.data.reminders.filter((item) => item.reminder_date === today && !item.completed);\r\n  const upcomingEndDate = new Date();\r\n  upcomingEndDate.setDate(upcomingEndDate.getDate() + state.upcomingEventDays - 1);\r\n  const upcomingEnd = formatLocalDate(upcomingEndDate);\r\n  const events = state.data.events.filter((item) => !item.completed && item.event_date <= upcomingEnd && (item.end_date || item.event_date) >= today).sort((a, b) => (a.event_date || "").localeCompare(b.event_date || "") || (a.start_time || "").localeCompare(b.start_time || ""));'
  );

  source = replaceOnce(
    source,
    '    ${section("Upcoming Events", events, (item) => itemCard("event", item), emptyState("No events today. Add one from Calendar when plans come up.", "event", "Add an event"))}',
    '    <section class="section"><div class="section-head"><h2>Upcoming Events</h2><div class="section-tools"><select id="upcoming-event-range" class="compact-select"><option value="14" ${state.upcomingEventDays === 14 ? "selected" : ""}>Next 2 Weeks</option><option value="30" ${state.upcomingEventDays === 30 ? "selected" : ""}>Next Month</option></select><span class="count">${events.length}</span></div></div><div class="stack">${events.length ? events.map((item) => itemCard("event", item)).join("") : emptyState("No events in this range. Add one from Calendar when plans come up.", "event", "Add an event")}</div></section>'
  );

  source = replaceOnce(
    source,
    'function renderCalendar() {',
    'function eventOccursOnDate(event, dateValue) {\r\n  if (!event?.event_date || !dateValue) return false;\r\n  return event.event_date <= dateValue && (event.end_date || event.event_date) >= dateValue;\r\n}\r\n\r\nfunction renderCalendar() {'
  );

  source = source
    .replaceAll('state.data.events.filter((event) => event.event_date === value)', 'state.data.events.filter((event) => eventOccursOnDate(event, value))')
    .replaceAll('state.data.events.filter((event) => event.event_date === state.selectedDate)', 'state.data.events.filter((event) => eventOccursOnDate(event, state.selectedDate))');

  source = replaceOnce(
    source,
    '        ${field("event_date", "Event date", "date", item?.event_date || todayDefault, { required: true })}\r\n        <div class="form-grid">${field("start_time", "Start time", "time", item?.start_time)}${field("end_time", "End time", "time", item?.end_time)}</div>',
    '        <div class="form-grid">${field("event_date", "Start date", "date", item?.event_date || todayDefault, { required: true })}${field("end_date", "End date (optional)", "date", item?.end_date)}</div>\r\n        <div class="form-grid">${field("start_time", "Start time", "time", item?.start_time)}${field("end_time", "End time", "time", item?.end_time)}</div>'
  );

  source = replaceOnce(
    source,
    '  if (type === "bill") {\r\n    clean.amount = clean.amount ? Number(clean.amount) : null;\r\n    clean.autopay = clean.autopay === "true";\r\n  }\r\n  return clean;',
    '  if (type === "event") {\r\n    if (clean.end_date && clean.event_date && clean.end_date < clean.event_date) throw new Error("End date cannot be before the start date.");\r\n    if (clean.end_date === clean.event_date) clean.end_date = null;\r\n  }\r\n  if (type === "bill") {\r\n    clean.amount = clean.amount ? Number(clean.amount) : null;\r\n    clean.autopay = clean.autopay === "true";\r\n  }\r\n  return clean;'
  );

  return source;
}

async function loadHomeOpsApp() {
  const chunks = await Promise.all(
    chunkFiles.map(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      if (!response.ok) throw new Error(`Unable to load ${path}`);
      return response.text();
    })
  );

  const base64 = chunks.join("").replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const source = patchHomeOpsSource(new TextDecoder().decode(bytes));
  const moduleUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  await import(moduleUrl);
}

loadHomeOpsApp().catch((error) => {
  console.error("[Home Ops] App failed to load.", error);
  const message = document.querySelector("#auth-message");
  if (message) message.textContent = "Home Ops could not load. Please refresh and try again.";
});
