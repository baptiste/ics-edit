import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../vendor/", import.meta.url), { recursive: true });
await copyFile(
  new URL("../node_modules/ical.js/dist/ical.js", import.meta.url),
  new URL("../vendor/ical.js", import.meta.url),
);
await copyFile(
  new URL("../node_modules/ical.js/LICENSE", import.meta.url),
  new URL("../vendor/LICENSE", import.meta.url),
);
console.log("Vendored ical.js 2.2.1 and its license.");
