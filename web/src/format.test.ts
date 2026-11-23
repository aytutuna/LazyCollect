import { describe, expect, it } from "vitest";
import { fmtDay, setZone } from "./format";

describe("fmtDay", () => {
  it("reads a calendar date as the same day in every zone", () => {
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Toronto", "UTC"]) {
      setZone(zone);
      expect([zone, fmtDay("2026-12-31")]).toEqual([zone, "Dec 31, 2026"]);
    }
  });
});
