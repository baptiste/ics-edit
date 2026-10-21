import ICAL from "./vendor/ical.js";

const textFields = { title: "summary", location: "location", description: "description" };
const encoder = new TextEncoder();

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

// Track source spans, not ICS values: ical.js handles all parsing and escaping.
function sourceEvents(source) {
  const physical = [];
  const endings = /\r\n|\n|\r/g;
  let offset = 0;
  for (const match of source.matchAll(endings)) {
    physical.push({ start: offset, end: match.index + match[0].length, text: source.slice(offset, match.index) });
    offset = match.index + match[0].length;
  }
  if (offset < source.length) physical.push({ start: offset, end: source.length, text: source.slice(offset) });
  const lines = [];
  for (const line of physical) {
    if (/^[ \t]/.test(line.text)) {
      requireCondition(lines.length, "A folded line has no preceding property.");
      lines.at(-1).text += line.text.slice(1);
      lines.at(-1).end = line.end;
    } else {
      lines.push({ ...line, text: line.text.replace(/^\uFEFF/, "") });
    }
  }
  const events = [];
  const stack = [];
  let event;
  let calendarEnd;
  let calendars = 0;
  for (const line of lines) {
    const boundary = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line.text);
    if (boundary) {
      const [, action, rawName] = boundary;
      const name = rawName.toUpperCase();
      if (action.toUpperCase() === "BEGIN") {
        if (name === "VCALENDAR") calendars++;
        if (name === "VEVENT" && stack.length === 1 && stack[0] === "VCALENDAR") {
          event = { properties: new Map(), start: line.start, end: 0, componentEnd: 0 };
          events.push(event);
        }
        stack.push(name);
      } else {
        requireCondition(stack.pop() === name, "Mismatched ICS component boundaries.");
        if (name === "VEVENT" && stack.length === 1 && event) {
          event.end = line.start;
          event.componentEnd = line.end;
          event = undefined;
        }
        if (name === "VCALENDAR" && stack.length === 0) calendarEnd = line.start;
      }
    } else if (event && stack.length === 2) {
      const name = /^([A-Z0-9-]+)[:;]/i.exec(line.text)?.[1].toLowerCase();
      if (name) {
        if (!event.properties.has(name)) event.properties.set(name, []);
        event.properties.get(name).push(line);
      }
    }
  }
  requireCondition(stack.length === 0, "The ICS file contains an unclosed component.");
  requireCondition(calendars === 1 && calendarEnd !== undefined, "Expected exactly one complete VCALENDAR component.");
  return { events, calendarEnd };
}

export function openCalendar(source) {
  requireCondition(typeof source === "string" && source.trim(), "Choose a non-empty ICS file.");
  const calendar = new ICAL.Component(ICAL.parse(source.replace(/^\uFEFF/, "")));
  requireCondition(calendar.name === "vcalendar", "Expected one VCALENDAR component.");
  const events = calendar.getAllSubcomponents("vevent");
  const { events: spans, calendarEnd } = sourceEvents(source);
  requireCondition(spans.length === events.length, "Cannot safely match events to the original source.");
  return { source, calendar, events, spans, calendarEnd, newline: source.match(/\r\n|\n|\r/)?.[0] || "\r\n" };
}

function zoneOf(property) {
  if (!property) return "floating";
  const value = property.getFirstValue();
  if (value.isDate) return "date";
  if (value.zone === ICAL.Timezone.utcTimezone) return "utc";
  const tzid = property.getParameter("tzid");
  return tzid ? `tzid:${tzid}` : "floating";
}

function localValue(time) {
  return time.toString().replace(/Z$/, "");
}

function timeZone(document, key) {
  if (key === "utc") return ICAL.Timezone.utcTimezone;
  if (key === "floating" || key === "date") return ICAL.Timezone.localTimezone;
  return document.calendar.getTimeZoneByID(key.slice(5));
}

export function zoneLabel(key) {
  if (key === "utc") return "UTC";
  if (key === "floating") return "Unspecified (local clock time)";
  if (key === "date") return "All-day date (no time zone)";
  return key.slice(5);
}

