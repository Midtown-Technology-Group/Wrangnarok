export interface PostmanConvertResult {
  readonly doc: {
    readonly openapi: string;
    readonly info: { readonly title: string; readonly version: string };
    readonly paths: Record<string, Record<string, { readonly operationId: string; readonly summary: string }>>;
  };
  readonly converterVersion: string;
  readonly synthesized: number;
  readonly dropped: number;
}

export function synthesizeOperationId(method: string, path: string): string;
export function operationIdForItem(name: string, method: string, path: string): string;
export function convertPostmanCollection(collection: unknown): PostmanConvertResult;
export const POSTMAN_CONVERTER_VERSION: string;
