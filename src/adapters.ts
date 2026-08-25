import { reconcileTranscript } from "./reconcile.js";
import type {
  AgentMessage,
  AgentPart,
  ReconcileOptions,
  ReconcileResult,
} from "./types.js";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export type Provider = "openai" | "anthropic" | "gemini" | "ai-sdk";
export interface ProviderReconcileResult<T = unknown> extends Omit<
  ReconcileResult,
  "messages"
> {
  messages: T[];
  canonical: AgentMessage[];
}

function textParts(value: unknown): AgentPart[] {
  if (typeof value === "string")
    return value.length === 0 ? [] : [{ type: "text", text: value }];
  return asArray(value).flatMap((item): AgentPart[] =>
    isRecord(item) && item.type === "text" && typeof item.text === "string"
      ? [{ type: "text", text: item.text }]
      : [],
  );
}

export function fromOpenAI(messages: readonly unknown[]): AgentMessage[] {
  return messages.flatMap((raw): AgentMessage[] => {
    if (!isRecord(raw)) return [];
    const role = asString(raw.role);
    if (role === "tool") {
      const id = asString(raw.tool_call_id);
      if (!id) return [];
      return [
        {
          role: "tool",
          parts: [{ type: "tool-result", toolCallId: id, output: raw.content }],
        },
      ];
    }
    if (role !== "system" && role !== "user" && role !== "assistant") return [];
    const parts = textParts(raw.content);
    if (role === "assistant") {
      for (const item of asArray(raw.tool_calls)) {
        if (!isRecord(item) || !isRecord(item.function)) continue;
        const id = asString(item.id);
        const name = asString(item.function.name);
        if (!id || !name) continue;
        const args = asString(item.function.arguments);
        let input: unknown = args ?? item.function.arguments;
        if (args !== undefined) {
          try {
            input = JSON.parse(args) as unknown;
          } catch {
            input = args;
          }
        }
        parts.push({ type: "tool-call", id, name, input });
      }
    }
    return [{ role, parts }];
  });
}

export function toOpenAI(messages: readonly AgentMessage[]): unknown[] {
  return messages.flatMap((message): unknown[] => {
    const texts = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const calls = message.parts.filter((part) => part.type === "tool-call");
    const results = message.parts.filter((part) => part.type === "tool-result");
    const output: unknown[] = [];
    if (message.role === "tool" || results.length > 0) {
      for (const result of results)
        output.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content:
            typeof result.output === "string"
              ? result.output
              : JSON.stringify(result.output),
        });
      return output;
    }
    const base: RecordValue = { role: message.role, content: texts || null };
    if (calls.length > 0)
      base.tool_calls = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments:
            typeof call.input === "string"
              ? call.input
              : JSON.stringify(call.input),
        },
      }));
    return [base];
  });
}

export function fromAnthropic(messages: readonly unknown[]): AgentMessage[] {
  return messages.flatMap((raw): AgentMessage[] => {
    if (!isRecord(raw)) return [];
    const role =
      raw.role === "assistant"
        ? "assistant"
        : raw.role === "user"
          ? "user"
          : undefined;
    if (!role) return [];
    const regular: AgentPart[] = [];
    const results: AgentPart[] = [];
    for (const block of asArray(raw.content)) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string")
        regular.push({ type: "text", text: block.text });
      if (block.type === "tool_use") {
        const id = asString(block.id);
        const name = asString(block.name);
        if (id && name)
          regular.push({ type: "tool-call", id, name, input: block.input });
      }
      if (block.type === "tool_result") {
        const id = asString(block.tool_use_id);
        if (id)
          results.push({
            type: "tool-result",
            toolCallId: id,
            output: block.content,
            ...(block.is_error === true ? { isError: true } : {}),
          });
      }
    }
    const output: AgentMessage[] = [];
    if (regular.length > 0) output.push({ role, parts: regular });
    if (results.length > 0) output.push({ role: "tool", parts: results });
    return output;
  });
}

export function toAnthropic(messages: readonly AgentMessage[]): unknown[] {
  return messages.flatMap((message): unknown[] => {
    const blocks = message.parts.flatMap((part): unknown[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "tool-call")
        return [
          { type: "tool_use", id: part.id, name: part.name, input: part.input },
        ];
      return [
        {
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.output,
          ...(part.isError === undefined ? {} : { is_error: part.isError }),
        },
      ];
    });
    if (blocks.length === 0) return [];
    return [
      {
        role: message.role === "assistant" ? "assistant" : "user",
        content: blocks,
      },
    ];
  });
}

