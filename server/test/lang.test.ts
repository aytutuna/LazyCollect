import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runBatches } from "../src/batches";
import { fromAcceptLanguage, isLang, langOf, longDate, pageLang } from "../src/lang";
import { runReminders } from "../src/reminders";
import { addDays, atHour, dayOf } from "../src/tz";
import { DAY, MINUTE, randomId } from "../src/util";
import { builtinTemplates } from "../src/templates";
import { api, inDays, mockOutbound, pdf, review, setup, start, upload } from "./helpers";

const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

async function ready(clientLocale?: string) {
  const { cookie } = await setup();
  await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  const client = await (
    await api("/api/clients", { method: "POST", cookie, body: { name: "Amy", email: "amy@mail.test", contact_ok: true, ...(clientLocale ? { locale: clientLocale } : {}) } })
  ).json<any>();
  return { cookie, client };
}

const make = async (cookie: string, client: any, extra: object = {}) =>
  (
    await api("/api/requests", {
      method: "POST",
      cookie,
      body: { client_id: client.id, title: "Impôts 2025", deadline: inDays(30), items: [{ label: "Passeport", required: true, translation: true }], ...extra },
    })
  ).json<any>();

describe("language of a request", () => {
  it("reads French of any region and the first language we have", () => {
    expect(fromAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr-CA");
    expect(fromAcceptLanguage("de, en-GB;q=0.8")).toBe("en");
    expect(fromAcceptLanguage("de")).toBe("en");
    expect(fromAcceptLanguage(undefined)).toBe("en");
    expect(isLang("fr")).toBe(false);
    expect(fromAcceptLanguage("fr;q=0,en")).toBe("en");
    expect(fromAcceptLanguage("en;q=0.5, fr;q=0.9")).toBe("fr-CA");
    expect(fromAcceptLanguage("fr;q=0")).toBe("en");
    expect(pageLang("fr-CA", "en")).toBe("fr-CA");
    expect(pageLang("de", "fr")).toBe("fr-CA");
  });

  it("takes X-Lang before the browser's header", () => {
    const c = (h: Record<string, string>) => ({ req: { header: (n: string) => h[n] } });
    expect(langOf(c({ "X-Lang": "fr-CA", "Accept-Language": "en" }))).toBe("fr-CA");
    expect(langOf(c({ "X-Lang": "xx", "Accept-Language": "fr" }))).toBe("fr-CA");
  });

  it("starts in the client's language and keeps it", async () => {
    const { cookie, client } = await ready("fr-CA");
    const req = await make(cookie, client);
    expect(req.locale).toBe("fr-CA");
    const other = await make(cookie, client, { locale: "en" });
    expect(other.locale).toBe("en");
    expect((await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "T", deadline: inDays(5), locale: "de", items: [{ label: "A" }] } })).status).toBe(400);
  });

  it("writes the translation companions in the request's language", async () => {
    const { cookie, client } = await ready();
    const fr = await make(cookie, client, { locale: "fr-CA" });
    expect(fr.items.map((i: any) => i.label)).toEqual([
      "Passeport",
      "Le document « Passeport » est-il en anglais ou en français?",
      "Traduction certifiée de Passeport",
      "Déclaration sous serment du traducteur (si le traducteur n'est pas agréé)",
    ]);
    const en = await make(cookie, client, { locale: "en" });
    expect(en.items[1].label).toBe("Is Passeport in English or French?");
  });

  it("renames the companions in the same language when the document is renamed", async () => {
    const { cookie, client } = await ready();
    const fr = await make(cookie, client, { locale: "fr-CA" });
    const res = await api(`/api/requests/${fr.id}/items/${fr.items[0].id}`, { method: "PATCH", cookie, body: { label: "Acte de naissance" } });
    expect(res.status).toBe(200);
    const after = await (await api(`/api/requests/${fr.id}`, { cookie })).json<any>();
    expect(after.items.map((i: any) => i.label).slice(0, 3)).toEqual([
      "Acte de naissance",
      "Le document « Acte de naissance » est-il en anglais ou en français?",
      "Traduction certifiée de Acte de naissance",
    ]);
  });

  it("shows the client page the request's language", async () => {
    const { cookie, client } = await ready();
    const fr = await make(cookie, client, { locale: "fr-CA" });
    const link = await (await api(`/api/requests/${fr.id}/link`, { method: "POST", cookie })).json<any>();
    const view = await (await api(`/api/c/${link.url.split("/c/")[1]}`)).json<any>();
    expect(view.locale).toBe("fr-CA");
  });
});

