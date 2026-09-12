// SPDX-License-Identifier: AGPL-3.0
// Observability sampling defaults (issue #238): local keeps full capture at
// experiment scale; deployed environments sample below it to bound log/trace
// volume and cost. Reads wrangler.jsonc as text (full-line // comments are
// config documentation, not JSON) so the test pins the shipped config.
import { describe, expect, it } from "vitest";
import configText from "../wrangler.jsonc?raw";

interface Sampling {
  readonly enabled?: boolean;
  readonly logs?: { readonly enabled?: boolean; readonly head_sampling_rate?: unknown };
  readonly traces?: { readonly enabled?: boolean; readonly head_sampling_rate?: unknown };
}
interface WranglerConfig {
  readonly observability?: Sampling;
  readonly env?: Record<string, { readonly observability?: Sampling }>;
}

function parseConfig(): WranglerConfig {
  // wrangler.jsonc is JSON-with-comments plus unquoted keys and trailing
  // commas (Wrangler config dialect, not strict JSON). Strip full-line //
  // comments, quote line-leading keys, and drop trailing commas; every string
  // value in the shipped file sits on one line after its key, so the anchored
  // key pattern cannot match inside a value.
  const json = configText
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .replace(/^(\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/gm, '$1"$2"$3')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json) as WranglerConfig;
}

function samplingRate(value: unknown): number {
  expect(typeof value).toBe("number");
  return value as number;
}

describe("observability sampling defaults (issue #238)", () => {
  it("keeps full capture for the local default", () => {
    const config = parseConfig();
    expect(config.observability?.enabled).toBe(true);
    expect(samplingRate(config.observability?.logs?.head_sampling_rate)).toBe(1);
    expect(samplingRate(config.observability?.traces?.head_sampling_rate)).toBe(1);
  });
  it("samples deployed environments below local full capture", () => {
    const config = parseConfig();
    const expected: Record<string, { logs: number; traces: number }> = {
      dev: { logs: 0.25, traces: 0.1 },
      preview: { logs: 0.1, traces: 0.1 },
    };
    for (const [name, rates] of Object.entries(expected)) {
      const sampling = config.env?.[name]?.observability;
      expect(sampling?.enabled).toBe(true);
      const logs = samplingRate(sampling?.logs?.head_sampling_rate);
      const traces = samplingRate(sampling?.traces?.head_sampling_rate);
      expect(logs).toBe(rates.logs);
      expect(traces).toBe(rates.traces);
      // Every rate is a valid head sampling probability, and non-local stays
      // strictly below full capture so volume stays bounded at scale.
      for (const rate of [logs, traces]) {
        expect(rate).toBeGreaterThan(0);
        expect(rate).toBeLessThanOrEqual(1);
        expect(rate).toBeLessThan(1);
      }
    }
  });
});
