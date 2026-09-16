// SPDX-License-Identifier: AGPL-3.0
import { describe, expect, it } from "vitest";
import opencodeConfig from "../.opencode/opencode.json";
import tuiConfig from "../.opencode/tui.json";
import opencodePackage from "../.opencode/package.json";
import {
  MailboxFault,
  MailboxMessage,
  RECENT_WINDOW_MS,
  buildMessage,
  claimAlias,
  findReply,
  formatHead,
  formatLine,
  formatPushBlock,
  isRecentlyActive,
  markStatus,
  parseLine,
  peekPushable,
  senderLine,
  unread,
  unreadSummary,
  validAlias,
} from "../.opencode/plugins/mailbox-store";

function faultCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MailboxFault) return error.code;
    throw error;
  }
  throw new Error("expected MailboxFault");
}

function note(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: "m1",
    from: "ses-a",
    to: "ses-b",
    ts: "2026-09-09T00:00:00.000Z",
    kind: "note",
    priority: "standard",
    body: "hello",
    status: "queued",
    ...overrides,
  };
}

describe("mailbox send validation", () => {
  it("defaults kind note and standard priority", () => {
    const m = buildMessage("ses-a", { to: "ses-b", body: "hi" }, "id-1", "ts");
    expect(m).toMatchObject({ kind: "note", priority: "standard", status: "queued", from: "ses-a" });
  });
  it("steer defaults to high priority but rejects standard steer", () => {
    expect(buildMessage("s", { to: "t", kind: "steer", body: "x" }, "i", "ts").priority).toBe("high");
    expect(() =>
      buildMessage("s", { to: "t", kind: "steer", priority: "standard", body: "x" }, "i", "ts"),
    ).toThrowError(MailboxFault);
  });
  it("reply requires replyTo, rejects bad kind/priority and bounds", () => {
    expect(faultCode(() => buildMessage("s", { to: "t", kind: "reply", body: "x" }, "i", "ts"))).toBe(
      "REPLY_NO_TARGET",
    );
    expect(faultCode(() => buildMessage("s", { to: "t", kind: "yell", body: "x" }, "i", "ts"))).toBe("BAD_KIND");
    expect(faultCode(() => buildMessage("s", { to: "t", body: "" }, "i", "ts"))).toBe("BODY_EMPTY");
    expect(faultCode(() => buildMessage("s", { to: "t", body: "x".repeat(4097) }, "i", "ts"))).toBe("BODY_TOO_LARGE");
    expect(faultCode(() => buildMessage("s", { to: "  ", body: "x" }, "i", "ts"))).toBe("BAD_ADDRESS");
  });
});

describe("mailbox JSONL round-trip", () => {
  it("formats and parses, skipping malformed lines", () => {
    const m = note({ subject: "s", replyTo: "r", fromAlias: "a" });
    expect(parseLine(formatLine(m))).toEqual(m);
    expect(parseLine("{nope")).toBeNull();
    expect(parseLine(JSON.stringify({ ...m, kind: "yell" }))).toBeNull();
    expect(parseLine(JSON.stringify({ ...m, status: "lost" }))).toBeNull();
  });
});

describe("mailbox status machine", () => {
  const inbox = [note({ id: "a" }), note({ id: "b", priority: "high" }), note({ id: "c", status: "read" })];
  it("never regresses and gates delivered from queued only", () => {
    expect(markStatus(inbox, ["a"], "delivered").find((m) => m.id === "a")?.status).toBe("delivered");
    expect(markStatus(inbox, ["c"], "delivered").find((m) => m.id === "c")?.status).toBe("read");
    expect(markStatus(inbox, ["c"], "queued").find((m) => m.id === "c")?.status).toBe("read");
    expect(markStatus(inbox, ["a"], "acked").find((m) => m.id === "a")?.status).toBe("acked");
  });
  it("unread covers queued+delivered, push peeks undelivered high only", () => {
    expect(unread(inbox).map((m) => m.id)).toEqual(["a", "b"]);
    expect(peekPushable(inbox).map((m) => m.id)).toEqual(["b"]);
    const after = markStatus(inbox, ["b"], "delivered");
    expect(peekPushable(after)).toEqual([]);
    expect(unread(after).map((m) => m.id)).toEqual(["a", "b"]);
  });
  it("finds replies by request id", () => {
    const box = [note({ id: "q", kind: "request" }), note({ id: "r", kind: "reply", replyTo: "q" })];
    expect(findReply(box, "q")?.id).toBe("r");
    expect(findReply(box, "nope")).toBeNull();
  });
});

