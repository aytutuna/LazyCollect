import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FAMILY, family } from "./family";
import { api, inDays, pdf, setup, upload } from "./helpers";

const ITEMS = [
  { label: "Birth certificate", help: "Both sides", required: true, translation: true },
  { label: "Photo", required: false },
];

async function make(items: unknown[] = ITEMS) {
  const { cookie, client } = await setup();
  const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Study permit", deadline: inDays(30), items } })).json<any>();
  const link = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
  return { cookie, req, path: `/api/c/${link.url.split("/c/")[1]}` };
}

const labels = (req: any) => req.items.map((i: any) => i.label);
const shown = async (path: string) => (await (await api(path)).json<any>()).items.map((i: any) => i.label);
const answer = (path: string, item: string, value: unknown) => api(`${path}/items/${item}/answer`, { method: "PUT", body: { answer: value } });
const status = async (id: string) => (await env.DB_NA.prepare("SELECT status FROM requests WHERE id = ?").bind(id).first<any>())!.status;

describe("a document that may need a translation", () => {
  it("comes with a question and two companions that are linked to it", async () => {
    const { req } = await make();
    expect(labels(req)).toEqual([
      "Birth certificate",
      "Is Birth certificate in English or French?",
      "Certified translation of Birth certificate",
      "Translator's affidavit (if the translator is not certified)",
      "Photo",
    ]);
    expect(req.items.map((i: any) => [i.position, i.kind, i.companion, i.for_pos, i.show_if_pos, i.show_if_value, i.required])).toEqual([
      [0, "file", null, null, null, null, true],
      [1, "yesno", "question", 0, null, null, true],
      [2, "file", "translation", 0, 1, "no", true],
      [3, "file", "affidavit", 0, 1, "no", false],
      [4, "file", null, null, null, null, false],
    ]);
    expect(req.items[0].translation).toBe(true);
    expect(req.items[1].translation).toBe(false);
    // the help does not claim to say what the law requires
    expect(req.items[3].help).toContain("Check IRCC's instructions");
    for (const i of req.items.slice(1, 4)) expect(i.help.length).toBeLessThanOrEqual(500);
  });

  it("shows the question to the client, and the companions only when the answer is no", async () => {
    const { req, path } = await make();
    expect(await shown(path)).toEqual(["Birth certificate", "Is Birth certificate in English or French?", "Photo"]);
    expect((await answer(path, req.items[1].id, "no")).status).toBe(200);
    expect(await shown(path)).toEqual([
      "Birth certificate",
      "Is Birth certificate in English or French?",
      "Certified translation of Birth certificate",
      "Translator's affidavit (if the translator is not certified)",
      "Photo",
    ]);
    await answer(path, req.items[1].id, "yes");
    expect(await shown(path)).toEqual(["Birth certificate", "Is Birth certificate in English or French?", "Photo"]);
  });

  it("is not complete until the question is answered and, for a no, the translation is in", async () => {
    const { req, path } = await make();
    await upload(path, req.items[0].id, pdf(100));
    expect(await status(req.id)).toBe("open");
    await answer(path, req.items[1].id, "no");
    expect(await status(req.id)).toBe("open");
    await upload(path, req.items[2].id, pdf(100));
    // the affidavit is only asked for if the translator is not certified, so it is not needed
    expect(await status(req.id)).toBe("complete");
    await answer(path, req.items[1].id, "yes");
    expect(await status(req.id)).toBe("complete");
  });

  it("follows a rename of the document, and stops following a companion that was renamed by hand", async () => {
    const { cookie, req } = await make();
    const patch = (item: any, label: string) => api(`/api/requests/${req.id}/items/${item.id}`, { method: "PATCH", cookie, body: { label } });
    await patch(req.items[0], "Long-form birth certificate");
    let now = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(labels(now).slice(0, 3)).toEqual([
      "Long-form birth certificate",
      "Is Long-form birth certificate in English or French?",
      "Certified translation of Long-form birth certificate",
    ]);
    await patch(req.items[2], "Translation by Mr Khan");
    await patch(req.items[0], "Birth certificate");
    now = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(labels(now).slice(0, 3)).toEqual(["Birth certificate", "Is Birth certificate in English or French?", "Translation by Mr Khan"]);
  });

  it("goes with its companions when removed, unless the client has started on them", async () => {
    const { cookie, req, path } = await make();
    const del = (item: any) => api(`/api/requests/${req.id}/items/${item.id}`, { method: "DELETE", cookie });
    // the question has the companions waiting on it
    expect((await del(req.items[1])).status).toBe(409);
    await answer(path, req.items[1].id, "no");
    expect(await (await del(req.items[0])).json()).toEqual({ error: "has_translation" });
    await answer(path, req.items[1].id, null);
    expect((await del(req.items[0])).status).toBe(200);
    expect(labels(await (await api(`/api/requests/${req.id}`, { cookie })).json<any>())).toEqual(["Photo"]);
  });

  it("is hidden along with its question and companions once the document is waived", async () => {
    const { cookie, req, path } = await make();
    await env.DB_NA.prepare("UPDATE items SET status = 'waived' WHERE id = ?").bind(req.items[0].id).run();
    await api(`/api/requests/${req.id}/items/${req.items[4].id}`, { method: "PATCH", cookie, body: { help: "x" } });
    expect(await shown(path)).toEqual(["Birth certificate", "Photo"]);
    const now = await (await api(`/api/requests/${req.id}`, { cookie })).json<any>();
    expect(now.items.map((i: any) => i.hidden)).toEqual([false, true, true, true, false]);
    expect(await status(req.id)).toBe("complete");
    // answering the question that is out of sight does nothing
    expect((await answer(path, req.items[1].id, "no")).status).toBe(409);
  });

  it("is not renamed by a label sent back as it was", async () => {
    const { cookie, req } = await make();
    const patch = (item: any, label: string) => api(`/api/requests/${req.id}/items/${item.id}`, { method: "PATCH", cookie, body: { label } });
    expect((await patch(req.items[2], req.items[2].label)).status).toBe(200);
    expect((await env.DB_NA.prepare("SELECT companion FROM items WHERE id = ?").bind(req.items[2].id).first<any>())!.companion).toBe("translation");
    await patch(req.items[0], "Long certificate");
    expect(labels(await (await api(`/api/requests/${req.id}`, { cookie })).json<any>())[2]).toBe("Certified translation of Long certificate");
  });

  it("cannot be the question another item waits on", async () => {
    const { cookie, req } = await make();
    const res = await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Why not?", show_if: { item: 1, value: "no" } } });
    expect(res.status).toBe(400);
  });

  it("can be added to an existing request", async () => {
    const { cookie, req } = await make([{ label: "Photo" }]);
    const res = await api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body: { label: "Diploma", translation: true } });
    expect(res.status).toBe(201);
    expect(labels(await res.json<any>())).toEqual([
      "Photo",
      "Diploma",
      "Is Diploma in English or French?",
      "Certified translation of Diploma",
      "Translator's affidavit (if the translator is not certified)",
    ]);
  });

  it("is made for each person that has the document, with the person's name in each label", async () => {
    const items = [{ label: "Passport", per_person: "everyone", required: true, translation: true }];
    const { req } = await family({ items, people: FAMILY.slice(0, 2) });
    expect(labels(req)).toEqual([
      "Passport — Omar Haddad",
      "Is Passport — Omar Haddad in English or French?",
      "Certified translation of Passport — Omar Haddad",
      "Translator's affidavit (if the translator is not certified)",
      "Passport — Amira Haddad",
      "Is Passport — Amira Haddad in English or French?",
      "Certified translation of Passport — Amira Haddad",
      "Translator's affidavit (if the translator is not certified)",
    ]);
    expect(req.items.map((i: any) => [i.person_pos, i.for_pos])).toEqual([[0, null], [0, 0], [0, 0], [0, 0], [1, null], [1, 4], [1, 4], [1, 4]]);
    expect(req.items.map((i: any) => i.show_if_pos)).toEqual([null, null, 1, 1, null, null, 5, 5]);
  });

  it("is asked for when a person is added later and goes when the person does", async () => {
    const items = [{ label: "Passport", per_person: "everyone", required: true, translation: true }];
    const { cookie, req } = await family({ items, people: FAMILY.slice(0, 1) });
    const added = await (await api(`/api/requests/${req.id}/people`, { method: "POST", cookie, body: FAMILY[1] })).json<any>();
    expect(added.items).toHaveLength(8);
    expect(added.items.slice(4).map((i: any) => [i.position, i.for_pos, i.show_if_pos])).toEqual([[4, null, null], [5, 4, null], [6, 4, 5], [7, 4, 5]]);
    const removed = await (await api(`/api/requests/${req.id}/people/${added.people[1].id}`, { method: "DELETE", cookie })).json<any>();
    expect(removed.items).toHaveLength(4);
  });

  it("asks nothing of a question and takes no translation flag on a conditional item", async () => {
    const { cookie, req } = await make();
    const post = (body: unknown) => api(`/api/requests/${req.id}/items`, { method: "POST", cookie, body });
    expect((await post({ label: "x", kind: "text", translation: true })).status).toBe(400);
    expect((await post({ label: "x", translation: true, show_if: { item: 1, value: "no" } })).status).toBe(400);
    expect((await post({ label: "x", translation: false })).status).toBe(201);
  });
});