export function fromGemini(contents: readonly unknown[]): AgentMessage[] {
  const pending = new Map<string, string[]>();
  let sequence = 0;
  return contents.flatMap((raw): AgentMessage[] => {
    if (!isRecord(raw)) return [];
    const role = raw.role === "model" ? "assistant" : "user";
    const regular: AgentPart[] = [];
    const results: AgentPart[] = [];
    for (const part of asArray(raw.parts)) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string")
        regular.push({ type: "text", text: part.text });
      if (isRecord(part.functionCall)) {
        const name = asString(part.functionCall.name);
        if (!name) continue;
        const id =
          asString(part.functionCall.id) ??
          `gemini-${String(++sequence)}-${name}`;
        pending.set(name, [...(pending.get(name) ?? []), id]);
        regular.push({
          type: "tool-call",
          id,
          name,
          input: part.functionCall.args,
        });
      }
      if (isRecord(part.functionResponse)) {
        const name = asString(part.functionResponse.name) ?? "unknown";
        const queue = pending.get(name) ?? [];
        const explicitId = asString(part.functionResponse.id);
        let id: string;
        if (explicitId !== undefined) {
          id = explicitId;
          const pendingIndex = queue.indexOf(explicitId);
          if (pendingIndex >= 0) queue.splice(pendingIndex, 1);
        } else {
          id = queue.shift() ?? `orphan-gemini-${String(++sequence)}-${name}`;
        }
        pending.set(name, queue);
        results.push({
          type: "tool-result",
          toolCallId: id,
          output: part.functionResponse.response,
        });
      }
    }
    const output: AgentMessage[] = [];
    if (regular.length > 0) output.push({ role, parts: regular });
    if (results.length > 0) output.push({ role: "tool", parts: results });
    return output;
  });
}

export function toGemini(messages: readonly AgentMessage[]): unknown[] {
  const names = new Map<string, string>();
  for (const message of messages)
    for (const part of message.parts)
      if (part.type === "tool-call") names.set(part.id, part.name);
  return messages.flatMap((message): unknown[] => {
    const parts = message.parts.map((part) => {
      if (part.type === "text") return { text: part.text };
      if (part.type === "tool-call")
        return {
          functionCall: { id: part.id, name: part.name, args: part.input },
        };
      return {
        functionResponse: {
          id: part.toolCallId,
          name: names.get(part.toolCallId) ?? "reconciled_tool",
          response: part.output,
        },
      };
    });
    return parts.length === 0
      ? []
      : [{ role: message.role === "assistant" ? "model" : "user", parts }];
  });
}

export function fromAISDK(messages: readonly unknown[]): AgentMessage[] {
  return messages.flatMap((raw): AgentMessage[] => {
    if (!isRecord(raw)) return [];
    const role =
      raw.role === "assistant"
        ? "assistant"
        : raw.role === "system"
          ? "system"
          : raw.role === "tool"
            ? "tool"
            : "user";
    const parts: AgentPart[] = [];
    for (const part of asArray(raw.parts ?? raw.content)) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string")
        parts.push({ type: "text", text: part.text });
      const id = asString(part.toolCallId);
      const name =
        asString(part.toolName) ??
        (typeof part.type === "string" && part.type.startsWith("tool-")
          ? part.type.slice(5)
          : undefined);
      const state = asString(part.state);
      if (id && name)
        parts.push({ type: "tool-call", id, name, input: part.input });
      if (id && (state === "output-available" || state === "output-error"))
        parts.push({
          type: "tool-result",
          toolCallId: id,
          output: state === "output-error" ? part.errorText : part.output,
          ...(state === "output-error" ? { isError: true } : {}),
        });
    }
    return parts.length === 0 ? [] : [{ role, parts }];
  });
}

export function toAISDK(messages: readonly AgentMessage[]): unknown[] {
  const results = new Map<
    string,
    Extract<AgentPart, { type: "tool-result" }>
  >();
  for (const message of messages)
    for (const part of message.parts)
      if (part.type === "tool-result") results.set(part.toolCallId, part);
  return messages.flatMap((message): unknown[] => {
    if (message.role === "tool") return [];
    const parts = message.parts.flatMap((part): unknown[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "tool-result") return [];
      const result = results.get(part.id);
      if (!result)
        return [
          {
            type: `tool-${part.name}`,
            toolCallId: part.id,
            toolName: part.name,
            state: "input-available",
            input: part.input,
          },
        ];
      return [
        result.isError
          ? {
              type: `tool-${part.name}`,
              toolCallId: part.id,
              toolName: part.name,
              state: "output-error",
              input: part.input,
              errorText: String(result.output),
            }
          : {
              type: `tool-${part.name}`,
              toolCallId: part.id,
              toolName: part.name,
              state: "output-available",
              input: part.input,
              output: result.output,
            },
      ];
    });
    return parts.length === 0 ? [] : [{ role: message.role, parts }];
  });
}

const adapters = {
  openai: { from: fromOpenAI, to: toOpenAI },
  anthropic: { from: fromAnthropic, to: toAnthropic },
  gemini: { from: fromGemini, to: toGemini },
  "ai-sdk": { from: fromAISDK, to: toAISDK },
} as const;

export function reconcileProvider<T = unknown>(
  provider: Provider,
  messages: readonly unknown[],
  options?: ReconcileOptions,
): ProviderReconcileResult<T> {
  const adapter = adapters[provider];
  const result = reconcileTranscript(adapter.from(messages), options);
  return {
    ...result,
    canonical: result.messages,
    messages: adapter.to(result.messages) as T[],
  };
}
