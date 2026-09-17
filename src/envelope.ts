// SPDX-License-Identifier: AGPL-3.0
// Per-Organization envelope encryption (SEC-02, issue #411; ADR 005 firing
// amendment). Boring Web Crypto composition only: AES-GCM-256 content
// encryption under a random per-(Connection, field) DEK, DEK wrapped by the
// per-environment KEK. No custom construction, no new primitive.
//
// Layout of one stored row (migrations/0028_connection_secrets.sql):
// - nonce: base64(12 random bytes), the content-encryption IV. Fresh per
//   encryption via crypto.getRandomValues — never reused, never derived.
// - ciphertext: base64(AES-GCM content) under the DEK with associated data
//   binding org_id + connection id + field. Copying a row to another
//   org/Connection/field fails closed on decrypt.
// - wrapped_dek: base64(wrapNonce(12 random bytes) || AES-GCM(DEK)) under
//   the KEK derived below, with associated data binding the key version.
//   AES-GCM (not AES-KW) wraps the DEK so the module depends on exactly one
//   subtle algorithm family.
// - key_version / algorithm: decrypt-with-version support for staged
//   re-wrap rotation.
//
// KEK derivation: the SECRETS_KEK env secret is arbitrary-length operator
// material, so SHA-256 hash it into a fixed 256-bit AES-GCM key. The env
// value itself is never stored, logged, or serialized — only its digest
// enters the subtle API, transiently.
//
// Every failure throws EnvelopeError with a fixed code string. Codes never
// carry values, rows, or key material: safe to shape into Faults.
export const ENVELOPE_ALGORITHM = "AES-GCM-256";
/** Latest key version this code writes. Decrypt accepts any version whose
 * KEK the caller supplies (decrypt-with-version). */
export const ENVELOPE_KEY_VERSION = 1;
/** Env secret holding the per-environment KEK material (Secrets Store,
 * stdin-provisioned, never D1). */
export const KEK_ENV_VAR = "SECRETS_KEK";
/** Hard bound on one accepted secret value (matches the configs value_json
 * bound so no envelope row can smuggle a larger payload than config rows). */
export const ENVELOPE_MAX_PLAINTEXT = 4096;

export class EnvelopeError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "EnvelopeError";
  }
}

export interface EnvelopeRow {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly wrappedDek: string;
  readonly keyVersion: number;
  readonly algorithm: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Exact-byte arrays for the subtle API (repo idiom: worker lib types the
 * generic Uint8Array wider than BufferSource, so narrow explicitly). */
type Bytes = Uint8Array<ArrayBuffer>;

function bytes(value: Uint8Array): Bytes {
  return value as Bytes;
}

function b64encode(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function b64decode(base: string, code: string): Bytes {
  let text: string;
  try {
    text = atob(base);
  } catch {
    throw new EnvelopeError(code);
  }
  const out = bytes(new Uint8Array(text.length));
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function randomBytes(length: number): Bytes {
  const out = bytes(new Uint8Array(length));
  crypto.getRandomValues(out);
  return out;
}

/** Import the KEK for one use. The hashed material never leaves this
 * function; subtle keys are non-extractable and dropped after the call. */
async function kekKey(kekMaterial: string): Promise<CryptoKey> {
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw new EnvelopeError("ENVELOPE_KEK_MISSING");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(kekMaterial));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function contentAad(orgId: string, connectionId: string, field: string): Bytes {
  return bytes(encoder.encode(`wrangnarok-connection-secret\x00${orgId}\x00${connectionId}\x00${field}`));
}

function wrapAad(keyVersion: number): Bytes {
  return bytes(encoder.encode(`wrangnarok-dek-wrap\x00v${keyVersion}`));
}

export interface EnvelopeEncryptInput {
  readonly orgId: string;
  readonly connectionId: string;
  readonly field: string;
  readonly plaintext: string;
  readonly kekMaterial: string;
  readonly keyVersion?: number;
}

/** Encrypt one secret value into a storable envelope row. */
export async function encryptConnectionSecret(input: EnvelopeEncryptInput): Promise<EnvelopeRow> {
  if (typeof input.plaintext !== "string" || input.plaintext.length === 0) {
    throw new EnvelopeError("ENVELOPE_INVALID_INPUT");
  }
  if (input.plaintext.length > ENVELOPE_MAX_PLAINTEXT) {
    throw new EnvelopeError("ENVELOPE_INVALID_INPUT");
  }
  const keyVersion = input.keyVersion ?? ENVELOPE_KEY_VERSION;
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new EnvelopeError("ENVELOPE_INVALID_INPUT");
  const kek = await kekKey(input.kekMaterial);
  const rawDek = randomBytes(32);
  const dek = await crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["encrypt", "decrypt"]);
  const nonce = randomBytes(12);
  const aad = contentAad(input.orgId, input.connectionId, input.field);
  const ciphertext = bytes(
    new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad },
        dek,
        bytes(encoder.encode(input.plaintext)),
      ),
    ),
  );
  const wrapNonce = randomBytes(12);
  const wrapped = bytes(
    new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapNonce, additionalData: wrapAad(keyVersion) }, kek, rawDek),
    ),
  );
  const combined = new Uint8Array(wrapNonce.length + wrapped.length);
  combined.set(wrapNonce);
  combined.set(wrapped, wrapNonce.length);
  return {
    ciphertext: b64encode(ciphertext),
    nonce: b64encode(nonce),
    wrappedDek: b64encode(combined),
    keyVersion,
    algorithm: ENVELOPE_ALGORITHM,
  };
}

