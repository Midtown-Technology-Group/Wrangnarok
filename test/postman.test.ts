// SPDX-License-Identifier: AGPL-3.0
// INT-01 (issue #229): Postman Collection v2.1 converter tests. Pure
// node-safe: no bindings, no D1, no Workflows, no vendor HTTP.
import { describe, expect, it } from "vitest";
import {
  POSTMAN_CONVERTER_VERSION,
  convertPostmanCollection,
  operationIdForItem,
  synthesizeOperationId,
} from "../src/postman";

function haloCollection() {
  return {
    info: { name: "HaloPSA lab" },
    item: [
      {
        name: "Get one ticket",
        request: { method: "GET", url: "https://halo-lab.example.com/api/Tickets/{id}" },
      },
      {
        name: "Ticket folders",
        item: [
          { name: "", request: { method: "POST", url: { path: ["api", "Tickets", ":id", "Notes"] } } },
          { name: "Bad entry", request: { method: "", url: "" } },
        ],
      },
    ],
  };
}

describe("INT-01 Postman converter (issue #229)", () => {
  it("converts folders, synthesizes ids, and counts drops", () => {
    const out = convertPostmanCollection(haloCollection());
    expect(out.converterVersion).toBe(POSTMAN_CONVERTER_VERSION);
    expect(out.doc.openapi).toBe("3.0.3");
    expect(out.doc.info.title).toBe("HaloPSA lab");
    expect(out.doc.paths).toMatchObject({
      "/api/Tickets/{id}": { get: { operationId: "Get_One_Ticket" } },
      "/api/Tickets/{id}/Notes": { post: { operationId: "Post_Api_Tickets_Id_Notes" } },
    });
    // Collections carry no auth metadata: the converted document declares a
    // bearer scheme so the generator emits the bearer shape (never OAuth).
    expect(out.doc.components.securitySchemes.PostmanApiToken).toMatchObject({ type: "http", scheme: "bearer" });
    expect(out.doc.security).toEqual([{ PostmanApiToken: [] }]);
    expect(out.synthesized).toBe(1);
    expect(out.dropped).toBe(1);
  });

  it("decodes percent-encoded braces before validation", () => {
    const out = convertPostmanCollection({
      info: { name: "enc" },
      item: [{ name: "x", request: { method: "GET", url: "https://x.example/api/Tickets/%7Bid%7D" } }],
    });
    expect(Object.keys(out.doc.paths)).toEqual(["/api/Tickets/{id}"]);
  });

  it("normalizes :var and {{var}} to {var}", () => {
    const out = convertPostmanCollection({
      info: { name: "vars" },
      item: [
        { name: "a", request: { method: "GET", url: "/api/A/:id" } },
        { name: "b", request: { method: "GET", url: "/api/B/{{bid}}" } },
      ],
    });
    expect(Object.keys(out.doc.paths).sort()).toEqual(["/api/A/{id}", "/api/B/{bid}"]);
  });

  it("fails closed on duplicates, empty collections, and non-objects", () => {
    const dupe = {
      info: { name: "d" },
      item: [
        { name: "Same", request: { method: "GET", url: "/api/A" } },
        { name: "Same", request: { method: "GET", url: "/api/B" } },
      ],
    };
    expect(() => convertPostmanCollection(dupe)).toThrow(/Duplicate operationId/);
    expect(() => convertPostmanCollection({ info: { name: "e" }, item: [] })).toThrow(/no operations/);
    expect(() => convertPostmanCollection({ info: { name: "e" } })).toThrow(/item array/);
    expect(() => convertPostmanCollection(null)).toThrow(/JSON object/);
    expect(() => convertPostmanCollection([])).toThrow(/JSON object/);
  });

  it("derives stable operationIds with synthesis fallback", () => {
    expect(operationIdForItem("Get Tickets!", "GET", "/api/Tickets")).toBe("Get_Tickets");
    expect(operationIdForItem("", "DELETE", "/api/Tickets/{id}")).toBe("Delete_Api_Tickets_Id");
    expect(synthesizeOperationId("get", "/")).toBe("Get_root");
    expect(operationIdForItem("!!!", "GET", "/api/A")).toBe("Get_Api_A");
  });

  it("treats string-form requests as implicit GET", () => {
    const out = convertPostmanCollection({
      info: { name: "str" },
      item: [{ name: "Ping", request: "https://x.example/api/Ping" }],
    });
    expect(out.doc.paths).toMatchObject({ "/api/Ping": { get: { operationId: "Ping" } } });
    expect(out.dropped).toBe(0);
  });

  it("fails closed when two operationIds share one method+path slot", () => {
    const clash = {
      info: { name: "clash" },
      item: [
        { name: "First", request: { method: "GET", url: "/api/A" } },
        { name: "Second", request: { method: "GET", url: "/api/A" } },
      ],
    };
    expect(() => convertPostmanCollection(clash)).toThrow(/Duplicate operation GET \/api\/A/);
  });
});
