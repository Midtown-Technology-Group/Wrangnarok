// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): TS/mirror parity for the Postman converter.
// scripts/wrangnarok.mjs cannot import TypeScript, so src/postman-convert.mjs
// mirrors src/postman.ts by hand. This test proves the same collection
// converts to the same document through both modules.
import { describe, expect, it } from "vitest";
import { convertPostmanCollection as convertTs } from "../src/postman";
import { convertPostmanCollection as convertJs } from "../src/postman-convert.mjs";

const COLLECTIONS = [
  {
    info: { name: "HaloPSA lab" },
    item: [
      { name: "Get one ticket", request: { method: "GET", url: "https://halo-lab.example.com/api/Tickets/{id}" } },
      {
        name: "Notes",
        item: [
          { name: "", request: { method: "POST", url: { path: ["api", "Tickets", ":id", "Notes"] } } },
          { name: "Bad", request: { method: "", url: "" } },
        ],
      },
    ],
  },
  {
    info: { name: "enc" },
    item: [{ name: "x", request: { method: "DELETE", url: "https://x.example/api/T/{{tid}}?a=1" } }],
  },
];

describe("INT-01 Postman TS/mirror parity (issue #229)", () => {
  it("converts identically through src/postman.ts and src/postman-convert.mjs", () => {
    for (const collection of COLLECTIONS) {
      expect(convertJs(collection)).toEqual(convertTs(collection));
    }
  });

  it("fails identically on malformed collections", () => {
    const bad = { info: { name: "b" }, item: [] };
    expect(() => convertTs(bad)).toThrow(/no operations/);
    expect(() => convertJs(bad)).toThrow(/no operations/);
  });
});
