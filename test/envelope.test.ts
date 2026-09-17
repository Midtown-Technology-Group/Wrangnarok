// SPDX-License-Identifier: AGPL-3.0
// SEC-02 envelope units (issue #411, P4 matrix): AES-GCM-256 envelope
// round-trip, wrong-org/Connection/field/KEK failure, tamper rejection,
// nonce uniqueness, decrypt-with-version rotation, and input validation.
// Pure crypto — no D1, no Workflows. Fixture sentinels only.
import { describe, expect, it } from "vitest";
import {
  decryptConnectionSecret,
  ENVELOPE_ALGORITHM,
  ENVELOPE_KEY_VERSION,
  encryptConnectionSecret,
  EnvelopeError,
} from "../src/envelope";

const KEK = "test-kek-material-sentinel";
const KEK_NEXT = "test-kek-rotation-sentinel";
const WRONG_KEK = "test-wrong-kek-sentinel";
const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER_ORG = "00000000-0000-4000-8000-000000000004";
const CONN = "00000000-0000-4000-8000-000000000010";
const FIELD = "apiToken";
const VALUE = "test-per-org-secret-value-sentinel";

async function sealed(overrides: Partial<Parameters<typeof encryptConnectionSecret>[0]> = {}) {
  return encryptConnectionSecret({
    orgId: ORG,
    connectionId: CONN,
    field: FIELD,
    plaintext: VALUE,
    kekMaterial: KEK,
    ...overrides,
  });
}

async function opened(
  row: Awaited<ReturnType<typeof encryptConnectionSecret>>,
  overrides: Partial<Parameters<typeof decryptConnectionSecret>[0]> = {},
) {
  return decryptConnectionSecret({
    orgId: ORG,
    connectionId: CONN,
    field: FIELD,
    row,
    keks: { [ENVELOPE_KEY_VERSION]: KEK },
    ...overrides,
  });
}

describe("connection secret envelope (SEC-02)", () => {
  it("round-trips with the stamped row shape", async () => {
    const row = await sealed();
    expect(row.algorithm).toBe(ENVELOPE_ALGORITHM);
    expect(row.keyVersion).toBe(ENVELOPE_KEY_VERSION);
    expect(row.ciphertext.length).toBeGreaterThan(0);
    expect(row.nonce.length).toBeGreaterThan(0);
    expect(row.wrappedDek.length).toBeGreaterThan(0);
    expect(await opened(row)).toBe(VALUE);
  });

  it("fails closed on wrong org, Connection, field, or KEK", async () => {
    const row = await sealed();
    await expect(opened(row, { orgId: OTHER_ORG })).rejects.toMatchObject({ name: "EnvelopeError" });
    await expect(opened(row, { connectionId: "00000000-0000-4000-8000-000000000099" })).rejects.toThrow(
      "ENVELOPE_DECRYPT_FAILED",
    );
    await expect(opened(row, { field: "clientSecret" })).rejects.toThrow("ENVELOPE_DECRYPT_FAILED");
    await expect(opened(row, { keks: { [ENVELOPE_KEY_VERSION]: WRONG_KEK } })).rejects.toThrow(
      "ENVELOPE_DECRYPT_FAILED",
    );
    // A copied row is useless under another tenant: the AAD binds all three.
    await expect(opened(row, { orgId: OTHER_ORG })).rejects.toThrow("ENVELOPE_DECRYPT_FAILED");
  });

  it("rejects unversioned rows and short nonces without touching subtle", async () => {
    const row = await sealed();
    await expect(opened({ ...row, keyVersion: 0 })).rejects.toThrow("ENVELOPE_UNKNOWN_KEY_VERSION");
    await expect(opened({ ...row, nonce: btoa("short") })).rejects.toThrow("ENVELOPE_DECRYPT_FAILED");
  });

  it("rejects unknown algorithm and unknown key versions without touching subtle", async () => {
    const row = await sealed();
    await expect(opened({ ...row, algorithm: "AES-CBC-128" })).rejects.toThrow("ENVELOPE_UNKNOWN_ALGORITHM");
    await expect(opened(row, { keks: {} })).rejects.toThrow("ENVELOPE_UNKNOWN_KEY_VERSION");
    await expect(opened(row, { keks: { 999: KEK } })).rejects.toThrow("ENVELOPE_UNKNOWN_KEY_VERSION");
  });

  it("rejects tampered bytes in every column", async () => {
    const row = await sealed();
    const flip = (base: string): string => {
      const head = base.slice(0, -2);
      const tail = base.slice(-2);
      return `${head}${tail === "AA" ? "BB" : "AA"}`;
    };
    await expect(opened({ ...row, ciphertext: flip(row.ciphertext) })).rejects.toThrow("ENVELOPE_DECRYPT_FAILED");
    await expect(opened({ ...row, nonce: flip(row.nonce) })).rejects.toThrow("ENVELOPE_DECRYPT_FAILED");
    await expect(opened({ ...row, wrappedDek: flip(row.wrappedDek) })).rejects.toThrow("ENVELOPE_DECRYPT_FAILED");
  });

  it("never reuses a nonce or ciphertext across encryptions", async () => {
    const rows = await Promise.all(Array.from({ length: 25 }, () => sealed()));
    expect(new Set(rows.map((entry) => entry.nonce)).size).toBe(25);
    expect(new Set(rows.map((entry) => entry.ciphertext)).size).toBe(25);
    expect(new Set(rows.map((entry) => entry.wrappedDek)).size).toBe(25);
  });

  it("supports staged re-wrap rotation across key versions", async () => {
    const v1 = await sealed();
    // Both generations decrypt while rotation is staged.
    const keks = { 1: KEK, 2: KEK_NEXT };
    expect(await opened(v1, { keks })).toBe(VALUE);
    // Re-wrap: decrypt under v1, encrypt under v2.
    const plaintext = await opened(v1, { keks });
    const v2 = await encryptConnectionSecret({
      orgId: ORG,
      connectionId: CONN,
      field: FIELD,
      plaintext,
      kekMaterial: KEK_NEXT,
      keyVersion: 2,
    });
    expect(v2.keyVersion).toBe(2);
    expect(await opened(v2, { keks })).toBe(VALUE);
    // The old generation keeps decrypting until its KEK is destroyed;
    // the new row is unreadable once v2 is dropped from the map.
    expect(await opened(v1, { keks })).toBe(VALUE);
    await expect(opened(v2, { keks: { 1: KEK } })).rejects.toThrow("ENVELOPE_UNKNOWN_KEY_VERSION");
  });

  it("validates inputs and never leaks values in error codes", async () => {
    await expect(sealed({ plaintext: "" })).rejects.toThrow("ENVELOPE_INVALID_INPUT");
    await expect(sealed({ plaintext: "x".repeat(4097) })).rejects.toThrow("ENVELOPE_INVALID_INPUT");
    await expect(sealed({ kekMaterial: "" })).rejects.toThrow("ENVELOPE_KEK_MISSING");
    await expect(sealed({ keyVersion: 0 })).rejects.toThrow("ENVELOPE_INVALID_INPUT");
    const row = await sealed();
    for (const promise of [
      opened(row, { orgId: OTHER_ORG }),
      opened(row, { keks: { [ENVELOPE_KEY_VERSION]: WRONG_KEK } }),
      sealed({ plaintext: "" }),
    ]) {
      const error = await promise.then(
        () => {
          throw new Error("expected rejection");
        },
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(EnvelopeError);
      expect(String((error as Error).message)).not.toContain(VALUE);
      expect(String((error as Error).message)).not.toContain(KEK);
    }
  });
});
