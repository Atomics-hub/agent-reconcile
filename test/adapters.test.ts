import { describe, expect, it } from "vitest";
import {
  fromAISDK,
  fromAnthropic,
  fromGemini,
  fromOpenAI,
  reconcileProvider,
  toAISDK,
  toAnthropic,
  toGemini,
  toOpenAI,
} from "../src/adapters.ts";

describe("provider adapters", () => {
  it("repairs and re-emits OpenAI messages", () => {
    const input = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "x",
            type: "function",
            function: { name: "go", arguments: '{"a":1}' },
          },
        ],
      },
    ];
    const output = reconcileProvider<Record<string, unknown>>("openai", input);
    expect(output.messages).toHaveLength(2);
    expect(output.messages[1]).toMatchObject({
      role: "tool",
      tool_call_id: "x",
    });
    expect(fromOpenAI(toOpenAI(output.canonical))).toMatchObject([
      output.canonical[0],
      { role: "tool", parts: [{ type: "tool-result", toolCallId: "x" }] },
    ]);
  });

  it("handles invalid OpenAI JSON arguments without throwing", () => {
    const messages = fromOpenAI([
      {
        role: "assistant",
        tool_calls: [{ id: "x", function: { name: "go", arguments: "{" } }],
      },
    ]);
    expect(messages[0]?.parts[0]).toMatchObject({ input: "{" });
  });

  it("repairs Anthropic tool_use blocks", () => {
    const input = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "go", input: {} }],
      },
    ];
    const output = reconcileProvider("anthropic", input);
    expect(output.messages[1]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "x", is_error: true }],
    });
    expect(fromAnthropic(toAnthropic(output.canonical))).toEqual(
      output.canonical,
    );
  });

  it("correlates parallel id-less Gemini calls FIFO by function name", () => {
    const input = [
      {
        role: "model",
        parts: [
          { functionCall: { name: "go", args: { n: 1 } } },
          { functionCall: { name: "go", args: { n: 2 } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "go", response: { n: 1 } } },
          { functionResponse: { name: "go", response: { n: 2 } } },
        ],
      },
    ];
    const canonical = fromGemini(input);
    expect(
      canonical[1]?.parts.map((part) =>
        part.type === "tool-result" ? part.toolCallId : "",
      ),
    ).toEqual(["gemini-1-go", "gemini-2-go"]);
    expect(fromGemini(toGemini(canonical))).toHaveLength(2);
  });

  it("removes explicit Gemini response IDs from the name queue", () => {
    const canonical = fromGemini([
      {
        role: "model",
        parts: [
          { functionCall: { id: "a", name: "go", args: 1 } },
          { functionCall: { id: "b", name: "go", args: 2 } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { id: "b", name: "go", response: 2 } },
          { functionResponse: { name: "go", response: 1 } },
        ],
      },
    ]);
    expect(
      canonical[1]?.parts.map((part) =>
        part.type === "tool-result" ? part.toolCallId : "",
      ),
    ).toEqual(["b", "a"]);
  });

  it("turns a pending AI SDK tool part into output-error", () => {
    const input = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-search",
            toolCallId: "x",
            toolName: "search",
            state: "input-available",
            input: {},
          },
        ],
      },
    ];
    const output = reconcileProvider<Record<string, unknown>>("ai-sdk", input);
    expect(output.messages[0]).toMatchObject({
      role: "assistant",
      parts: [{ state: "output-error", toolCallId: "x" }],
    });
    expect(
      fromAISDK(toAISDK(output.canonical))[0]?.parts.map((part) => part.type),
    ).toEqual(["tool-call", "tool-result"]);
  });

  it("ignores malformed provider records safely", () => {
    expect(fromOpenAI([null, 2, { role: "wat" }])).toEqual([]);
    expect(fromAnthropic([{ role: "wat" }])).toEqual([]);
    expect(fromGemini([null])).toEqual([]);
    expect(fromAISDK([null])).toEqual([]);
  });

  it("covers provider shape variants without SDK dependencies", () => {
    expect(
      fromOpenAI([
        { role: "system", content: "rules" },
        { role: "user", content: "" },
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }, null],
          tool_calls: [
            null,
            { id: "missing-function" },
            { id: "missing-name", function: {} },
            { id: "raw", function: { name: "go", arguments: { x: 1 } } },
          ],
        },
        { role: "tool", content: "ignored-without-id" },
      ]),
    ).toMatchObject([
      { role: "system", parts: [{ type: "text", text: "rules" }] },
      { role: "user", parts: [] },
      { role: "assistant", parts: [{ type: "text" }, { id: "raw" }] },
    ]);
    expect(
      toOpenAI([
        {
          role: "assistant",
          parts: [
            { type: "text", text: "x" },
            { type: "tool-call", id: "a", name: "go", input: "raw" },
          ],
        },
        {
          role: "tool",
          parts: [
            { type: "tool-result", toolCallId: "a", output: { ok: true } },
          ],
        },
      ]),
    ).toHaveLength(2);

    const anthropic = fromAnthropic([
      {
        role: "user",
        content: [
          null,
          { type: "text", text: "x" },
          { type: "tool_use", id: "a", name: "go", input: 1 },
          { type: "tool_use", id: "bad" },
          {
            type: "tool_result",
            tool_use_id: "a",
            content: "ok",
            is_error: false,
          },
          { type: "tool_result", content: "bad" },
        ],
      },
    ]);
    expect(anthropic).toHaveLength(2);
    expect(
      toAnthropic([{ role: "user", parts: [] }, ...anthropic]),
    ).toHaveLength(2);

    const gemini = fromGemini([
      {
        role: "user",
        parts: [
          null,
          { text: "hi" },
          { functionCall: {} },
          { functionCall: { id: "g", name: "go", args: 1 } },
          { functionResponse: { id: "g", name: "go", response: "ok" } },
          { functionResponse: { response: "orphan" } },
        ],
      },
    ]);
    expect(gemini).toHaveLength(2);
    expect(toGemini([{ role: "user", parts: [] }, ...gemini])).toHaveLength(2);

    const aiSdk = fromAISDK([
      { role: "system", content: [{ type: "text", text: "rules" }] },
      {
        role: "tool",
        parts: [
          {
            type: "tool-go",
            toolCallId: "a",
            state: "output-available",
            output: 1,
          },
        ],
      },
      { role: "user", parts: [null, { type: "noop" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-go",
            toolCallId: "a",
            state: "output-available",
            output: 1,
          },
          {
            type: "tool-go",
            toolCallId: "b",
            state: "output-error",
            errorText: "bad",
          },
        ],
      },
    ]);
    expect(aiSdk.some((message) => message.role === "system")).toBe(true);
    expect(
      toAISDK([
        { role: "user", parts: [] },
        { role: "user", parts: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          parts: [{ type: "tool-call", id: "pending", name: "go", input: 1 }],
        },
        {
          role: "assistant",
          parts: [{ type: "tool-call", id: "done", name: "go", input: 1 }],
        },
        {
          role: "tool",
          parts: [{ type: "tool-result", toolCallId: "done", output: "ok" }],
        },
      ]),
    ).toHaveLength(3);
  });
});
