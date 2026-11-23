// States of the client page for the accessibility check and for screenshots. The page is the built one from dist/;
// its API is answered here, so nothing needs a server.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const TOKEN = `na_${"a".repeat(43)}`;
const now = Date.now();
const DAY = 86_400_000;

const file = (id, name, size) => ({ id, name, size, uploaded_at: now - DAY });
const item = (id, label, o = {}) => ({ id, label, help: null, required: true, status: "empty", reject_note: null, unavailable_note: null, files: [], kind: "file", options: null, answer: null, ...o });
// a question; `when` is [parent id, value] and keeps the item out of the page until the parent has that answer
const ask = (id, label, kind, o = {}) => item(id, label, { kind, ...o });

const base = {
  firm_name: "Tuna Tax Services",
  tz: "America/Toronto",
  title: "2025 tax return",
  note: "Please send these by the deadline. Photos from your phone are fine.",
  deadline: now + 9 * DAY,
  expires_at: now + 39 * DAY,
  status: "open",
  contact: { name: "Tuna Tax Services Inc.", email: "hello@tunatax.example", phone: "416-555-0100", address: "12 King St W\nToronto ON M5H 1A1" },
  notes: [],
  items: [
    item("i1", "Passport", { help: "The page with your photo" }),
    item("i2", "T4 slip", { status: "submitted", files: [file("f1", "t4.pdf", 182_000)] }),
    item("i3", "Notice of assessment", { status: "approved", files: [file("f2", "noa.pdf", 96_000)] }),
    item("i4", "Rent receipts", { status: "rejected", reject_note: "Page 2 is cut off. Please take the photo again.", files: [file("f3", "rent.jpg", 2_400_000)] }),
    item("i5", "Donation receipts", { required: false, help: "Only if you gave to a charity" }),
  ],
};

const done = {
  ...base,
  items: base.items.map((i) => (i.required ? { ...i, status: "submitted", reject_note: null, files: i.files.length ? i.files : [file(`f-${i.id}`, "scan.pdf", 120_000)] } : i)),
};

const unavailable = {
  ...base,
  items: base.items.map((i) => (i.id === "i1" ? { ...i, status: "unavailable", unavailable_note: "My passport is being renewed and I do not have it right now." } : i)),
};

const thread = {
  ...base,
  notes: [
    { id: "n1", author: "client", body: "Can I send my passport as a photo from my phone?", created_at: now - 3 * 3_600_000 },
    { id: "n2", author: "user", body: "Yes, a clear photo of the page with your picture is fine.", created_at: now - 2 * 3_600_000 },
  ],
};

const questions = {
  ...base,
  title: "2025 tax organizer",
  items: [
    ask("q1", "Did you move more than 40 km for work or school?", "yesno", { help: "The new home must be at least 40 km closer." }),
    item("q1a", "Moving expense receipts", { help: "Movers, truck rental and travel", when: ["q1", "yes"] }),
    ask("q2", "Where do you work?", "text", { status: "submitted", answer: "Acme Ltd." }),
    ask("q3", "Names and birth dates of your dependants", "longtext", { required: false }),
    ask("q4", "How many children do you have?", "number", { status: "submitted", answer: "2" }),
    ask("q5", "What date did you move?", "date", { required: false }),
    ask("q6", "Which province do you live in?", "choice", { options: ["Ontario", "Quebec", "British Columbia"], status: "rejected", answer: "Ontario", reject_note: "Please pick where you lived on December 31." }),
    ask("q7", "Which kinds of income did you have?", "multi", { options: ["Salary", "Rental", "Business"], status: "submitted", answer: ["Salary"] }),
    ask("q8", "Were you a resident of Quebec on December 31?", "yesno", { status: "approved", answer: "no" }),
    item("i1", "Notice of assessment", { status: "submitted", files: [file("f1", "noa.pdf", 96_000)] }),
  ],
};

// a 1x1 PNG is enough for the page to prepare and send
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const photo = { name: "passport.png", mimeType: "image/png", buffer: PNG };

export const states = [
  { name: "fresh", view: base },
  { name: "done", view: done },
  { name: "unavailable", view: unavailable },
  { name: "thread", view: thread },
  { name: "questions", view: questions },
  {
    // answering yes brings the receipts item onto the page, and the live region says so
    name: "questions-answered",
    view: questions,
    async run(page) {
      await page.getByRole("radio", { name: "Yes", exact: true }).first().check();
      await page.locator("#label-q1a").waitFor();
      await page.getByText("1 more item now applies to you.", { exact: false }).waitFor({ state: "attached" });
      await page.getByRole("textbox", { name: "Where do you work?" }).fill("Acme Inc.");
      await page.getByRole("textbox", { name: "Where do you work?" }).blur();
      await page.waitForFunction(() => document.querySelector("#in-q2").value === "Acme Inc.");
    },
  },
  {
    // the upload never finishes, so the progress bar stays on screen
    name: "uploading",
    view: base,
    hold: true,
    async run(page) {
      await page.locator("#label-i1").locator("xpath=ancestor::li[1]").locator('input[type="file"]:not([capture])').setInputFiles(photo);
      await page.getByText("uploading", { exact: false }).first().waitFor();
    },
  },
  {
    name: "offline-queued",
    view: base,
    async run(page, context, net) {
      net.down = true;
      await context.setOffline(true);
      await page.evaluate(() => dispatchEvent(new Event("offline")));
      await page.locator("#label-i1").locator("xpath=ancestor::li[1]").locator('input[type="file"]:not([capture])').setInputFiles(photo);
      await page.getByText("file waiting to upload").waitFor();
    },
  },
];

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

export function serve() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const path = new URL(req.url, "http://x").pathname;
      const target = path.startsWith("/c/") ? "/c.html" : path;
      try {
        const body = await readFile(join(dist, target));
        res.writeHead(200, { "Content-Type": TYPES[extname(target)] ?? "application/octet-stream" }).end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

// answers the client API from a fixture; `hold` keeps uploads open
export async function mock(page, state) {
  const view = structuredClone(state.view);
  const net = { down: false };
  const shown = () => ({ ...view, items: view.items.filter((i) => !i.when || view.items.find((p) => p.id === i.when[0])?.answer === i.when[1]) });
  await page.route("**/api/c/**", async (route) => {
    const req = route.request();
    if (net.down) return route.abort("internetdisconnected");
    const path = new URL(req.url()).pathname;
    const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "GET") return json(200, shown());
    if (req.method() === "PUT" && path.endsWith("/answer")) {
      const target = view.items.find((i) => path.includes(`/items/${i.id}/`));
      Object.assign(target, { answer: req.postDataJSON().answer, status: req.postDataJSON().answer === null ? "empty" : "submitted" });
      return json(200, { items: shown().items });
    }
    if (req.method() === "PUT") {
      if (state.hold) return;
      return json(201, { id: "new", name: "passport.jpg", size: 100, uploaded_at: Date.now() });
    }
    if (path.endsWith("/notes")) return json(201, { id: "n9", author: "client", body: "x", created_at: Date.now() });
    return json(200, { ok: true });
  });
  return net;
}

export const link = (url) => `${url}/c/${TOKEN}`;