describe("built-in templates", () => {
  it("come in the language asked for, with the same shape", async () => {
    const { cookie } = await setup();
    const en = await (await api("/api/templates", { cookie })).json<any[]>();
    const fr = await (await api("/api/templates?locale=fr-CA", { cookie })).json<any[]>();
    expect(en.filter((t) => t.builtin).map((t) => t.name)).toEqual(builtinTemplates.map((t) => t.name));
    expect(fr.filter((t) => t.builtin).map((t) => t.id)).toEqual(builtinTemplates.map((t) => t.id));
    expect(fr.find((t) => t.id === "t1-personal").name).not.toBe(en.find((t) => t.id === "t1-personal").name);
    expect(fr.find((t) => t.id === "t1-personal").locale).toBe("fr-CA");
  });

  it("follow X-Lang when no language is in the query", async () => {
    const { cookie } = await setup();
    const fr = await (await api("/api/templates", { cookie, headers: { "X-Lang": "fr-CA" } })).json<any[]>();
    expect(fr.find((t) => t.id === "t1-personal").locale).toBe("fr-CA");
  });

  it("start a French request with French items", async () => {
    const { cookie, client } = await ready();
    const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "T1", deadline: inDays(30), template_id: "t1-personal", locale: "fr-CA" } });
    const req = await res.json<any>();
    const en = builtinTemplates.find((t) => t.id === "t1-personal")!;
    expect(req.items.length).toBeGreaterThanOrEqual(en.items.length);
    expect(req.items[0].label).not.toBe(en.items[0].label);
  });
});

describe("emails", () => {
  it("send the invite in French to a French request", async () => {
    const { cookie, client } = await ready("fr-CA");
    const sent = mockOutbound();
    const req = await make(cookie, client);
    const res = await api(`/api/requests/${req.id}/link`, { method: "POST", cookie, body: { send_email: true } });
    expect((await res.json<any>()).emailed).toBe(true);
    const mail = sent.at(-1)!;
    expect(mail.subject).toBe("Documents demandés : Impôts 2025");
    expect(mail.text).toContain("Bonjour Amy,");
    expect(mail.text).toContain("Ne plus recevoir ces courriels : https://");
    expect(mail.text).toMatch(/\/u\/na_\w+\?lang=fr-CA/);
    expect(mail.html).toContain('<html lang="fr-CA">');
    expect(mail.html).toContain("Envoyer vos documents");
    expect(mail.text).toMatch(/\d{1,2}(er)? \S+ 20\d\d/);
    expect(mail.text).not.toMatch(/1 \S+ 20\d\d/);
  });

  it("send the invite in English when the request is English", async () => {
    const { cookie, client } = await ready("fr-CA");
    const sent = mockOutbound();
    const req = await make(cookie, client, { locale: "en" });
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie, body: { send_email: true } });
    expect(sent.at(-1)!.subject).toBe("Documents requested: Impôts 2025");
    expect(sent.at(-1)!.html).toContain('<html lang="en">');
  });

  it("send the sign-in code in the language the person uses", async () => {
    const sent = mockOutbound();
    await api("/api/auth/start", { method: "POST", body: { email: "a@firm.test", turnstile: "tok" }, headers: { "X-Lang": "fr-CA" } });
    expect(sent[0].subject).toBe("Votre code de connexion Lazy Collect");
    expect(sent[0].text).toContain("Votre code de connexion est ");
    expect(sent[0].text).toMatch(/\d{6}/);
    await start("b@firm.test");
    expect(sent[1].subject).toBe("Your Lazy Collect sign-in code");
  });

  it("send a staff invite in the inviter's language", async () => {
    const { cookie } = await setup();
    const sent = mockOutbound();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS } });
    const res = await api("/api/staff/invites", { method: "POST", cookie, body: { email: "new@firm.test" }, headers: { "X-Lang": "fr-CA" } });
    expect(res.status).toBe(201);
    expect(sent.at(-1)!.subject).toContain("vous a invité à vous joindre à Tuna Tax sur Lazy Collect");
  });
});

