import { describe, expect, it } from "vitest";
import { reconcileTranscript } from "../src/reconcile.ts";
import { ReconcileLimitError, type AgentMessage } from "../src/types.ts";

const call = (id = "call-1"): AgentMessage => ({
  role: "assistant",
  parts: [{ type: "tool-call", id, name: "search", input: { q: "npm" } }],
});
const result = (id = "call-1"): AgentMessage => ({
  role: "tool",
  parts: [{ type: "tool-result", toolCallId: id, output: "done" }],
});

describe("reconcileTranscript", () => {
  it("completes an interrupted tool call with an error result", () => {
    const output = reconcileTranscript([call()]);
    expect(output.safeToReplay).toBe(true);
    expect(output.pendingToolCallIds).toEqual([]);
    expect(output.messages[1]).toEqual({
      role: "tool",
      parts: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          output:
            "Tool execution interrupted before a result was recorded: search",
          isError: true,
        },
      ],
    });
    expect(output.changes[0]?.kind).toBe("complete-pending");
  });

  it("moves late results immediately behind their call", () => {
    const output = reconcileTranscript([
      call(),
      { role: "user", parts: [{ type: "text", text: "later" }] },
      result(),
    ]);
    expect(output.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "user",
    ]);
    expect(output.changes.some((change) => change.kind === "move-result")).toBe(
      true,
    );
  });

  it("preserves an already valid transcript and is idempotent", () => {
    const input = [call(), result()];
    const once = reconcileTranscript(input);
    const twice = reconcileTranscript(once.messages);
    expect(once.changed).toBe(false);
    expect(once.messages).toEqual(input);
    expect(twice).toMatchObject({
      messages: once.messages,
      changes: [],
      changed: false,
      safeToReplay: true,
    });
  });

  it("removes orphan and duplicate results", () => {
    const output = reconcileTranscript([
      call(),
      result(),
      result(),
      result("ghost"),
    ]);
    expect(output.changes.map((change) => change.kind)).toEqual([
      "remove-duplicate-result",
      "remove-orphan",
    ]);
    expect(output.messages).toHaveLength(2);
  });

  it("removes duplicate call identifiers", () => {
    const output = reconcileTranscript([call(), call(), result()]);
    expect(
      output.changes.some((change) => change.kind === "remove-duplicate-call"),
    ).toBe(true);
    expect(
      output.messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it("removes structurally invalid calls before declaring replay safe", () => {
    const output = reconcileTranscript([
      {
        role: "user",
        parts: [
          { type: "tool-call", id: "user-call", name: "go", input: null },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "tool-call", id: "", name: "go", input: null }],
      },
      {
        role: "assistant",
        parts: [{ type: "tool-call", id: "x", name: "", input: null }],
      },
    ]);
    expect(output.safeToReplay).toBe(true);
    expect(output.messages).toEqual([]);
    expect(
      output.changes.every((change) => change.kind === "remove-invalid-call"),
    ).toBe(true);
  });

  it("supports remove and keep pending policies", () => {
    const removed = reconcileTranscript([call()], { pending: "remove" });
    expect(removed.messages).toEqual([]);
    const kept = reconcileTranscript([call()], { pending: "keep" });
    expect(kept.safeToReplay).toBe(false);
    expect(kept.pendingToolCallIds).toEqual(["call-1"]);
  });

  it("can retain orphans but marks the transcript unsafe", () => {
    const output = reconcileTranscript([result("ghost")], {
      orphanResults: "keep",
    });
    expect(output.safeToReplay).toBe(false);
    expect(output.messages).toHaveLength(1);
  });

  it("supports custom cancellation text", () => {
    expect(
      reconcileTranscript([call()], {
        cancellationMessage: (tool) => `cancelled:${tool.id}`,
      }).messages[1]?.parts[0],
    ).toMatchObject({ output: "cancelled:call-1" });
  });

  it("does not mutate caller-owned arrays or parts", () => {
    const input = [call()];
    Object.freeze(input[0]?.parts);
    Object.freeze(input[0]);
    Object.freeze(input);
    expect(() => reconcileTranscript(input)).not.toThrow();
    expect(input).toHaveLength(1);
  });

  it("enforces bounded work", () => {
    expect(() => reconcileTranscript([call()], { maxMessages: 0 })).toThrow(
      ReconcileLimitError,
    );
    expect(() => reconcileTranscript([call()], { maxParts: 0 })).toThrow(
      ReconcileLimitError,
    );
    expect(() => reconcileTranscript([], { maxParts: -1 })).toThrow(
      "non-negative safe integers",
    );
  });

  it("handles prototype-looking identifiers without pollution", () => {
    const output = reconcileTranscript([call("__proto__")]);
    expect(output.messages[1]?.parts[0]).toMatchObject({
      toolCallId: "__proto__",
    });
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
