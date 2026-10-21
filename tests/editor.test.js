import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openCalendar, eventModel, editEvent, addEvent, deleteEvent } from "../editor.js";

const wrap = (events, zones = "") => `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Editor Tests//EN\r
${zones}${events}END:VCALENDAR\r
`;
const event = (extra = "", dates = "DTSTART:20300915T090000Z\r\nDTEND:20300915T100000Z\r\n") =>
  `BEGIN:VEVENT\r\nUID:test-1\r\nDTSTAMP:20300101T000000Z\r\nSUMMARY:Original\r\n${dates}${extra}END:VEVENT\r\n`;
const zone = `BEGIN:VTIMEZONE\r
TZID:Test/Eastern\r
BEGIN:STANDARD\r
DTSTART:19701101T020000\r
TZOFFSETFROM:-0400\r
TZOFFSETTO:-0500\r
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r
END:STANDARD\r
BEGIN:DAYLIGHT\r
DTSTART:19700308T020000\r
TZOFFSETFROM:-0500\r
TZOFFSETTO:-0400\r
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r
END:DAYLIGHT\r
END:VTIMEZONE\r
`;
function edit(source, changes, index = 0) {
  const document = openCalendar(source);
  return editEvent(document, index, { ...eventModel(document, index).values, ...changes });
}

test("a no-op download is byte-for-byte unchanged, including BOM and folded lines", () => {
  const source = "\uFEFF" + wrap(event("X-CUSTOM:Original\r\n continuation\r\n"));
  assert.equal(edit(source, {}), source);
});

test("only changed text properties are replaced; other events, alarms, and metadata survive exactly", () => {
  const extras = `RRULE:FREQ=WEEKLY;COUNT=5\r
RDATE:20301001T090000Z\r
EXDATE:20300922T090000Z\r
ATTENDEE;CN="One, Two":mailto:person@example.org\r
X-CUSTOM;X-PARAM="value":keep this\r
BEGIN:VALARM\r
ACTION:DISPLAY\r
TRIGGER:-PT15M\r
DESCRIPTION:Remember\r
END:VALARM\r
`;
  const source = wrap(event(extras) + event("RECURRENCE-ID:20300922T090000Z\r\n"));
  const output = edit(source, { title: "Changed" });
  assert.equal(output, source.replace("SUMMARY:Original", "SUMMARY:Changed"));
  assert.ok(output.includes(extras));
});

test("text edits escape commas, semicolons, backslashes and newlines without property injection", () => {
  const title = "Tea, water; clay\\craft\nUID:not-a-property";
  const output = edit(wrap(event()), { title, description: "Line one\r\nLine two" });
  const document = openCalendar(output);
  assert.equal(document.events[0].getFirstPropertyValue("summary"), title);
  assert.equal(document.events[0].getFirstPropertyValue("description"), "Line one\nLine two");
  assert.equal(document.events[0].getFirstPropertyValue("uid"), "test-1");
  assert.equal(document.events[0].getAllProperties("uid").length, 1);
});

