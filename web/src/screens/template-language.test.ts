import { describe, expect, it } from "vitest";
import { followLanguage } from "./template-language";

const found = { name: "Aide-mémoire T1" };

describe("followLanguage", () => {
  it("swaps the items and the title of an untouched built-in checklist", () => {
    expect(followLanguage(found, false, "T1 organizer", "T1 organizer")).toEqual({ items: true, title: "Aide-mémoire T1" });
  });

  it("keeps edited items", () => {
    expect(followLanguage(found, true, "T1 organizer", "T1 organizer")).toEqual({ items: false, title: "Aide-mémoire T1" });
  });

  it("keeps a title the person typed", () => {
    expect(followLanguage(found, false, "Amy's taxes", "T1 organizer")).toEqual({ items: true, title: null });
  });

  it("leaves a checklist that is not a built-in one", () => {
    expect(followLanguage(undefined, false, "x", "x")).toEqual({ items: false, title: null });
  });
});
