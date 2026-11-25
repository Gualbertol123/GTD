import { describe, expect, it } from "vitest";
import { isMissingColumn } from "../saveErrors";

describe("isMissingColumn", () => {
  it("is a missing column only for PGRST204 and 42703", () => {
    expect(isMissingColumn({ code: "PGRST204", message: "Could not find the 'report_hidden' column of 'projects' in the schema cache" })).toBe(true);
    expect(isMissingColumn({ code: "42703", message: "column projects.report_hidden does not exist" })).toBe(true);
  });

  it("is not for a refusal, a network error or anything else", () => {
    expect(isMissingColumn({ code: "42501", message: "new row violates row-level security policy" })).toBe(false);
    expect(isMissingColumn(new TypeError("Failed to fetch"))).toBe(false);
    expect(isMissingColumn("PGRST204")).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});