describe("pages opened from an email", () => {
  it("say stop-emails in the language named in the link", async () => {
    const { cookie, client } = await ready("fr-CA");
    const sent = mockOutbound();
    const req = await make(cookie, client);
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie, body: { send_email: true } });
    const url = new URL(sent.at(-1)!.text.match(/https:\/\/\S+\/u\/\S+/)![0]);
    const page = await exports.default.fetch(`https://collect.alazy.app${url.pathname}${url.search}`);
    const html = await page.text();
    expect(html).toContain('<html lang="fr-CA">');
    expect(html).toContain("Ne plus recevoir ces courriels");
    const done = await exports.default.fetch(`https://collect.alazy.app${url.pathname}${url.search}`, { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.9" } });
    expect(await done.text()).toContain("ne vous enverra plus de courriels");
    const en = await exports.default.fetch(`https://collect.alazy.app${url.pathname}`, { headers: { "Accept-Language": "en-CA" } });
    expect(await en.text()).toContain("Stop these emails");
  });

  it("show an expired sign-in link in French to a French browser", async () => {
    const page = await exports.default.fetch("https://collect.alazy.app/api/auth/link?t=nothing", { headers: { "Accept-Language": "fr-CA" } });
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("Ce lien n'est pas valide ou a expiré.");
  });
});

describe("French dates", () => {
  it("write the first of the month as 1er", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(longDate(at("2026-12-01T15:00:00Z"), "fr-CA", "America/Toronto")).toBe("1er décembre 2026");
    expect(longDate(at("2026-12-11T15:00:00Z"), "fr-CA", "America/Toronto")).toBe("11 décembre 2026");
    expect(longDate(at("2026-12-01T15:00:00Z"), "en", "America/Toronto")).toBe("December 1, 2026");
  });
});

describe("the sign-in link page", () => {
  it("follows the language in the link before the browser's", async () => {
    const page = await exports.default.fetch("https://collect.alazy.app/api/auth/link?lang=fr-CA&t=nothing", { headers: { "Accept-Language": "en" } });
    expect(await page.text()).toContain("Ce lien n'est pas valide ou a expiré.");
    const en = await exports.default.fetch("https://collect.alazy.app/api/auth/link?lang=en&t=nothing", { headers: { "Accept-Language": "fr" } });
    expect(await en.text()).toContain("This link is invalid or has expired.");
  });

  it("is named in the email's link", async () => {
    const sent = mockOutbound();
    await api("/api/auth/start", { method: "POST", body: { email: "c@firm.test", turnstile: "tok" }, headers: { "X-Lang": "fr-CA" } });
    expect(sent[0].text).toContain("/api/auth/link?lang=fr-CA&t=");
  });
});

const TZ = "America/Toronto";

