/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { builtinTemplates } from "../src/templates";
import { api, inDays, setup } from "./helpers";

const ircc = builtinTemplates.filter((t) => t.id.startsWith("ircc-"));
const sources = import.meta.glob("../templates/ircc-*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("IRCC templates", () => {
  it("covers the programs", () => {
    expect(ircc.map((t) => t.id)).toEqual([
      "ircc-express-entry",
      "ircc-spousal-sponsorship",
      "ircc-study-permit",
      "ircc-pgwp",
      "ircc-work-permit",
      "ircc-work-permit-extension",
      "ircc-visitor-visa",
      "ircc-citizenship",
    ]);
  });

  it("each names its sources and the month it was checked", () => {
    expect(Object.keys(sources)).toHaveLength(ircc.length);
    for (const [file, src] of Object.entries(sources)) {
      const header = src.split("\n").filter((l) => l.startsWith("//"));
      expect([file, header[0]]).toEqual([file, expect.stringContaining("Checked 2026-11")]);
      expect([file, header.some((l) => l.includes("canada.ca"))]).toEqual([file, true]);
    }
  });

  it("ask yes/no questions and hang documents on them", () => {
    for (const t of ircc) {
      const asked = t.items.filter((i) => i.kind === "yesno").length;
      const hung = t.items.filter((i) => i.show_if).length;
      expect([t.id, asked >= 3, hung >= asked]).toEqual([t.id, true, true]);
      for (const [at, i] of t.items.entries()) {
        if (i.show_if) expect([t.id, i.label, t.items[i.show_if.item].kind, i.show_if.item < at]).toEqual([t.id, i.label, "yesno", true]);
      }
    }
  });

  it("ask for police certificates of each adult, optional and counted from the issue date, and keep the medical exam optional for a study permit", () => {
    for (const t of ircc) {
      const police = t.items.filter((i) => /^Police certificate/.test(i.label));
      expect(police.length).toBe(1);
      expect([t.id, police[0]]).toMatchObject([t.id, { per_person: "adults", required: false, expiry: "issue", valid_months: 6, translation: true }]);
      expect(police[0].show_if).toBeUndefined();
    }
    const study = ircc.find((t) => t.id === "ircc-study-permit")!;
    expect(study.items.find((i) => i.label === "Medical exam receipt")!.required).toBe(false);
  });

  it("send Quebec applicants to the CAQ and everyone else to the PAL", () => {
    const study = ircc.find((t) => t.id === "ircc-study-permit")!;
    const caq = study.items.find((i) => /CAQ/.test(i.label))!;
    expect(study.items[caq.show_if!.item].label).toBe("Will you study in Quebec?");
    const pal = study.items.find((i) => /^Provincial attestation letter/.test(i.label))!;
    expect(study.items[pal.show_if!.item].label).toMatch(/attestation letter/);
  });

  it("ask for the language test only of PGWP applicants under the 2024 rules", () => {
    const pgwp = ircc.find((t) => t.id === "ircc-pgwp")!;
    const lang = pgwp.items.find((i) => i.label === "Language test results")!;
    expect(pgwp.items[lang.show_if!.item].label).toContain("November 1, 2024");
  });

  it("ask for passports, police certificates, medicals and photos once for each person", () => {
    for (const t of ircc) {
      const by = (re: RegExp) => t.items.filter((i) => re.test(i.label));
      expect([t.id, by(/^Passport/).map((i) => i.per_person)]).toEqual([t.id, ["everyone"]]);
      for (const i of by(/^Digital photo|^Medical exam/)) expect([t.id, i.label, i.per_person]).toEqual([t.id, i.label, "everyone"]);
      for (const i of by(/^Medical exam/)) expect([i.expiry, i.valid_months]).toEqual(["issue", 12]);
      for (const i of by(/^Passport$/)) expect(i.expiry).toBe("expiry");
    }
  });

  it("start a request for a principal, a spouse and a child with each person's documents and hidden ones until the answer is yes", async () => {
    const { cookie, client } = await setup();
    const people = [{ role: "principal", name: "Omar Haddad" }, { role: "spouse", name: "Amira Haddad" }, { role: "child", name: "Layla Haddad", dob: "2015-06-01" }];
    const count = { everyone: 3, adults: 2 } as Record<string, number>;
    for (const t of ircc) {
      const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: t.name, deadline: inDays(5), template_id: t.id, people } });
      expect([t.id, res.status]).toEqual([t.id, 201]);
      const req = await res.json<any>();
      const sets = t.items.reduce((n, i) => n + (i.translation ? (i.per_person ? count[i.per_person] : 1) : 0), 0);
      const expected = t.items.reduce((n, i) => n + (i.per_person ? count[i.per_person] : 1), 0) + sets * 3;
      expect([t.id, req.items.length]).toEqual([t.id, expected]);
      expect(req.items.filter((i: any) => i.hidden).length).toBe(t.items.filter((i) => i.show_if).length + sets * 2);
      const labels = req.items.map((i: any) => i.label);
      for (const name of ["Omar Haddad", "Amira Haddad", "Layla Haddad"]) expect([t.id, labels.filter((l: string) => l.startsWith("Passport") && l.endsWith(name)).length]).toEqual([t.id, 1]);
      expect(labels.filter((l: string) => /^Police certificate/.test(l)).length).toBe(2);
      expect(req.items.filter((i: any) => i.expiry_rule && i.person_pos === null)).toEqual([]);
    }
  });
});
