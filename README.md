# ICS event editor

A lightweight static editor for individual events in an existing `.ics` file.
Open a file, select an event, edit it (or add/delete events), and download a new
copy. File contents are processed only in the browser: no uploads, APIs,
analytics, accounts, storage, synchronization, or invitations.

A compact read-only day agenda shows each event on two lines: its title, then
its time range, explicit time zone (if present), and location. Long lines are
truncated visually, with their full text available on hover. Events with the same start time appear side by side;
the selected event is highlighted. Previous/next controls navigate event dates.
It adds no dependency, converts no time zones, and does not expand recurring
occurrences. All-day events appear on their start date. Events without a usable
start remain available in the editor but are omitted from the agenda.

## Run or deploy

Publish **this entire directory**, including `vendor/`, on GitHub Pages,
Cloudflare Pages, or any static host. No build step, environment variables,
backend, or Node.js runtime are required in production. All assets and
ical.js 2.2.1 are served locally; there are no CDN or network dependencies.
Use HTTP(S), not `file://`, because browsers restrict JavaScript module loading
from local files.

For local development with Node.js:

```sh
cd ics-app
npm run serve
```

Open <http://127.0.0.1:8080>. This development-only static server binds to
localhost. Alternatively, use any static file server rooted in this directory.

## Workflow

1. Open a UTF-8 `.ics` file (maximum 10 MB). A single event is selected
   automatically; a file with multiple events gets an event selector.
2. Edit the title, start/end, time zone, location, or description. Switch to
   all-day mode to use date-only fields.
3. Use **Add event** to insert a new event with a unique UID and UTC DTSTAMP.
   Its initial times are 09:00-10:00 today, floating (no time zone); edit these
   before downloading.
4. **Delete selected event** removes only that component after confirmation,
   including its nested alarms. Deleting a recurring master does not delete
   separately stored recurrence exceptions; the confirmation explains this.
5. Switch events without losing drafts. **Reset selected event**, beside
   Add/Delete, discards only the selected event's field edits; other events
   are unaffected. Downloads include all field edits, additions, and deletions.
6. Download `original-name-edited.ics`. The source file is never overwritten.
   Changes exist only in the current tab until downloaded. Reset does not undo
   additions/deletions; reopen the original file to discard those changes.
   Alternatively, **Download individual events (.zip)** creates one ICS per
   stored event, named by start date/time, title, and a unique sequence number.
   Each retains calendar-level metadata, time-zone definitions, and non-event
   components. Recurrence exceptions remain exceptions, not independent
   occurrences. Both download options include all edits, additions, and
   deletions. The uncompressed ZIP uses a small dependency-free writer; ZIP
   output is limited to 100 MB to bound browser memory use.

## Preservation and time-zone behavior

- ical.js parses ICS values and serializes modified properties. A source-span
  layer replaces only the changed property lines (including folded
  continuations). Unchanged bytes, ordering, line endings, other events,
  `UID`, `VTIMEZONE`, recurrence rules, attendees, alarms, and custom
  properties are retained. Edited properties keep their existing parameters
  unless a date-type or time-zone change requires replacing `VALUE`/`TZID`.
- New text is correctly escaped and folded at 75 UTF-8 octets. The app uses
  text-only DOM rendering; imported text is never rendered as HTML.
- Timed values use native `datetime-local` controls **as wall-clock editors**,
  not device-zone dates. Seconds are retained.
- **Keep original time zones** preserves UTC (`Z`), floating time (no
  `TZID`/`Z`), and named `TZID` values, independently for the start and end.
  Choosing another zone reinterprets the displayed clock times; it does not
  convert the instant. This is stated beside the field.
- Named-zone choices come from embedded `VTIMEZONE` definitions. The app
  does not invent a definition from a device's IANA database. Unknown TZIDs
  without embedded rules are preserved on text-only edits, but date edits
  require an explicit supported zone choice.
- Embedded standard/daylight recurrence rules are expanded with ical.js to
  validate instants, compare different start/end zones, and reject nonexistent
  or ambiguous local times at DST transitions. Use UTC to disambiguate a
  repeated clock time. Excessively complex zone rules are rejected explicitly.
- All-day events use `VALUE=DATE` with no zone. The end date is **exclusive**:
  a one-day event on September 15 ends on September 16 (or has no explicit
  end). Changing date type is explicit.
- `DURATION` stays unchanged if the end field stays empty; entering an
  explicit end replaces `DURATION` with `DTEND`. No end is synthesized
  for events lacking both properties.
- Recurring events are not expanded into occurrences. Edits apply to the
  stored master or exception only. Recurrence rules and exception dates stay
  untouched; changing date type/time zone is blocked for recurring events.
- Alarms, invitation data, `SEQUENCE`, and existing `DTSTAMP` values are not
  updated. Absolute alarms do not follow a moved event. Warnings explain
  these limitations; this is not a scheduling/invitation client.
- Missing/unsupported dates allow text-only edits. Duplicate editable
  properties cannot be silently collapsed. An empty calendar is supported
  so you can delete the last event or add an event to a calendar.

## Tests and dependency updates

The tests use Node's built-in runner and the same vendored module as the app:

```sh
npm test
```

They cover exact source preservation, multiple events, recurrence,
attendees/alarms, escaped/folded Unicode text, UTC/floating/TZID times, DST
gaps/folds, all-day exclusive ends, validation, duration handling,
addition/deletion, and both repository example calendars.
ZIP tests check filenames, CRC32, archive structure, and the 100 MB bound; when
available, the system `unzip` command independently validates the output too.

The pinned npm dependency is only needed to refresh the vendored copy:

```sh
npm ci --ignore-scripts
npm run vendor
npm test
```

Commit the lockfile, `vendor/ical.js`, and `vendor/LICENSE` when updating.
ical.js is distributed under the MPL-2.0 license; its license is retained
alongside the unmodified distribution.
