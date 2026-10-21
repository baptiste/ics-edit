import { openCalendar, eventModel, editEvent, addEvent, deleteEvent, individualEvents, zoneLabel } from "./editor.js";
import { createZip } from "./zip.js";

const $ = id => document.getElementById(id);
const fields = ["title", "start", "end", "zone", "allDay", "location", "description"];
const controls = Object.fromEntries(fields.map(name => [name, $(name === "allDay" ? "all-day" : name)]));
let calendar;
let filename;
let selected = 0;
let drafts = new Map();
let downloaded = "";
let originalSource = "";
let viewDate;
let agendaDates = [];

function showAgenda(followSelection = false) {
  const entries = calendar.events.map((_, index) => {
    const model = eventModel(calendar, index);
    return { index, model, values: drafts.get(index) || model.values };
  });
  agendaDates = [...new Set(entries.map(entry => entry.values.start.slice(0, 10))
    .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  const current = entries.find(entry => entry.index === selected)?.values.start.slice(0, 10);
  if (followSelection && agendaDates.includes(current)) viewDate = current;
  if (!agendaDates.includes(viewDate)) viewDate = agendaDates[0];
  $("agenda-heading").textContent = viewDate ? `Event agenda / ${viewDate}` : "No dated events";
  const position = agendaDates.indexOf(viewDate);
  $("previous-day").disabled = position <= 0;
  $("next-day").disabled = position < 0 || position >= agendaDates.length - 1;
  $("agenda-events").replaceChildren();
  const groups = new Map();
  for (const entry of entries.filter(entry => viewDate && entry.values.start.startsWith(viewDate))
    .sort((a, b) => Number(b.values.allDay) - Number(a.values.allDay) || a.values.start.localeCompare(b.values.start))) {
    const key = entry.values.allDay ? "All day" : entry.values.start.slice(11);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const timeLabel = value => value.slice(11).replace(/:00$/, "");
  for (const [time, group] of groups) {
    const row = document.createElement("div");
    row.className = "agenda-row";
    const label = document.createElement("div");
    label.className = "agenda-time";
    label.textContent = time === "All day" ? time : time.replace(/:00$/, "");
    const cards = document.createElement("div");
    cards.className = "agenda-cards";
    for (const { index, model, values } of group) {
      const card = document.createElement("article");
      card.className = "agenda-card";
      card.classList.toggle("selected-event", index === selected);
      const title = document.createElement("h3");
      title.textContent = values.title || "(Untitled event)";
      title.title = title.textContent;
      const detail = document.createElement("p");
      const startZone = values.zone === "keep" ? model.startZone : values.zone;
      const endZone = values.zone === "keep" ? model.endZone : values.zone;
      const zoneSuffix = key => key && key !== "floating" && key !== "date" ? ` ${zoneLabel(key)}` : "";
      const differentZones = values.end && startZone !== endZone;
      const time = values.allDay
        ? `All day${values.end ? ` / until ${values.end} (exclusive)` : ""}`
        : `${timeLabel(values.start)}${differentZones ? zoneSuffix(startZone) : ""}${values.end ? ` - ${values.end.startsWith(viewDate) ? timeLabel(values.end) : values.end.replace("T", " ")}${zoneSuffix(endZone)}` : `${zoneSuffix(startZone)} / no explicit end`}`;
      detail.textContent = `${time}${values.location ? ` | ${values.location}` : ""}`;
      detail.title = detail.textContent;
      card.append(title, detail);
      cards.append(card);
    }
    row.append(label, cards);
    $("agenda-events").append(row);
  }
  const undated = entries.filter(entry => !entry.values.start).length;
  $("undated-events").textContent = undated ? `${undated} event(s) without a usable start date are not shown here; they remain available in the editor.` : "";
}

for (const [id, direction] of [["previous-day", -1], ["next-day", 1]]) {
  $(id).addEventListener("click", () => {
    viewDate = agendaDates[agendaDates.indexOf(viewDate) + direction];
    showAgenda();
  });
}

function showError(error) {
  $("error").textContent = error.message;
  $("error").hidden = false;
  $("error").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clearError() {
  $("error").hidden = true;
  $("error").textContent = "";
}

function readValues() {
  const values = Object.fromEntries(fields.map(name => [
    name, name === "allDay" ? controls[name].checked : controls[name].value,
  ]));
  if (!values.allDay) {
    for (const name of ["start", "end"]) {
      if (values[name].length === 16) values[name] += ":00";
    }
  }
  return values;
}

function stage() {
  if (calendar && selected >= 0) drafts.set(selected, readValues());
}

function changedEntries() {
  return [...drafts].filter(([index, values]) => {
    const original = eventModel(calendar, index).values;
    return fields.some(name => values[name] !== original[name]);
  });
}

function draftSignature() {
  return JSON.stringify([calendar.source, changedEntries().sort(([a], [b]) => a - b)]);
}

function hasUndownloadedChanges() {
  return calendar && (calendar.source !== originalSource || changedEntries().length > 0) &&
    draftSignature() !== downloaded;
}

function updateStatus() {
  const count = changedEntries().length;
  $("draft-status").textContent = calendar.source !== originalSource
    ? "Calendar changed"
    : count ? `${count} edited event${count === 1 ? "" : "s"}` : "No changes";
}

function dateControls(allDay) {
  for (const name of ["start", "end"]) {
    controls[name].type = allDay ? "date" : "datetime-local";
    controls[name].step = "1";
  }
  controls.zone.disabled = allDay || eventModel(calendar, selected).recurring;
  $("end-label").textContent = allDay ? "End date (exclusive, optional)" : "End (optional)";
  $("end-help").textContent = allDay
    ? "The end is the first day NOT included. For a one-day event, choose the following day or leave it empty."
    : "An empty end keeps the event without an explicit end. Existing duration is preserved.";
}

function displayEvent(index) {
  selected = calendar.events.length ? index : -1;
  const empty = selected < 0;
  $("event-fields").hidden = empty;
  $("empty-calendar").hidden = !empty;
  $("delete-event").disabled = empty;
  $("reset").disabled = empty;
  $("event-picker").hidden = calendar.events.length <= 1;
  $("warnings").hidden = true;
  clearError();
  if (empty) {
    updateStatus();
    showAgenda();
    return;
  }
  const model = eventModel(calendar, index);
  const values = drafts.get(index) || model.values;
  $("dates").disabled = !model.editableDates;
  controls.allDay.disabled = model.recurring || !model.editableDates;
  controls.zone.replaceChildren();
  for (const [value, label] of [
    ["keep", "Keep original time zones"],
    ["floating", zoneLabel("floating")],
    ["utc", "UTC"],
    ...model.zones.map(key => [key, zoneLabel(key)]),
  ]) {
    controls.zone.add(new Option(label, value));
  }
  dateControls(values.allDay);
  for (const name of fields) {
    if (name === "allDay") controls[name].checked = values[name];
    else controls[name].value = values[name];
  }
  $("zone-summary").textContent = `Original values / ${model.zoneSummary}`;
  $("warning-list").replaceChildren();
  for (const warning of model.warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    $("warning-list").append(li);
  }
  $("warnings").hidden = !model.warnings.length;
  $("event").value = String(index);
  clearError();
  updateStatus();
  showAgenda(true);
}

function refreshEventOptions() {
  $("event").replaceChildren();
  calendar.events.forEach((event, index) => {
    const exception = event.hasProperty("recurrence-id") ? " [recurrence exception]" : "";
    const values = drafts.get(index) || eventModel(calendar, index).values;
    $("event").add(new Option(
      `${index + 1}. ${values.title || "(Untitled event)"}${exception} - ${values.start || "No start"}`,
      String(index),
    ));
  });
  $("file-status").textContent = `${filename} / ${calendar.events.length} event${calendar.events.length === 1 ? "" : "s"}`;
}

$("file").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  stage();
  if (hasUndownloadedChanges() &&
      !confirm("Open a different file and discard edits that have not been downloaded?")) {
    event.target.value = "";
    return;
  }
  clearError();
  event.target.disabled = true;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error("This file is larger than the 10 MB limit.");
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
    const loaded = openCalendar(source);
    // Check models before replacing a previously opened file.
    loaded.events.forEach((_, index) => eventModel(loaded, index));
    calendar = loaded;
    filename = file.name;
    drafts = new Map();
    originalSource = loaded.source;
    downloaded = draftSignature();
    refreshEventOptions();
    $("editor").hidden = false;
    $("calendar-preview").hidden = false;
    viewDate = undefined;
    $("download-status").textContent = "";
    displayEvent(0);
  } catch (error) {
    showError(new Error(`Could not open file: ${error.message}`));
  } finally {
    event.target.disabled = false;
    event.target.value = "";
  }
});

$("event").addEventListener("change", event => {
  const index = Number(event.target.value);
  stage();
  refreshEventOptions();
  displayEvent(index);
});

$("add-event").addEventListener("click", () => {
  stage();
  try {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    calendar = openCalendar(addEvent(calendar, {
      title: "New event", location: "", description: "",
      start: `${date}T09:00:00`, end: `${date}T10:00:00`, allDay: false, zone: "floating",
    }));
    refreshEventOptions();
    displayEvent(calendar.events.length - 1);
    controls.title.focus();
    controls.title.select();
    $("download-status").textContent = "";
  } catch (error) {
    showError(error);
  }
});

$("delete-event").addEventListener("click", () => {
  if (selected < 0) return;
  stage();
  const title = drafts.get(selected).title || "(Untitled event)";
  if (!confirm(`Delete "${title}" from the downloaded copy? If this is a recurring master, all occurrences represented by its rule are removed. Separate exceptions are preserved.`)) return;
  try {
    calendar = openCalendar(deleteEvent(calendar, selected));
    drafts = new Map([...drafts].filter(([index]) => index !== selected)
      .map(([index, values]) => [index > selected ? index - 1 : index, values]));
    refreshEventOptions();
    displayEvent(Math.min(selected, calendar.events.length - 1));
    $("download-status").textContent = "";
  } catch (error) {
    showError(error);
  }
});

controls.allDay.addEventListener("change", () => {
  const allDay = controls.allDay.checked;
  const old = { start: controls.start.value, end: controls.end.value };
  dateControls(allDay);
  for (const name of ["start", "end"]) {
    controls[name].value = !old[name] ? "" : allDay ? old[name].slice(0, 10) : `${old[name]}T00:00:00`;
  }
  if (!allDay) controls.zone.value = "floating";
  stage();
  updateStatus();
  showAgenda(true);
});

$("event-form").addEventListener("input", () => {
  stage();
  updateStatus();
  clearError();
  $("download-status").textContent = "";
  showAgenda();
});

$("reset").addEventListener("click", () => {
  drafts.delete(selected);
  refreshEventOptions();
  displayEvent(selected);
  $("download-status").textContent = "";
});

function download(asZip) {
  stage();
  clearError();
  $("download-status").textContent = "";
  try {
    let output = calendar.source;
    for (const [index, values] of changedEntries()) {
      try {
        output = editEvent(openCalendar(output), index, values);
      } catch (error) {
        displayEvent(index);
        throw new Error(`Event ${index + 1}: ${error.message}`);
      }
    }
    const base = filename.replace(/\.ics$/i, "");
    const name = asZip ? `${base}-events.zip` : `${base}-edited.ics`;
    const blob = asZip ? createZip(individualEvents(openCalendar(output)))
      : new Blob([output], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    downloaded = draftSignature();
    $("download-status").textContent = `Download prepared: ${name}`;
  } catch (error) {
    showError(error);
  }
}

$("event-form").addEventListener("submit", event => {
  event.preventDefault();
  download(false);
});

$("download-zip").addEventListener("click", () => download(true));

window.addEventListener("beforeunload", event => {
  stage();
  if (hasUndownloadedChanges()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
