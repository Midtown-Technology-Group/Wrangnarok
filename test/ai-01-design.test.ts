// SPDX-License-Identifier: AGPL-3.0
// AI-01 design slice (issue #164, ADR 032): pin the provider-kind and
// assignment-key vocabularies. Pure node-safe: no bindings, no D1, no vendor
// HTTP. Build slices add the registry definitions, DDL, and routes.
import { describe, expect, it } from "vitest";
import { AI_ASSIGNMENT_KEYS, AI_PROVIDER_KINDS } from "../src/domain";

describe("AI-01 provider vocabulary (issue #164, ADR 032)", () => {
  it("pins the five upstream provider kinds as stable slugs", () => {
    expect([...AI_PROVIDER_KINDS]).toEqual(["openai", "anthropic", "google", "openrouter", "openai-compatible"]);
  });

  it("pins the six upstream default-assignment keys", () => {
    expect([...AI_ASSIGNMENT_KEYS]).toEqual([
      "primary",
      "summarization",
      "tuning",
      "image_generation",
      "video_generation",
      "chat_default",
    ]);
  });
});