export function eventModel(document, index) {
  const event = document.events[index];
  requireCondition(event, "Select an event first.");
  const start = event.getFirstProperty("dtstart");
  const end = event.getFirstProperty("dtend");
  const warnings = [];
  const startTime = start?.getFirstValue();
  const endTime = end?.getFirstValue();
  const validTime = (value) => value instanceof ICAL.Time;
  const editableDates = validTime(startTime) && (!end || validTime(endTime));
  const recurring = ["rrule", "rdate", "exdate", "recurrence-id"].some(name => event.hasProperty(name));
  if (recurring) {
    warnings.push("Recurring event: edits affect this stored master or exception, not an expanded occurrence. Recurrence rules, exclusions, and other exceptions are not adjusted. Date type and time-zone changes are disabled.");
  }
  if (event.hasProperty("attendee") || event.hasProperty("organizer") || document.calendar.hasProperty("method")) {
    warnings.push("Scheduling/invitation data is preserved. This editor does not send invitations or update SEQUENCE, DTSTAMP, or attendee responses.");
  }
  if (event.getAllSubcomponents("valarm").length) {
    warnings.push("Alarms are preserved unchanged. Absolute alarm times will not follow a moved event.");
  }
  if (!editableDates) warnings.push("Missing or unsupported event dates: only the text fields can be edited.");
  if (startTime?.isDate !== endTime?.isDate && endTime) {
    warnings.push("Start and end use different date types. Correct the date fields before changing dates.");
  }
  const duration = event.getFirstPropertyValue("duration");
  if (duration) {
    warnings.push(`Original DURATION (${duration.toString()}) is preserved while the end field is empty. Entering an explicit end replaces DURATION with DTEND.`);
  }
  if (duration && end) warnings.push("This event has both DURATION and DTEND, which is invalid. Set a new end to resolve this before changing dates.");
  const zones = new Set();
  for (const component of document.calendar.getAllSubcomponents("vtimezone")) {
    const tzid = component.getFirstPropertyValue("tzid");
    if (tzid) zones.add(`tzid:${tzid}`);
  }
  for (const property of [start, end]) {
    if (!property || !(property.getFirstValue() instanceof ICAL.Time)) continue;
    const key = zoneOf(property);
    if (key.startsWith("tzid:") && !timeZone(document, key)) {
      warnings.push(`No embedded VTIMEZONE definition for ${zoneLabel(key)}. Its original value is preserved; changing dates requires choosing UTC, floating time, or an embedded zone.`);
    }
    if (key.startsWith("tzid:")) zones.add(key);
  }
  const values = {
    title: event.getFirstPropertyValue("summary") || "",
    location: event.getFirstPropertyValue("location") || "",
    description: event.getFirstPropertyValue("description") || "",
    start: editableDates ? localValue(startTime) : "",
    end: editableDates && endTime ? localValue(endTime) : "",
    allDay: Boolean(startTime?.isDate),
    zone: "keep",
  };
  for (const name of ["summary", "location", "description", "dtstart", "dtend", "duration"]) {
    if (event.getAllProperties(name).length > 1) warnings.push(`Multiple ${name.toUpperCase()} properties: that field cannot be safely edited.`);
  }
  return {
    values, warnings, editableDates, recurring, zones: [...zones],
    startZone: start ? zoneOf(start) : null,
    endZone: end ? zoneOf(end) : null,
    zoneSummary: !start ? "" : !end || zoneOf(start) === zoneOf(end)
      ? `Time zone: ${zoneLabel(zoneOf(start))}.`
      : `Start time zone: ${zoneLabel(zoneOf(start))}; end time zone: ${zoneLabel(zoneOf(end))}.`,
  };
}

function parseInput(value, allDay) {
  const pattern = allDay
    ? /^(\d{4})-(\d{2})-(\d{2})$/
    : /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
  const match = pattern.exec(value);
  requireCondition(match, allDay ? "Enter a valid date." : "Enter a valid date and time.");
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map(part => Number(part || 0));
  requireCondition(
    year >= 1 && year <= 9999 && month >= 1 && month <= 12 &&
    day >= 1 && day <= ICAL.Time.daysInMonth(month, year) &&
    hour < 24 && minute < 60 && second < 60,
    "The date or time is outside its valid range.",
  );
  return ICAL.Time.fromData({ year, month, day, hour, minute, second, isDate: allDay });
}

