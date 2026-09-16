// SPDX-License-Identifier: AGPL-3.0
// Minimal node:async_hooks surface for the Workers runtime (nodejs_compat).
// The workerd binary exposes AsyncLocalStorage.run/getStore (enterWith and
// disable are explicitly unimplemented); @types/node is intentionally NOT a
// dependency (no other node: import exists in src/), so this ambient module
// declaration keeps `tsc --noEmit` green without widening the type root.
// Verified at runtime: AsyncLocalStorage propagates through the workerd
// vitest pool (test/als-prod-check, since removed) and the full
// test/child-invocation.test.ts suite passes against real workerd + D1.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R;
    getStore(): T | undefined;
  }
}
