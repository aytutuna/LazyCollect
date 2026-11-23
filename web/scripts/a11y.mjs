// Runs axe-core (WCAG 2.0 to 2.2, levels A and AA) against the built client page in every state, light and dark,
// at 320 and 390 px, and checks that the page does not scroll sideways at 320 px.
// Build first (npm run build), then: npm run a11y. CHROME_PATH points at a Chrome or Edge when it is not in the usual place.
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { link, mock, serve, states } from "./states.mjs";

const axe = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
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
let failures = 0;

for (const scheme of ["light", "dark"]) {
  for (const width of [320, 390]) {
    for (const state of states) {
      const context = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme, hasTouch: width === 390, isMobile: width === 390 });
      const page = await context.newPage();
      const net = await mock(page, state);
      await page.goto(link(server.url));
      await page.locator("h1").waitFor();
      if (state.run) await state.run(page, context, net);
      const lang = await page.evaluate(() => document.documentElement.lang);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.evaluate(axe);
      const { violations } = await page.evaluate(() =>
        // eslint-disable-next-line no-undef
        axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } }),
      );
      const label = `${state.name} ${scheme} ${width}px`;
      const problems = violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`);
      if (!lang) problems.push("html has no lang");
      if (width === 320 && overflow > 0) problems.push(`page scrolls sideways by ${overflow}px`);
      failures += problems.length;
      console.log(`${problems.length ? "FAIL" : "ok  "} ${label}`);
      for (const p of problems) console.log(`     ${p}`);
      await context.close();
    }
  }
}

await browser.close();
server.close();
if (failures) {
  console.log(`${failures} problems`);
  process.exit(1);
}
