import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runBatches } from "../src/batches";
import { fromAcceptLanguage, isLang, langOf, longDate, pageLang } from "../src/lang";
import { runReminders } from "../src/reminders";
import { addDays, atHour, dayOf } from "../src/tz";
import { DAY, MINUTE, randomId } from "../src/util";
import { builtinTemplates } from "../src/templates";
import { api, cookieFrom, inDays, mockOutbound, pdf, review, setup, start, upload } from "./helpers";

const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

// the account writes in `account`; with `perClient` it writes to each client in the client's own language instead
async function ready(account: string = "en", client_locale?: string, perClient = false) {
  const { cookie } = await setup();
  await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, phone: "416-555-0100", locale: account, client_langs: perClient } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  const client = await (
    await api("/api/clients", { method: "POST", cookie, body: { name: "Amy", email: "amy@mail.test", contact_ok: true, ...(client_locale ? { locale: client_locale } : {}) } })
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

  it("starts in the account's language, whatever the client's", async () => {
    const french = await ready("fr-CA", "en");
    expect((await make(french.cookie, french.client)).locale).toBe("fr-CA");
    const english = await ready("en", "fr-CA");
    expect((await make(english.cookie, english.client)).locale).toBe("en");
  });

  it("starts in each client's own language when the account asks for that", async () => {
    const { cookie, client } = await ready("en", "fr-CA", true);
    expect((await make(cookie, client)).locale).toBe("fr-CA");
    const other = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Bo", email: "bo@mail.test", contact_ok: true, locale: "en" } })).json<any>();
    expect((await make(cookie, other)).locale).toBe("en");
    await api("/api/firm", { method: "PATCH", cookie, body: { client_langs: false } });
    expect((await make(cookie, client)).locale).toBe("en");
  });

  it("gives a new account the language of the browser that signed up, and a new client the account's", async () => {
    const sent = mockOutbound();
    await api("/api/auth/start", { method: "POST", body: { email: "fr@firm.test", turnstile: "tok" }, headers: { "X-Lang": "fr-CA" } });
    const res = await api("/api/auth/verify", { method: "POST", body: { email: "fr@firm.test", code: sent[0].text.match(/([0-9]{6})/)![1] }, headers: { "X-Lang": "fr-CA" } });
    const cookie = cookieFrom(res);
    expect((await (await api("/api/firm", { cookie })).json<any>()).locale).toBe("fr-CA");
    expect((await env.CONTROL.prepare("SELECT client_langs FROM firms").first<{ client_langs: number }>())!.client_langs).toBe(0);
    const client = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Amy", email: "amy@mail.test", contact_ok: true } })).json<any>();
    expect(client.locale).toBe("fr-CA");
  });

  it("changes the account's language and the switch for owners only, and only to a language we have", async () => {
    const { cookie } = await setup();
    for (const body of [{ locale: "de" }, { locale: "fr" }, { client_langs: "yes" }, { client_langs: 1 }]) {
      expect([body, (await api("/api/firm", { method: "PATCH", cookie, body })).status]).toEqual([body, 400]);
    }
    expect((await api("/api/firm", { method: "PATCH", cookie, body: { locale: "fr-CA", client_langs: true } })).status).toBe(200);
    const firm = await (await api("/api/firm", { cookie })).json<any>();
    expect([firm.locale, firm.client_langs]).toEqual(["fr-CA", 1]);
  });

  it("writes the translation companions in the request's language", async () => {
    const { cookie, client } = await ready("fr-CA");
    const fr = await make(cookie, client);
    expect(fr.items.map((i: any) => i.label)).toEqual([
      "Passeport",
      "Le document « Passeport » est-il en anglais ou en français?",
      "Traduction certifiée de Passeport",
      "Déclaration sous serment du traducteur (si le traducteur n'est pas agréé)",
    ]);
    await api("/api/firm", { method: "PATCH", cookie, body: { locale: "en" } });
    const en = await make(cookie, client);
    expect(en.items[1].label).toBe("Is Passeport in English or French?");
  });

  it("renames the companions in the same language when the document is renamed", async () => {
    const { cookie, client } = await ready("fr-CA");
    const fr = await make(cookie, client);
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
    const { cookie, client } = await ready("fr-CA");
    const fr = await make(cookie, client);
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

  it("come in the account's language when none is asked for", async () => {
    const { cookie } = await ready("fr-CA");
    const list = await (await api("/api/templates", { cookie })).json<any[]>();
    expect(list.find((t) => t.id === "t1-personal").locale).toBe("fr-CA");
  });

  it("do not follow the language of the screen", async () => {
    const { cookie } = await setup();
    const list = await (await api("/api/templates", { cookie, headers: { "X-Lang": "fr-CA" } })).json<any[]>();
    expect(list.find((t) => t.id === "t1-personal").locale).toBe("en");
  });

  it("start a French request with French items", async () => {
    const { cookie, client } = await ready("fr-CA");
    const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "T1", deadline: inDays(30), template_id: "t1-personal", tax_year: 2026 } });
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
    expect(mail.text).not.toMatch(/1 \S+ 20\d\d/);
  });

  it("send the invite in English to an English account, whatever the client reads", async () => {
    const { cookie, client } = await ready("en", "fr-CA");
    const sent = mockOutbound();
    const req = await make(cookie, client);
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

  it("send a staff invite in the account's language", async () => {
    const { cookie } = await setup();
    const sent = mockOutbound();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, locale: "fr-CA" } });
    const res = await api("/api/staff/invites", { method: "POST", cookie, body: { email: "new@firm.test" } });
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

  it("go out for a batch in the account's language", async () => {
    const { cookie } = await setup("batch@firm.test");
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, locale: "fr-CA" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    await api("/api/clients/import", { method: "POST", cookie, body: { rows: [{ name: "Bo", email: "bo@mail.test" }], import_id: randomId(), contact_ok: true } });
    const ids = (await env.DB_NA.prepare("SELECT id FROM clients WHERE email = 'bo@mail.test'").all<{ id: string }>()).results.map((r) => r.id);
    const made = await api("/api/batches", { method: "POST", cookie, body: { template_id: "t1-personal", client_ids: ids, title: "{year} impôts", deadline: inDays(400), reminders_on: true, tax_year: 2026 } });
    expect(made.status).toBe(201);
    const sent = mockOutbound();
    await runBatches(env, atHour(addDays(dayOf(Date.now(), TZ), 1), 10, TZ));
    const mail = sent.find((m) => m.to[0] === "bo@mail.test")!;
    expect(mail.subject).toMatch(/^Documents demandés : 2026 impôts$/);
    expect(mail.html).toContain('<html lang="fr-CA">');
  });

  it("go out in each client's own language when the account asks for that", async () => {
    const { cookie } = await setup("batch3@firm.test");
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, client_langs: true } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const ids: string[] = [];
    for (const [name, email, locale] of [["Bo", "bo@mail.test", "en"], ["Chloé", "chloe@mail.test", "fr-CA"]]) {
      ids.push((await (await api("/api/clients", { method: "POST", cookie, body: { name, email, locale, contact_ok: true } })).json<any>()).id);
    }
    const made = await api("/api/batches", { method: "POST", cookie, body: { template_id: "t1-personal", client_ids: ids, title: "Taxes {year}", deadline: inDays(400), reminders_on: true, tax_year: 2026 } });
    expect(made.status).toBe(201);
    const sent = mockOutbound();
    await runBatches(env, atHour(addDays(dayOf(Date.now(), TZ), 1), 10, TZ));
    expect(sent.find((m) => m.to[0] === "bo@mail.test")!.subject).toBe("Documents requested: Taxes 2026");
    expect(sent.find((m) => m.to[0] === "chloe@mail.test")!.subject).toBe("Documents demandés : Taxes 2026");
    const rows = (await env.DB_NA.prepare("SELECT r.locale, i.label FROM requests r JOIN items i ON i.request_id = r.id WHERE i.position = 0 ORDER BY r.locale").all<{ locale: string; label: string }>()).results;
    expect(rows).toEqual([
      { locale: "en", label: "Notice of assessment for 2025" },
      { locale: "fr-CA", label: "Avis de cotisation de 2025" },
    ]);
  });
});

