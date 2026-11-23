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

  it("show police certificates only to someone who lived abroad and keep the medical exam optional for a study permit", () => {
    for (const t of ircc) {
      const police = t.items.filter((i) => /^Police certificate/.test(i.label));
      expect(police.length).toBe(1);
      expect(t.items[police[0].show_if!.item].label).toMatch(/lived in .*(another|other) country|a country other than/);
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

  it("start a request with hidden documents until the answer is yes", async () => {
    const { cookie, client } = await setup();
    for (const t of ircc) {
      const res = await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: t.name, deadline: inDays(5), template_id: t.id } });
      expect([t.id, res.status]).toEqual([t.id, 201]);
      const req = await res.json<any>();
      expect(req.items).toHaveLength(t.items.length);
      expect(req.items.filter((i: any) => i.hidden).length).toBe(t.items.filter((i) => i.show_if).length);
    }
  });
});
