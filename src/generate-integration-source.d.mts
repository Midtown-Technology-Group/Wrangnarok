import type { ContractOperation, OpenApiDocument } from "./openapi";

export interface IntegrationSourceInput {
  readonly doc: OpenApiDocument;
  readonly operations: readonly ContractOperation[];
  readonly id: string;
  readonly name: string;
  readonly allowedOrigins: readonly string[];
  readonly envPrefix: string;
  readonly digestHex: string;
  readonly version: string;
  /** OAuth token endpoint path, resolved against the Connection endpoint
   * origin (HaloPSA: /auth/token). Operator-overridable per provider. */
  readonly tokenPath?: string;
  /** OAuth scope requested at the token endpoint. Operator-overridable. */
  readonly scope?: string;
  /** Shared vendor deadline ms over token plus resource call (1-30000). */
  readonly timeoutMs?: number;
}

export function emitIntegrationSource(input: IntegrationSourceInput): string;