describe("the zip's text files", () => {
  it("are written in the account's language", async () => {
    const { cookie, client } = await ready("fr-CA");
    mockOutbound();
    const req = await make(cookie, client);
    const link = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
    await api(`/api/c/${link.url.split("/c/")[1]}/notes`, { method: "POST", body: { body: "Une question" } });
    await api(`/api/requests/${req.id}/notes`, { method: "POST", cookie, body: { body: "Voici la réponse" } });
    const res = await api(`/api/requests/${req.id}/export`, { cookie });
    const raw = new TextDecoder("latin1").decode(new Uint8Array(await res.arrayBuffer()));
    expect(raw).toContain("messages.txt");
    expect(raw).toMatch(/UTC, client\nUne question\n/);
    expect(raw).toContain("UTC, compte\n");
  });
});

describe("imported clients", () => {
  it("start in the account's language", async () => {
    const { cookie } = await setup("import@firm.test");
    await api("/api/firm", { method: "PATCH", cookie, body: { locale: "fr-CA" } });
    await api("/api/clients/import", { method: "POST", cookie, body: { rows: [{ name: "Bo", email: "bo@mail.test" }], import_id: randomId(), contact_ok: true } });
    expect((await env.DB_NA.prepare("SELECT locale FROM clients WHERE email = 'bo@mail.test'").first<{ locale: string }>())!.locale).toBe("fr-CA");
  });
});