describe("the other emails, in French", () => {
  async function frenchRequest() {
    const { cookie, client } = await ready("fr-CA");
    const sent = mockOutbound();
    const req = await make(cookie, client, { items: [{ label: "Passeport", required: true }, { label: "Visa", required: false }] });
    const link = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
    const day = addDays(dayOf(Date.now(), TZ), 4);
    return { cookie, req, sent, path: `/api/c/${link.url.split("/c/")[1]}`, day, tenAm: atHour(day, 10, TZ) };
  }

  it("send the reminder", async () => {
    const { req, sent, tenAm } = await frenchRequest();
    await env.DB_NA.prepare("UPDATE requests SET next_reminder_at = ? WHERE id = ?").bind(tenAm, req.id).run();
    await runReminders(env, tenAm + 5 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Rappel : Impôts 2025, à remettre le /);
    expect(sent[0].text).toContain("Toujours requis :\n- Passeport");
    expect(sent[0].text).toContain("S'ils s'appliquent à vous :\n- Visa");
    expect(sent[0].html).toContain('<html lang="fr-CA">');
  });

  it("send the note after the deadline", async () => {
    const { req, sent, tenAm } = await frenchRequest();
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET deadline = ?, next_reminder_at = ? WHERE id = ?").bind(tenAm - DAY, tenAm, req.id),
      env.DB_NA.prepare("UPDATE links SET expires_at = ? WHERE request_id = ?").bind(tenAm + 30 * DAY, req.id),
    ]);
    await runReminders(env, tenAm + 5 * MINUTE);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Date limite dépassée : Impôts 2025");
    expect(sent[0].text).toContain("est passée et certains documents ne sont pas arrivés");
  });

  it("ask for a file again", async () => {
    const { cookie, req, sent, path, tenAm } = await frenchRequest();
    const item = req.items[0].id;
    await upload(path, item, pdf(500));
    expect((await review(cookie, req.id, item, { decision: "reject", note: "Page 2" })).status).toBe(200);
    await env.DB_NA.prepare("UPDATE requests SET reject_mark_at = ? WHERE id = ?").bind(tenAm, req.id).run();
    await runReminders(env, tenAm + 11 * MINUTE);
    const mail = sent.find((m) => m.subject.startsWith("Veuillez renvoyer"))!;
    expect(mail.subject).toBe("Veuillez renvoyer : Impôts 2025");
    expect(mail.text).toContain("À renvoyer :\n- Passeport (renvoyé : flou ou difficile à lire; Page 2)");
  });

  it("say there is a reply", async () => {
    const { cookie, req, sent, path } = await frenchRequest();
    await api(`${path}/notes`, { method: "POST", body: { body: "Une question" } });
    sent.length = 0;
    const res = await api(`/api/requests/${req.id}/notes`, { method: "POST", cookie, body: { body: "Voici la réponse" } });
    expect((await res.json<any>()).email).toBe("sent");
    expect(sent[0].subject).toBe("Tuna Tax a répondu : Impôts 2025");
    expect(sent[0].text).toContain("a répondu à votre message au sujet de « Impôts 2025 »");
    expect(sent[0].text).not.toContain("Voici la réponse");
  });

  it("go out for a batch in the batch's language", async () => {
    const { cookie } = await setup("batch@firm.test");
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    await api("/api/clients/import", { method: "POST", cookie, body: { rows: [{ name: "Bo", email: "bo@mail.test" }], import_id: randomId(), contact_ok: true } });
    const ids = (await env.DB_NA.prepare("SELECT id FROM clients WHERE email = 'bo@mail.test'").all<{ id: string }>()).results.map((r) => r.id);
    const made = await api("/api/batches", { method: "POST", cookie, body: { template_id: "t1-personal", client_ids: ids, title: "{year} impôts", deadline: inDays(400), reminders_on: true, locale: "fr-CA" } });
    expect(made.status).toBe(201);
    const sent = mockOutbound();
    await runBatches(env, atHour(addDays(dayOf(Date.now(), TZ), 1), 10, TZ));
    const mail = sent.find((m) => m.to[0] === "bo@mail.test")!;
    expect(mail.subject).toMatch(/^Documents demandés : 2027 impôts$/);
    expect(mail.html).toContain('<html lang="fr-CA">');
  });

  it("refuse a batch in a language we do not have", async () => {
    const { cookie } = await setup("batch2@firm.test");
    const res = await api("/api/batches", { method: "POST", cookie, body: { template_id: "t1-personal", client_ids: ["x"], title: "t", deadline: inDays(30), locale: "de" } });
    expect(res.status).toBe(400);
  });
});
