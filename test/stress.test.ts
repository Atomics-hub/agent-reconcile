import { expect, it } from "vitest";
import { reconcileTranscript } from "../src/reconcile.ts";
import type { AgentMessage } from "../src/types.ts";

it("reconciles ten thousand interrupted calls in linear work", () => {
  const input: AgentMessage[] = Array.from({ length: 10_000 }, (_, index) => ({
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: `call-${String(index)}`,
        name: "work",
        input: index,
      },
    ],
  }));
  const started = performance.now();
  const output = reconcileTranscript(input);
  expect(output.changes).toHaveLength(10_000);
  expect(output.messages).toHaveLength(20_000);
  expect(performance.now() - started).toBeLessThan(2_000);
});
