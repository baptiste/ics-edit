import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { openCalendar, individualEvents } from "../editor.js";
import { createZip, crc32 } from "../zip.js";

const source = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//ZIP Test//EN
X-ORIGINAL:Keep
BEGIN:VTIMEZONE
TZID:Custom
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+1200
TZOFFSETTO:+1200
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:first
DTSTART;TZID=Custom:20300915T090000
SUMMARY:Tea / water: Ōtautahi
RRULE:FREQ=DAILY;COUNT=2
END:VEVENT
BEGIN:VEVENT
UID:second
DTSTART;VALUE=DATE:20300916
SUMMARY:Tea / water: Ōtautahi
BEGIN:VALARM
ACTION:DISPLAY
DESCRIPTION:Keep alarm
TRIGGER:-PT15M
END:VALARM
END:VEVENT
END:VCALENDAR
`;

test("split calendars contain exactly their event and retain all calendar metadata/time zones", () => {
  const files = [...individualEvents(openCalendar(source))];
  assert.equal(files.length, 2);
  for (const [index, file] of files.entries()) {
    const document = openCalendar(file.content);
    assert.equal(document.events.length, 1);
    assert.equal(document.events[0].getFirstPropertyValue("uid"), index === 0 ? "first" : "second");
    assert.ok(file.content.includes("X-ORIGINAL:Keep\n"));
    assert.ok(file.content.includes("BEGIN:VTIMEZONE\n"));
    assert.ok(file.name.includes("Ōtautahi"));
    assert.ok(!/[<>:"/\\|?*\u0000-\u001f]/.test(file.name));
  }
  assert.notEqual(files[0].name, files[1].name);
  assert.ok(files[0].name.startsWith("20300915-090000_"));
  assert.ok(files[1].name.startsWith("20300916_"));
  assert.ok(files[0].content.includes("RRULE:FREQ=DAILY;COUNT=2\n"));
  assert.ok(files[1].content.includes("DESCRIPTION:Keep alarm\n"));
});

test("individual event filenames are safe, bounded, and unique for long/duplicate titles", () => {
  const document = openCalendar(source.replaceAll("Tea / water: Ōtautahi", "../" + "茶🫖".repeat(200)));
  const files = [...individualEvents(document)];
  for (const file of files) {
    assert.ok(Buffer.byteLength(file.name) < 255);
    assert.ok(!file.name.includes("/"));
    assert.ok(!file.name.startsWith("."));
  }
  assert.notEqual(files[0].name, files[1].name);
});

test("CRC32 matches the standard check vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("ZIP local/central entries carry matching filenames, lengths, data, and CRC", async () => {
  const entries = [...individualEvents(openCalendar(source))];
  const bytes = new Uint8Array(await createZip(entries).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  let offset = 0;
  for (const entry of entries) {
    assert.equal(view.getUint32(offset, true), 0x04034b50);
    assert.equal(view.getUint16(offset + 6, true), 0x0800);
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength));
    const data = bytes.slice(offset + 30 + nameLength, offset + 30 + nameLength + length);
    assert.equal(name, entry.name);
    assert.equal(decoder.decode(data), entry.content);
    assert.equal(view.getUint32(offset + 14, true), crc32(data));
    offset += 30 + nameLength + length;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), entries.length);
  assert.equal(view.getUint32(end + 16, true), offset);
});

test("system unzip independently validates the generated archive and original event bytes", async context => {
  if (spawnSync("unzip", ["-v"]).error?.code === "ENOENT") {
    context.skip("System unzip is unavailable; the binary-structure and CRC tests still run.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "ics-editor-zip-"));
  const path = join(directory, "events.zip");
  const entries = [...individualEvents(openCalendar(source))];
  try {
    await writeFile(path, new Uint8Array(await createZip(entries).arrayBuffer()));
    assert.match(execFileSync("unzip", ["-t", path], { encoding: "utf8" }), /No errors detected/);
    // ASCII names avoid locale-dependent filename matching in older unzip versions.
    const ascii = [{ name: "event.ics", content: entries[0].content }];
    await writeFile(path, new Uint8Array(await createZip(ascii).arrayBuffer()));
    assert.equal(execFileSync("unzip", ["-p", path, "event.ics"], { encoding: "utf8" }), entries[0].content);
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});

test("ZIP export rejects empty archives and enforces its 100 MB memory bound", () => {
  assert.throws(() => createZip([]), /no events/);
  const content = "a".repeat(1024 * 1024);
  function* largeEntries() {
    for (let index = 0; index < 100; index++) yield { name: `event-${index}.ics`, content };
  }
  assert.throws(() => createZip(largeEntries()), /100 MB/);
});
