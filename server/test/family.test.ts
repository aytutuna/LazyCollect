import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runReminders } from "../src/reminders";
import { atHour } from "../src/tz";
import { MINUTE } from "../src/util";
import { FAMILY, family } from "./family";
import { api, mockOutbound, pdf, upload } from "./helpers";

// the entries of a stored zip by name
function unzip(buf: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = buf.length - 22;
  const out = new Map<string, Uint8Array>();
  let at = v.getUint32(eocd + 16, true);
  for (let i = 0, n = v.getUint16(eocd + 10, true); i < n; i++) {
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    out.set(new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen)), buf.slice(start, start + size));
    at += 46 + nameLen + 9;
  }
  return out;
}

async function ready(over: Record<string, unknown> = {}) {
  const made = await family(over);
  await api("/api/firm", { method: "PATCH", cookie: made.cookie, body: { address: "12 King St W, Toronto ON M5H 1A1" } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  const link = await (await api(`/api/requests/${made.req.id}/link`, { method: "POST", cookie: made.cookie })).json<any>();
  return { ...made, path: `/api/c/${link.url.split("/c/")[1]}` };
}

describe("reminders for a family", () => {
  it("name the person after each document and keep a person's documents together", async () => {
    const { cookie, req } = await ready({ people: FAMILY.slice(0, 2) });
    const sent = mockOutbound();
    expect((await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie })).status).toBe(200);
    const lines = sent[0].text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([
      "- Marriage certificate",
      "- Passport (Omar Haddad)",
      "- Police certificate (Omar Haddad)",
      "- Job offer (Omar Haddad)",
      "- Passport (Amira Haddad)",
      "- Police certificate (Amira Haddad)",
      "- Spouse's employment letter (Amira Haddad)",
    ]);
    expect(sent[0].text).not.toContain("—");
    expect(sent[0].html).toContain("Passport (Amira Haddad)");
  });

  it("stop listing a person's documents once they are in and when the person is gone", async () => {
    const { cookie, req, path } = await ready({ people: FAMILY.slice(0, 2) });
    const amira = req.items.filter((i: any) => i.person_pos === 1);
    await upload(path, amira[0].id, pdf(100));
    await api(`/api/requests/${req.id}/people/${req.people[0].id}?confirm=1`, { method: "DELETE", cookie });
    const sent = mockOutbound();
    await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    expect(sent[0].text.split("\n").filter((l) => l.startsWith("- "))).toEqual(["- Marriage certificate", "- Police certificate (Amira Haddad)", "- Spouse's employment letter (Amira Haddad)"]);
  });

  it("are sent by the cron in the same words", async () => {
    const { req } = await ready({ people: FAMILY.slice(0, 2) });
    const sent = mockOutbound();
    const day = new Date(Date.now() + 3 * 86_400_000);
    await env.DB_NA.prepare("UPDATE requests SET next_reminder_at = 1 WHERE id = ?").bind(req.id).run();
    await runReminders(env, atHour({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() }, 11, "America/Toronto") + 5 * MINUTE);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].text).toContain("Passport (Amira Haddad)");
  });
});

describe("the export of a family", () => {
  async function filed() {
    const made = await ready({ people: [...FAMILY.slice(0, 2), { role: "other", name: "Amira Haddad" }, { role: "other", name: "A/B: C" }] });
    const { req, path, cookie } = made;
    const find = (label: string) => req.items.find((i: any) => i.label === label);
    const send = async (label: string, name: string) => expect((await upload(path, find(label).id, pdf(200), { name })).status).toBe(201);
    await send("Marriage certificate", "marriage.pdf");
    await send("Passport — Omar Haddad", "omar.pdf");
    await send("Passport — Amira Haddad", "amira.pdf");
    await send("Passport — A/B: C", "abc.pdf");
    expect((await upload(path, req.items.find((i: any) => i.person_pos === 2 && i.label.startsWith("Passport")).id, pdf(200), { name: "twin.pdf" })).status).toBe(201);
    const patch = (label: string, body: unknown) => api(`/api/requests/${req.id}/items/${find(label).id}`, { method: "PATCH", cookie, body });
    await patch("Passport — Omar Haddad", { expires_on: "2031-05-01" });
    await patch("Police certificate — Omar Haddad", { issued_on: "2026-01-15" });
    return made;
  }

  it("has a folder for each person, named once, and one for what is not a person's", async () => {
    const { cookie, req } = await filed();
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    expect(res.status).toBe(200);
    const names = [...unzip(new Uint8Array(await res.arrayBuffer())).keys()].sort();
    expect(names).toEqual(["Amira Haddad (2)/Passport/1.pdf", "Amira Haddad/Passport/1.pdf", "A_B_ C/Passport/1.pdf", "Marriage certificate/1.pdf", "Omar Haddad/Passport/1.pdf", "checklist.txt"].sort());
  });

  it("lists the dates of documents in checklist.txt", async () => {
    const { cookie, req } = await filed();
    const entries = unzip(new Uint8Array(await (await api(`/api/requests/${req.id}/export`, { cookie })).arrayBuffer()));
    const text = new TextDecoder().decode(entries.get("checklist.txt")!);
    expect(text).toContain("Passport — Omar Haddad\n  expires 2031-05-01\n");
    expect(text).toContain("Police certificate — Omar Haddad\n  issued 2026-01-15, good for 6 months, until 2026-07-15\n");
    expect(text).not.toContain("Marriage");
  });

  it("is refused to another account", async () => {
    const { req } = await filed();
    const other = await family({}, "b@two.test");
    expect((await api(`/api/requests/${req.id}/export`, { cookie: other.cookie })).status).toBe(404);
  });
});