function zoneTransitions(document, key, year) {
  document.transitions ??= new Map();
  const cacheKey = `${key}:${year}`;
  if (document.transitions.has(cacheKey)) return document.transitions.get(cacheKey);
  const component = timeZone(document, key)?.component;
  requireCondition(component, `Cannot validate ${zoneLabel(key)} without an embedded VTIMEZONE. Choose a supported time zone.`);
  const changes = [];
  let iterations = 0;
  for (const observance of component.getAllSubcomponents()) {
    requireCondition(["standard", "daylight"].includes(observance.name), "Unsupported time-zone observance.");
    const start = observance.getFirstPropertyValue("dtstart");
    const from = observance.getFirstPropertyValue("tzoffsetfrom");
    const to = observance.getFirstPropertyValue("tzoffsetto");
    requireCondition(start instanceof ICAL.Time && from instanceof ICAL.UtcOffset && to instanceof ICAL.UtcOffset,
      "The embedded time zone has an incomplete observance.");
    const add = local => {
      requireCondition(local instanceof ICAL.Time && !local.isDate, "Unsupported time-zone transition date.");
      const wall = local.clone();
      wall.zone = ICAL.Timezone.localTimezone;
      changes.push({ at: wall.toUnixTime() - from.toSeconds(), from: from.toSeconds(), to: to.toSeconds() });
    };
    add(start);
    for (const property of observance.getAllProperties("rdate")) {
      for (const local of property.getValues()) add(local);
    }
    for (const property of observance.getAllProperties("rrule")) {
      const rule = property.getFirstValue().clone();
      // VTIMEZONE UNTIL is UTC, but its recurrence instances are local wall times.
      if (rule.until?.zone === ICAL.Timezone.utcTimezone) {
        rule.until.adjust(0, 0, 0, from.toSeconds());
        rule.until.zone = ICAL.Timezone.localTimezone;
      }
      const iterator = rule.iterator(start);
      for (let local = iterator.next(); local && local.year <= year + 1; local = iterator.next()) {
        requireCondition(++iterations <= 20_000, "The embedded time-zone rules are too complex to safely expand.");
        add(local);
      }
    }
  }
  requireCondition(changes.length, "The embedded time zone has no usable transition rules.");
  changes.sort((a, b) => a.at - b.at);
  document.transitions.set(cacheKey, changes);
  return changes;
}

// Resolve candidates against UTC transition instants, never guessing across a DST gap or fold.
function zonedInstant(document, time, key) {
  const zone = timeZone(document, key);
  requireCondition(zone, `Cannot validate ${zoneLabel(key)} without an embedded VTIMEZONE. Choose a supported time zone.`);
  if (key === "date" || key === "floating" || key === "utc") return time.toUnixTime();
  const wall = time.toUnixTime();
  const changes = zoneTransitions(document, key, time.year);
  const offsets = new Set(changes.flatMap(change => [change.from, change.to]));
  const candidates = [...offsets].map(offset => wall - offset).filter(instant => {
    let offset = changes[0].from;
    for (const change of changes) {
      if (change.at > instant) break;
      offset = change.to;
    }
    return instant + offset === wall;
  });
  requireCondition(candidates.length > 0, `This local time does not exist in ${zoneLabel(key)} because of a clock change.`);
  requireCondition(candidates.length === 1, `This local time occurs twice in ${zoneLabel(key)}. Use an explicit UTC time to disambiguate it.`);
  return candidates[0];
}

function foldProperty(property, newline) {
  const line = property.toICALString();
  const chunks = [];
  let chunk = "";
  let length = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (length + size > 75) {
      chunks.push(chunk);
      chunk = " ";
      length = 1;
    }
    chunk += character;
    length += size;
  }
  chunks.push(chunk);
  return chunks.join(newline) + newline;
}

function copyProperty(event, name) {
  requireCondition(event.getAllProperties(name).length <= 1, `Cannot safely edit multiple ${name.toUpperCase()} properties.`);
  const property = event.getFirstProperty(name);
  return property ? new ICAL.Property(structuredClone(property.toJSON())) : new ICAL.Property(name);
}

function dateProperty(document, event, name, value, allDay, key) {
  const property = copyProperty(event, name);
  const time = parseInput(value, allDay);
  property.removeParameter("tzid");
  property.removeParameter("value");
  if (!allDay) {
    const zone = timeZone(document, key);
    requireCondition(zone, `No embedded definition for ${zoneLabel(key)}.`);
    time.zone = zone;
    if (key.startsWith("tzid:")) property.setParameter("tzid", key.slice(5));
  }
  property.setValue(time);
  return property;
}

