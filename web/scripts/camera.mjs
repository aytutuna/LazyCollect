// Opens the scanner on the built client page with Chrome's fake camera showing a fixture photo, and checks that the page is
// found, the outline is drawn and the photo is taken by itself. Build first (npm run build), then: npm run camera.
// CHROME_PATH points at a Chrome or Edge when it is not in the usual place.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { fixture, link, mock, serve, states } from "./states.mjs";

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const executablePath = candidates.find((p) => p && existsSync(p));
if (!executablePath) throw new Error("No Chrome found; set CHROME_PATH");

const server = await serve();
const browser = await chromium.launch({ executablePath });

// The fake camera plays a file of JPEG frames; the same frame repeated is a still scene. The fixture is cropped so the
// page fills about half of it, as it would when someone holds a phone over a sheet.
const frame = await (async () => {
  const scratch = await browser.newPage();
  const url = `data:image/jpeg;base64,${readFileSync(fixture("background02-letter001-0141.jpg")).toString("base64")}`;
  const jpeg = await scratch.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 480 });
    canvas.getContext("2d").drawImage(img, 330, 100, 640, 480, 0, 0, 640, 480);
    return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
  }, url);
  await scratch.close();
  return Buffer.from(jpeg, "base64");
})();
const feed = join(tmpdir(), "scanner-feed.mjpeg");
writeFileSync(feed, Buffer.concat(Array.from({ length: 30 }, () => frame)));
await browser.close();

const camera = await chromium.launch({
  executablePath,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${feed}`],
});
const context = await camera.newContext({ viewport: { width: 390, height: 800 }, permissions: ["camera"] });
const page = await context.newPage();
const problems = [];
page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(e.message));
await mock(page, states[0]);
await page.goto(link(server.url));
await page.locator("h1").waitFor();
await page.locator("#label-i1").locator("xpath=ancestor::li[1]").getByRole("button", { name: "Scan" }).click();
const started = Date.now();
await page.locator(".viewfinder polygon").waitFor({ timeout: 20000 });
console.log(`outline drawn after ${Date.now() - started} ms`);
await page.locator("canvas.page-preview").waitFor({ timeout: 20000 });
console.log(`photo taken by itself after ${Date.now() - started} ms`);
const stopped = await page.evaluate(() => document.querySelector("video") === null);
console.log(`camera view closed: ${stopped}`);
await camera.close();
server.close();
if (problems.length || !stopped) {
  console.log(problems.join("\n"));
  process.exit(1);
}
console.log("ok");