export interface EnvelopeDecryptInput {
  readonly orgId: string;
  readonly connectionId: string;
  readonly field: string;
  readonly row: EnvelopeRow;
  /** KEK material by key version (decrypt-with-version). The row's version
   * selects; a missing entry fails closed without touching subtle. */
  readonly keks: Readonly<Record<number, string>>;
}

/** Decrypt one envelope row. Any mismatch — wrong org/Connection/field,
 * unknown algorithm or version, tampered bytes, wrong KEK — fails closed
 * with ENVELOPE_DECRYPT_FAILED (or the specific lookup code below). */
export async function decryptConnectionSecret(input: EnvelopeDecryptInput): Promise<string> {
  const row = input.row;
  if (row === null || typeof row !== "object" || row.algorithm !== ENVELOPE_ALGORITHM) {
    throw new EnvelopeError("ENVELOPE_UNKNOWN_ALGORITHM");
  }
  if (!Number.isInteger(row.keyVersion) || row.keyVersion < 1) throw new EnvelopeError("ENVELOPE_UNKNOWN_KEY_VERSION");
  const kekMaterial = input.keks[row.keyVersion];
  if (typeof kekMaterial !== "string" || kekMaterial.length === 0) {
    throw new EnvelopeError("ENVELOPE_UNKNOWN_KEY_VERSION");
  }
  try {
    const nonce = b64decode(row.nonce, "ENVELOPE_DECRYPT_FAILED");
    const ciphertext = b64decode(row.ciphertext, "ENVELOPE_DECRYPT_FAILED");
    const combined = b64decode(row.wrappedDek, "ENVELOPE_DECRYPT_FAILED");
    if (nonce.length !== 12 || combined.length <= 12) throw new EnvelopeError("ENVELOPE_DECRYPT_FAILED");
    const kek = await kekKey(kekMaterial);
    const wrapNonce = combined.slice(0, 12);
    const wrapped = combined.slice(12);
    const rawDek = bytes(
      new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: wrapNonce, additionalData: wrapAad(row.keyVersion) },
          kek,
          wrapped,
        ),
      ),
    );
    // No length check on the unwrapped DEK: AES-GCM authentication above
    // already guarantees integrity, and exactly 32 bytes were wrapped at
    // encrypt time. An explicit check would be uncoverable dead code.
    const dek = await crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["decrypt"]);
    const aad = contentAad(input.orgId, input.connectionId, input.field);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, dek, ciphertext);
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof EnvelopeError) throw error;
    throw new EnvelopeError("ENVELOPE_DECRYPT_FAILED");
  }
}