export function editEvent(document, index, values) {
  const model = eventModel(document, index);
  const original = model.values;
  const event = document.events[index];
  const updates = new Map();
  for (const [field, name] of Object.entries(textFields)) {
    const value = values[field].replace(/\r\n?/g, "\n");
    requireCondition(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), "Text fields contain unsupported control characters.");
    if (value !== original[field]) {
      const property = copyProperty(event, name);
      property.setValue(value);
      updates.set(name, value ? property : null);
    }
  }
  const dateChanged = ["start", "end", "allDay"].some(key => values[key] !== original[key]) || values.zone !== "keep";
  if (dateChanged) {
    requireCondition(model.editableDates, "This event's date representation is not supported for editing.");
    requireCondition(values.start, "A start date is required.");
    const oldStart = event.getFirstProperty("dtstart");
    const oldEnd = event.getFirstProperty("dtend");
    const startZone = values.allDay ? "date" : values.zone === "keep" ? zoneOf(oldStart) : values.zone;
    const endZone = values.allDay ? "date" : values.zone === "keep" ? (oldEnd ? zoneOf(oldEnd) : startZone) : values.zone;
    requireCondition(values.allDay || (startZone !== "date" && endZone !== "date"), "Choose a time zone when converting all-day dates to times.");
    if (model.recurring) {
      requireCondition(
        values.allDay === original.allDay && startZone === zoneOf(oldStart) && (!oldEnd || endZone === zoneOf(oldEnd)),
        "Keep the original date type and time zones for recurring events.",
      );
    }
    const start = parseInput(values.start, values.allDay);
    const startInstant = zonedInstant(document, start, startZone);
    if (values.end) {
      const end = parseInput(values.end, values.allDay);
      requireCondition(
        (startZone === "floating") === (endZone === "floating"),
        "A floating time cannot be compared to a zoned time. Choose the same time zone for both.",
      );
      const endInstant = zonedInstant(document, end, endZone);
      requireCondition(endInstant > startInstant, values.allDay
        ? "The all-day end is exclusive and must be after the start."
        : "The end must be after the start.");
    }
    if (values.start !== original.start || values.allDay !== original.allDay || values.zone !== "keep") {
      updates.set("dtstart", dateProperty(document, event, "dtstart", values.start, values.allDay, startZone));
    }
    if (values.end !== original.end || (values.end && (values.allDay !== original.allDay || values.zone !== "keep"))) {
      if (values.end) {
        updates.set("dtend", dateProperty(document, event, "dtend", values.end, values.allDay, endZone));
        if (event.hasProperty("duration")) {
          copyProperty(event, "duration");
          updates.set("duration", null);
        }
      } else {
        copyProperty(event, "dtend");
        updates.set("dtend", null);
      }
    }
    const duration = event.getFirstPropertyValue("duration");
    if (duration && !updates.has("duration")) {
      requireCondition(!oldEnd, "This event has both DTEND and DURATION. Set a new end to resolve this before changing dates.");
      requireCondition(duration.toSeconds() > 0, "DURATION must be positive.");
      requireCondition(!values.allDay || !(duration.hours || duration.minutes || duration.seconds), "All-day DURATION must contain only days or weeks.");
    }
  }
  const spans = document.spans[index];
  const patches = [];
  let additions = "";
  for (const [name, property] of updates) {
    const lines = spans.properties.get(name) || [];
    requireCondition(lines.length <= 1, `Cannot safely locate ${name.toUpperCase()} in the original file.`);
    const replacement = property ? foldProperty(property, document.newline) : "";
    if (lines.length) patches.push({ start: lines[0].start, end: lines[0].end, replacement });
    else additions += replacement;
  }
  if (additions) patches.push({ start: spans.end, end: spans.end, replacement: additions });
  let source = document.source;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, patch.start) + patch.replacement + source.slice(patch.end);
  }
  // Verify the complete result before making it downloadable.
  openCalendar(source);
  return source;
}

export function addEvent(document, values) {
  requireCondition(values.zone !== "keep", "Choose an explicit time zone for a new event.");
  const event = new ICAL.Component("vevent");
  event.addPropertyWithValue("uid", crypto.randomUUID());
  event.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  event.addPropertyWithValue("dtstart", ICAL.Time.fromString("2000-01-01T00:00:00"));
  const lines = [
    "BEGIN:VEVENT",
    ...event.getAllProperties().map(property => foldProperty(property, document.newline).trimEnd()),
    "END:VEVENT",
    "",
  ].join(document.newline);
  const source = document.source.slice(0, document.calendarEnd) + lines + document.source.slice(document.calendarEnd);
  return editEvent(openCalendar(source), document.events.length, values);
}

export function deleteEvent(document, index) {
  const span = document.spans[index];
  requireCondition(span, "Select an event to delete.");
  const source = document.source.slice(0, span.start) + document.source.slice(span.componentEnd);
  openCalendar(source);
  return source;
}

export function* individualEvents(document) {
  for (let index = 0; index < document.events.length; index++) {
    const values = eventModel(document, index).values;
    const title = (values.title || "Untitled event").normalize("NFC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, "-").replace(/^[.-]+|[. -]+$/g, "");
    let shortTitle = "";
    for (const character of title) {
      if (encoder.encode(shortTitle + character).length > 120) break;
      shortTitle += character;
    }
    const date = values.start ? values.start.replace(/[-:]/g, "").replace("T", "-") : "undated";
    const name = `${date}_${shortTitle || "event"}_${String(index + 1).padStart(3, "0")}.ics`;
    let content = "";
    let offset = 0;
    for (let other = 0; other < document.spans.length; other++) {
      if (other === index) continue;
      const span = document.spans[other];
      content += document.source.slice(offset, span.start);
      offset = span.componentEnd;
    }
    content += document.source.slice(offset);
    yield { name, content };
  }
}
