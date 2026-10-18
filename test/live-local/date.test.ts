import { describe, it, expect } from "vitest";
import {
  validateDocumentDate,
  documentDateToUTCDate,
  todayInTimezone,
  requireDocumentDateIsToday,
  isValidTimezone,
  DEFAULT_TIMEZONE,
} from "../../src/live/local/date.js";

describe("validateDocumentDate", () => {
  it("accepts a well-formed ISO date", () => {
    expect(validateDocumentDate("2026-10-18")).toBe("2026-10-18");
  });

  it("refuses a missing value", () => {
    expect(() => validateDocumentDate(undefined)).toThrow(/document_date is required/);
  });

  it("refuses a non-string", () => {
    expect(() => validateDocumentDate(20261018)).toThrow(/document_date is required/);
  });

  it("refuses a differently-formatted date", () => {
    expect(() => validateDocumentDate("18.10.2026")).toThrow(/document_date is required/);
    expect(() => validateDocumentDate("2026/10/18")).toThrow(/document_date is required/);
  });

  it("refuses a calendar date that does not exist", () => {
    expect(() => validateDocumentDate("2026-02-30")).toThrow(/not a real calendar date/);
  });

  it("uses a custom field name in the message", () => {
    expect(() => validateDocumentDate(undefined, "credit_note_date")).toThrow(/credit_note_date is required/);
  });
});

describe("documentDateToUTCDate", () => {
  it("is fixed UTC midnight for the given date, regardless of when it's called", () => {
    const d = documentDateToUTCDate("2026-10-18");
    expect(d.toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });
});

describe("todayInTimezone", () => {
  it("returns an ISO date for a fixed instant", () => {
    // 2026-10-18T10:00:00Z is 12:00 in Europe/Vienna (CEST, UTC+2) — same day either way.
    const now = new Date("2026-10-18T10:00:00.000Z");
    expect(todayInTimezone("Europe/Vienna", now)).toBe("2026-10-18");
    expect(todayInTimezone("UTC", now)).toBe("2026-10-18");
  });

  it("can fall on a different calendar day than UTC near midnight", () => {
    // 2026-10-18T22:30:00Z is 2026-10-19T00:30 in Europe/Vienna (CEST, UTC+2).
    const now = new Date("2026-10-18T22:30:00.000Z");
    expect(todayInTimezone("UTC", now)).toBe("2026-10-18");
    expect(todayInTimezone("Europe/Vienna", now)).toBe("2026-10-19");
  });
});

describe("requireDocumentDateIsToday", () => {
  it("passes when the document date matches today in the given timezone", () => {
    const now = new Date("2026-10-18T10:00:00.000Z");
    expect(() => requireDocumentDateIsToday("2026-10-18", "Europe/Vienna", now)).not.toThrow();
  });

  it("refuses with a clear message naming both dates, proposing today's date", () => {
    const now = new Date("2026-10-18T10:00:00.000Z");
    expect(() => requireDocumentDateIsToday("2026-10-17", "Europe/Vienna", now)).toThrow(
      /dated 2026-10-17, today is 2026-10-18 — propose it again with today's date/
    );
  });
});

describe("isValidTimezone / DEFAULT_TIMEZONE", () => {
  it("accepts a real IANA timezone", () => {
    expect(isValidTimezone("Europe/Vienna")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("refuses an invalid timezone name", () => {
    expect(isValidTimezone("Not/A_Zone")).toBe(false);
  });

  it("defaults to Europe/Vienna", () => {
    expect(DEFAULT_TIMEZONE).toBe("Europe/Vienna");
  });
});
