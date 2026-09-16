import type { ContractOperation, OpenApiDocument } from "./openapi";

/** Credential shape the emitted Integration host uses. `apiToken` sends a
 * bearer token directly; `clientCredentials` exchanges a deployment pair
 * for a transient token first. */
export type EmitterAuthKind = "apiToken" | "clientCredentials";

export interface IntegrationSourceInput {
  readonly doc: OpenApiDocument;
  readonly operations: readonly ContractOperation[];
  readonly id: string;
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly envPrefix: string;
  readonly digestHex: string;
  readonly version: string;
  readonly authKind?: EmitterAuthKind;
  /** Deterministic UUIDv5 Integration ID (see integrationUuidV5). */
  readonly integrationUuid?: string;
  readonly tokenPath?: string;
  readonly scope?: string;
  readonly timeoutMs?: number;
}

export function emitIntegrationSource(input: IntegrationSourceInput): string;
