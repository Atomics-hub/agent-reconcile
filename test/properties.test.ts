import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reconcileTranscript } from "../src/reconcile.ts";
import type { AgentMessage } from "../src/types.ts";

describe("properties", () => {
  it("default reconciliation leaves every unique call with exactly one result", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
          maxLength: 60,
        }),
        (ids) => {
          const input: AgentMessage[] = ids.map((id) => ({
            role: "assistant",
            parts: [{ type: "tool-call", id, name: "x", input: null }],
          }));
          const output = reconcileTranscript(input);
          const resultIds = output.messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool-result")
            .map((part) => part.toolCallId);
          expect(resultIds).toEqual(ids);
          expect(output.safeToReplay).toBe(true);
          expect(reconcileTranscript(output.messages).changed).toBe(false);
        },
      ),
      { numRuns: 1_500 },
    );
  });

  it("never mutates arbitrary text and input payload references", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.string(), (value, text) => {
        const input: AgentMessage[] = [
          {
            role: "assistant",
            parts: [
              { type: "text", text },
              { type: "tool-call", id: "x", name: "go", input: value },
            ],
          },
        ];
        const output = reconcileTranscript(input);
        expect(output.messages[0]?.parts[0]).toEqual({ type: "text", text });
        expect(output.messages[0]?.parts[1]).toMatchObject({ input: value });
      }),
      { numRuns: 1_500 },
    );
  });
});
