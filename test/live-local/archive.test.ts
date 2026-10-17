import { describe, it, expect, afterEach } from "vitest";
import { writeOnce, readAndVerify, archivePath, sha256 } from "../../src/live/local/archive.js";
import { tmpDataDir, cleanupDataDir } from "./fixtures.js";

let dataDir: string;
afterEach(() => { if (dataDir) cleanupDataDir(dataDir); });

describe("writeOnce", () => {
  it("writes the file and returns its sha256", () => {
    dataDir = tmpDataDir("archive-write");
    const path = archivePath(dataDir, 2026, "2026-0001");
    const buf = Buffer.from("hello pdf");
    const result = writeOnce(path, buf);
    expect(result.path).toBe(path);
    expect(result.sha256).toBe(sha256(buf));
  });

  it("refuses to overwrite an existing file", () => {
    dataDir = tmpDataDir("archive-overwrite");
    const path = archivePath(dataDir, 2026, "2026-0001");
    writeOnce(path, Buffer.from("first"));
    expect(() => writeOnce(path, Buffer.from("second"))).toThrow(/already exists/);
  });

  it("one shared directory per year holds both invoices and credit notes without collision (one numbering namespace)", () => {
    dataDir = tmpDataDir("archive-shared-namespace");
    const invoicePath = archivePath(dataDir, 2026, "2026-0001");
    const creditNotePath = archivePath(dataDir, 2026, "2026-G0001");
    expect(invoicePath).not.toBe(creditNotePath);
    expect(() => writeOnce(invoicePath, Buffer.from("invoice"))).not.toThrow();
    expect(() => writeOnce(creditNotePath, Buffer.from("credit note"))).not.toThrow();
  });
});

describe("readAndVerify", () => {
  it("returns the bytes when the sha256 matches", () => {
    dataDir = tmpDataDir("archive-read-ok");
    const path = archivePath(dataDir, 2026, "2026-0001");
    const buf = Buffer.from("content");
    const { sha256: hash } = writeOnce(path, buf);
    expect(readAndVerify(path, hash)).toEqual(buf);
  });

  it("refuses when the file no longer matches its stored fingerprint", () => {
    dataDir = tmpDataDir("archive-read-mismatch");
    const path = archivePath(dataDir, 2026, "2026-0001");
    writeOnce(path, Buffer.from("content"));
    expect(() => readAndVerify(path, "0000000000000000000000000000000000000000000000000000000000000000")).toThrow(/does not match/);
  });

  it("refuses when the file does not exist", () => {
    dataDir = tmpDataDir("archive-read-missing");
    const path = archivePath(dataDir, 2026, "2026-9999");
    expect(() => readAndVerify(path, "abc")).toThrow(/could not read/);
  });
});