describe("mailbox presentation", () => {
  it("validates aliases and formats push/summary", () => {
    expect(validAlias("lane-one_2")).toBe(true);
    expect(validAlias("Has space")).toBe(false);
    expect(formatPushBlock([note({ id: "b", priority: "high" })])).toMatch(/MAILBOX_HIGH_PRIORITY/);
    expect(unreadSummary([note(), note({ id: "b", priority: "high" })])).toMatch(/2 unread \(1 high-priority\)/);
    expect(unreadSummary([])).toBe("Mailbox: empty.");
  });
});

describe("mailbox file-peer recency", () => {
  it("treats recent touches as active with a closed window", () => {
    const now = 1_000_000;
    expect(isRecentlyActive(now, now)).toBe(true);
    expect(isRecentlyActive(now - RECENT_WINDOW_MS, now)).toBe(true);
    expect(isRecentlyActive(now - RECENT_WINDOW_MS - 1, now)).toBe(false);
    expect(isRecentlyActive(now + 1, now)).toBe(false);
    expect(isRecentlyActive(Number.NaN, now)).toBe(false);
  });
});

describe("mailbox alias claims (issue #382)", () => {
  it("rejects hijacking an alias owned by another session", () => {
    const taken = claimAlias({ herb: "ses-victim" }, "herb", "ses-attacker");
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.owner).toBe("ses-victim");
    // The victim's mapping is untouched by the rejected claim.
    expect(claimAlias({ herb: "ses-victim" }, "herb", "ses-victim").ok).toBe(true);
  });
  it("is idempotent for the owning session and releases stale aliases", () => {
    const again = claimAlias({ herb: "ses-a" }, "herb", "ses-a");
    expect(again).toEqual({ ok: true, aliases: { herb: "ses-a" } });
    const moved = claimAlias({ old: "ses-a", other: "ses-b" }, "new", "ses-a");
    expect(moved).toEqual({ ok: true, aliases: { other: "ses-b", new: "ses-a" } });
  });
});

describe("mailbox sender presentation (issue #382)", () => {
  it("always includes the immutable session ID beside any alias", () => {
    expect(senderLine(note({ from: "ses-abc", fromAlias: undefined }))).toBe("ses-abc");
    const both = senderLine(note({ from: "ses-abc", fromAlias: "herb" }));
    expect(both).toContain("ses-abc");
    expect(both).toContain("herb");
    // A copied victim alias cannot pass as the victim session.
    expect(both).not.toBe("herb");
    expect(formatHead(note({ from: "ses-abc", fromAlias: "herb", id: "m9" }))).toContain("ses-abc");
    expect(formatPushBlock([note({ from: "ses-abc", fromAlias: "herb", priority: "high" })])).toContain("ses-abc");
  });
});

describe("opencode plugin pin (issue #383)", () => {
  it("pins the goal plugin to one exact immutable version everywhere", () => {
    // Bare specifiers float to latest at startup; a hijacked publish then
    // runs as the developer. Every entry must name the same exact version,
    // and the config package.json pins it for integrity-verified installs.
    const plugins = (opencodeConfig as { plugin?: readonly unknown[] }).plugin;
    const tuiPlugins = (tuiConfig as { plugin?: readonly unknown[] }).plugin;
    const deps = (opencodePackage as { dependencies?: Record<string, string> }).dependencies;
    expect(plugins).toEqual(["@prevalentware/opencode-goal-plugin@0.1.49"]);
    expect(tuiPlugins).toEqual(["@prevalentware/opencode-goal-plugin@0.1.49"]);
    expect(deps?.["@prevalentware/opencode-goal-plugin"]).toBe("0.1.49");
  });
});