test("edited Unicode properties fold at 75 UTF-8 octets without splitting characters", () => {
  const title = "茶 🫖 Ōtautahi ".repeat(30);
  const output = edit(wrap(event()), { title });
  for (const line of output.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  assert.equal(openCalendar(output).events[0].getFirstPropertyValue("summary"), title);
});

test("property parameters survive edits and clearing an optional field removes just that property", () => {
  const source = wrap(event("DESCRIPTION;LANGUAGE=en:Before\r\nLOCATION:Somewhere\r\n"));
  const output = edit(source, { description: "After", location: "" });
  assert.ok(output.includes("DESCRIPTION;LANGUAGE=en:After\r\n"));
  assert.ok(!output.includes("LOCATION:"));
});

test("folded text properties are replaced as a unit, not left with stray continuations", () => {
  const source = wrap(event()).replace("SUMMARY:Original", "SUMMARY:An old\r\n folded title");
  assert.equal(edit(source, { title: "New" }), wrap(event()).replace("SUMMARY:Original", "SUMMARY:New"));
});

test("UTC stays UTC and changing only the start does not rewrite the end", () => {
  const source = wrap(event());
  assert.equal(edit(source, { start: "2030-09-15T09:15:00" }), source.replace("T090000Z", "T091500Z"));
});

test("floating times stay floating without device time-zone conversion", () => {
  const source = wrap(event("", "DTSTART:20300915T090000\r\nDTEND:20300915T100000\r\n"));
  const output = edit(source, { start: "2030-09-15T08:30:00" });
  assert.ok(output.includes("DTSTART:20300915T083000\r\n"));
  assert.ok(!output.includes("TZID"));
});

test("time-zone summaries avoid repeating matching start/end zones and explain unspecified zones", () => {
  const floating = wrap(event("", "DTSTART:20300915T090000\r\nDTEND:20300915T100000\r\n"));
  assert.equal(eventModel(openCalendar(floating), 0).zoneSummary, "Time zone: Unspecified (local clock time).");
  assert.equal(eventModel(openCalendar(wrap(event())), 0).zoneSummary, "Time zone: UTC.");
  const mixed = wrap(event("", "DTSTART;TZID=Test/Eastern:20300915T090000\r\nDTEND:20300915T140000Z\r\n"), zone);
  assert.equal(eventModel(openCalendar(mixed), 0).zoneSummary, "Start time zone: Test/Eastern; end time zone: UTC.");
});

test("embedded TZID rules and all unedited time-zone lines are preserved", () => {
  const source = wrap(event("", "DTSTART;TZID=Test/Eastern:20300915T090000\r\nDTEND;TZID=Test/Eastern:20300915T100000\r\n"), zone);
  const output = edit(source, { start: "2030-09-15T09:15:00" });
  assert.equal(output, source.replace("DTSTART;TZID=Test/Eastern:20300915T090000", "DTSTART;TZID=Test/Eastern:20300915T091500"));
});

test("changing a time zone reinterprets the wall clock, never silently converts it", () => {
  const source = wrap(event(), zone);
  const output = edit(source, { zone: "tzid:Test/Eastern" });
  assert.ok(output.includes("DTSTART;TZID=Test/Eastern:20300915T090000\r\n"));
  assert.ok(output.includes("DTEND;TZID=Test/Eastern:20300915T100000\r\n"));
});

test("different start/end zones are compared as instants, not as clock strings", () => {
  const source = wrap(event("", "DTSTART;TZID=Test/Eastern:20300915T090000\r\nDTEND:20300915T140000Z\r\n"), zone);
  assert.doesNotThrow(() => edit(source, { end: "2030-09-15T13:30:00" }));
  assert.throws(() => edit(source, { end: "2030-09-15T12:30:00" }), /end must be after/i);
});

test("missing TZID definitions warn and are preserved during text-only edits", () => {
  const source = wrap(event("", "DTSTART;TZID=Unknown/Zone:20300915T090000\r\nDTEND;TZID=Unknown/Zone:20300915T100000\r\n"));
  const document = openCalendar(source);
  assert.match(eventModel(document, 0).warnings.join(" "), /No embedded VTIMEZONE/);
  assert.equal(edit(source, { title: "New" }), source.replace("SUMMARY:Original", "SUMMARY:New"));
  assert.throws(() => edit(source, { start: "2030-09-15T09:15:00" }), /without an embedded VTIMEZONE/);
});

test("DST gaps and ambiguous clock times are blocked rather than silently adjusted", () => {
  const source = wrap(event("", "DTSTART;TZID=Test/Eastern:20300310T010000\r\nDTEND;TZID=Test/Eastern:20300310T040000\r\n"), zone);
  assert.throws(() => edit(source, { start: "2030-03-10T02:30:00" }), /does not exist/);
  assert.throws(() => edit(source, { start: "2030-11-03T01:30:00", end: "2030-11-03T03:00:00" }), /occurs twice/);
});

test("all-day values remain DATE with an exclusive end, without TZID or Z", () => {
  const source = wrap(event("", "DTSTART;VALUE=DATE:20300915\r\nDTEND;VALUE=DATE:20300916\r\n"));
  assert.equal(edit(source, {}), source);
  const output = edit(source, { end: "2030-09-17" });
  assert.ok(output.includes("DTEND;VALUE=DATE:20300917\r\n"));
  assert.throws(() => edit(source, { end: "2030-09-15" }), /exclusive/);
});

test("timed/all-day conversion resets VALUE and TZID correctly", () => {
  const source = wrap(event(), zone);
  const allDay = edit(source, { allDay: true, start: "2030-09-15", end: "2030-09-16" });
  assert.ok(allDay.includes("DTSTART;VALUE=DATE:20300915\r\n"));
  const timed = edit(allDay, { allDay: false, zone: "utc", start: "2030-09-15T09:00:00", end: "2030-09-15T10:00:00" });
  assert.ok(timed.includes("DTSTART:20300915T090000Z\r\n"));
  assert.ok(!timed.includes("DTSTART;VALUE=DATE"));
});

test("recurrence rules and exception components remain untouched, with unsafe conversions blocked", () => {
  const source = wrap(event("RRULE:FREQ=WEEKLY;COUNT=4\r\n"));
  assert.match(eventModel(openCalendar(source), 0).warnings.join(" "), /Recurring/);
  assert.doesNotThrow(() => edit(source, { start: "2030-09-15T09:15:00" }));
  assert.throws(() => edit(source, { zone: "floating" }), /original date type and time zones/);
  assert.throws(() => edit(source, { allDay: true, start: "2030-09-15", end: "2030-09-16" }), /original date type and time zones/);
});

test("DURATION stays intact unless the user explicitly supplies an end", () => {
  const source = wrap(event("DURATION:PT1H\r\n", "DTSTART:20300915T090000Z\r\n"));
  assert.ok(edit(source, { start: "2030-09-15T10:00:00" }).includes("DURATION:PT1H\r\n"));
  const output = edit(source, { end: "2030-09-15T11:00:00" });
  assert.ok(!output.includes("DURATION:"));
  assert.ok(output.includes("DTEND:20300915T110000Z\r\n"));
  assert.throws(() => edit(source, { allDay: true, start: "2030-09-15" }), /only days or weeks/);
});

test("an absent end is not synthesized on a text or start edit", () => {
  const source = wrap(event("", "DTSTART:20300915T090000Z\r\n"));
  assert.ok(!edit(source, { start: "2030-09-15T10:00:00" }).includes("DTEND"));
});

test("invalid dates, reversed ranges, and mixed floating/zoned ranges are rejected", () => {
  const source = wrap(event());
  for (const start of ["2030-02-30T09:00:00", "2030-09-15T24:00:00", "0000-09-15T09:00:00", "not a date"]) {
    assert.throws(() => edit(source, { start }));
  }
  assert.throws(() => edit(source, { end: "2030-09-15T08:00:00" }), /end must be after/i);
  const mixed = wrap(event("", "DTSTART:20300915T090000\r\nDTEND:20300915T100000Z\r\n"));
  assert.throws(() => edit(mixed, { start: "2030-09-15T09:15:00" }), /floating time/);
});

test("duplicate editable fields cannot be accidentally collapsed", () => {
  const source = wrap(event("SUMMARY:Another title\r\n"));
  assert.equal(edit(source, {}), source);
  assert.throws(() => edit(source, { title: "New" }), /multiple SUMMARY/);
});

test("missing DTSTART permits text edits but not date edits", () => {
  const source = wrap(event("", ""));
  assert.equal(eventModel(openCalendar(source), 0).editableDates, false);
  assert.equal(edit(source, { title: "New" }), source.replace("SUMMARY:Original", "SUMMARY:New"));
  assert.throws(() => edit(source, { start: "2030-09-15T09:00:00" }), /not supported/);
});

test("malformed or non-event files are rejected explicitly", () => {
  for (const source of ["", "not ics", "BEGIN:VCALENDAR\r\nEND:VEVENT\r\n", "BEGIN:VCARD\r\nEND:VCARD\r\n"]) {
    assert.throws(() => openCalendar(source));
  }
});

test("an empty calendar can accept an event with a new UID and DTSTAMP", () => {
  const source = wrap("");
  const values = {
    title: "New, event", start: "2030-09-15T09:00:00", end: "2030-09-15T10:00:00",
    zone: "utc", allDay: false, location: "Here", description: "Details",
  };
  const first = addEvent(openCalendar(source), values);
  const second = addEvent(openCalendar(first), values);
  const document = openCalendar(second);
  assert.equal(document.events.length, 2);
  const [a, b] = document.events;
  assert.notEqual(a.getFirstPropertyValue("uid"), b.getFirstPropertyValue("uid"));
  assert.ok(a.getFirstPropertyValue("dtstamp"));
  assert.equal(a.getFirstPropertyValue("summary"), "New, event");
  assert.equal(a.getFirstPropertyValue("dtstart").toString(), "2030-09-15T09:00:00Z");
  assert.equal(document.source.slice(0, first.indexOf("END:VCALENDAR")), first.slice(0, first.indexOf("END:VCALENDAR")));
});

test("new all-day events serialize as dates with no timezone", () => {
  const source = addEvent(openCalendar(wrap("")), {
    title: "All day", start: "2030-09-15", end: "2030-09-16",
    zone: "floating", allDay: true, location: "", description: "",
  });
  assert.ok(source.includes("DTSTART;VALUE=DATE:20300915\r\n"));
  assert.ok(source.includes("DTEND;VALUE=DATE:20300916\r\n"));
});

test("deletion removes exactly the selected component, including its alarms", () => {
  const a = event("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n");
  const b = event("X-KEEP:Untouched\r\n");
  const source = wrap(a + b, zone);
  assert.equal(deleteEvent(openCalendar(source), 0), wrap(b, zone));
  assert.equal(deleteEvent(openCalendar(source), 1), wrap(a, zone));
  assert.equal(deleteEvent(openCalendar(wrap(a, zone)), 0), wrap("", zone));
  assert.throws(() => deleteEvent(openCalendar(source), 9), /Select an event/);
});

test("LF files, custom components, and last-line formatting survive exact patching", () => {
  const source = wrap(event() + "BEGIN:VTODO\r\nUID:task\r\nSUMMARY:Keep\r\nEND:VTODO\r\n").replace(/\r\n/g, "\n").trimEnd();
  assert.equal(edit(source, { location: "Here" }), source.replace("END:VEVENT", "LOCATION:Here\nEND:VEVENT"));
});

test("a selected event is addressed by position even when UIDs repeat", () => {
  const source = wrap(event() + event());
  const output = edit(source, { title: "Second" }, 1);
  const events = openCalendar(output).events;
  assert.equal(events[0].getFirstPropertyValue("summary"), "Original");
  assert.equal(events[1].getFirstPropertyValue("summary"), "Second");
});

test("repository example calendars survive a no-op exactly and a targeted title edit", async () => {
  for (const path of ["leaf2030/data/programme.ics", "nzpem2022/data/nzpem2022.ics"]) {
    const source = await readFile(new URL(`../../examples/${path}`, import.meta.url), "utf8");
    const document = openCalendar(source);
    assert.equal(editEvent(document, 0, eventModel(document, 0).values), source);
    const output = edit(source, { title: "Updated registration" });
    assert.equal(openCalendar(output).events.length, document.events.length);
    assert.equal(openCalendar(output).events[0].getFirstPropertyValue("summary"), "Updated registration");
  }
});
