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
}

export function emitIntegrationSource(input: IntegrationSourceInput): string;
