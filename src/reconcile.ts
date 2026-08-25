import type {
  AgentMessage,
  AgentPart,
  ReconcileChange,
  ReconcileOptions,
  ReconcileResult,
  ToolCallPart,
  ToolResultPart,
} from "./types.js";
import { ReconcileLimitError } from "./types.js";

const DEFAULT_MAX_MESSAGES = 10_000;
const DEFAULT_MAX_PARTS = 100_000;

function cancellationText(
  call: ToolCallPart,
  option: ReconcileOptions["cancellationMessage"],
): string {
  if (typeof option === "function") return option(call);
  return (
    option ??
    `Tool execution interrupted before a result was recorded: ${call.name}`
  );
}

function clonePart(part: AgentPart): AgentPart {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "tool-call")
    return {
      type: "tool-call",
      id: part.id,
      name: part.name,
      input: part.input,
    };
  return {
    type: "tool-result",
    toolCallId: part.toolCallId,
    output: part.output,
    ...(part.isError === undefined ? {} : { isError: part.isError }),
  };
}

export function reconcileTranscript(
  input: readonly AgentMessage[],
  options: ReconcileOptions = {},
): ReconcileResult {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxParts = options.maxParts ?? DEFAULT_MAX_PARTS;
  if (
    !Number.isSafeInteger(maxMessages) ||
    maxMessages < 0 ||
    !Number.isSafeInteger(maxParts) ||
    maxParts < 0
  ) {
    throw new ReconcileLimitError(
      "Work limits must be non-negative safe integers.",
    );
  }
  if (input.length > maxMessages)
    throw new ReconcileLimitError(
      `Transcript exceeds maxMessages (${String(maxMessages)}).`,
    );

  const calls = new Map<string, { call: ToolCallPart; messageIndex: number }>();
  const firstResults = new Map<
    string,
    { result: ToolResultPart; messageIndex: number }
  >();
  const resultCount = new Map<string, number>();
  let parts = 0;
  for (const [messageIndex, message] of input.entries()) {
    parts += message.parts.length;
    if (parts > maxParts)
      throw new ReconcileLimitError(
        `Transcript exceeds maxParts (${String(maxParts)}).`,
      );
    for (const part of message.parts) {
      if (
        part.type === "tool-call" &&
        message.role === "assistant" &&
        part.id.length > 0 &&
        part.name.length > 0 &&
        !calls.has(part.id)
      )
        calls.set(part.id, { call: part, messageIndex });
      if (part.type === "tool-result") {
        resultCount.set(
          part.toolCallId,
          (resultCount.get(part.toolCallId) ?? 0) + 1,
        );
        if (!firstResults.has(part.toolCallId))
          firstResults.set(part.toolCallId, { result: part, messageIndex });
      }
    }
  }

  const pending = [...calls].filter(([id]) => !resultCount.has(id));
  const pendingPolicy = options.pending ?? "error";
  const orphanPolicy = options.orphanResults ?? "remove";
  const changes: ReconcileChange[] = [];
  const emittedCalls = new Set<string>();
  const output: AgentMessage[] = [];

  for (const [messageIndex, message] of input.entries()) {
    const kept: AgentPart[] = [];
    const callsInMessage: ToolCallPart[] = [];
    for (const part of message.parts) {
      if (part.type === "tool-call") {
        if (
          message.role !== "assistant" ||
          part.id.length === 0 ||
          part.name.length === 0
        ) {
          changes.push({
            kind: "remove-invalid-call",
            toolCallId: part.id,
            messageIndex,
            detail:
              "Removed a tool call without an assistant role, identifier, or name.",
          });
          continue;
        }
        if (emittedCalls.has(part.id)) {
          changes.push({
            kind: "remove-duplicate-call",
            toolCallId: part.id,
            messageIndex,
            detail: "Removed a duplicate tool call identifier.",
          });
          continue;
        }
        emittedCalls.add(part.id);
        if (pendingPolicy === "remove" && !resultCount.has(part.id)) {
          changes.push({
            kind: "remove-pending",
            toolCallId: part.id,
            messageIndex,
            detail: "Removed an unresolved tool call.",
          });
          continue;
        }
        callsInMessage.push(part);
      }
      if (part.type === "tool-result") {
        if (!calls.has(part.toolCallId) && orphanPolicy === "remove") {
          changes.push({
            kind: "remove-orphan",
            toolCallId: part.toolCallId,
            messageIndex,
            detail: "Removed a result with no matching tool call.",
          });
          continue;
        }
        if (firstResults.get(part.toolCallId)?.result !== part) {
          changes.push({
            kind: "remove-duplicate-result",
            toolCallId: part.toolCallId,
            messageIndex,
            detail: "Removed a duplicate tool result.",
          });
          continue;
        }
        if (calls.has(part.toolCallId)) continue;
      }
      kept.push(clonePart(part));
    }
    if (kept.length > 0 || message.parts.length === 0)
      output.push({ role: message.role, parts: kept });
    const completed: ToolResultPart[] = [];
    for (const call of callsInMessage) {
      const found = firstResults.get(call.id);
      if (found) {
        completed.push(clonePart(found.result) as ToolResultPart);
        if (found.messageIndex !== messageIndex + 1) {
          changes.push({
            kind: "move-result",
            toolCallId: call.id,
            messageIndex: found.messageIndex,
            detail: "Moved the tool result directly after its call group.",
          });
        }
      } else if (pendingPolicy === "error") {
        completed.push({
          type: "tool-result",
          toolCallId: call.id,
          output: cancellationText(call, options.cancellationMessage),
          isError: true,
        });
        changes.push({
          kind: "complete-pending",
          toolCallId: call.id,
          messageIndex,
          detail: "Added a synthetic cancellation result.",
        });
      }
    }
    if (completed.length > 0) output.push({ role: "tool", parts: completed });
  }

  const unresolved = pendingPolicy === "keep" ? pending.map(([id]) => id) : [];
  const orphanKept =
    orphanPolicy === "keep" && [...resultCount].some(([id]) => !calls.has(id));
  return {
    messages: output,
    changes,
    pendingToolCallIds: unresolved,
    safeToReplay: unresolved.length === 0 && !orphanKept,
    changed: changes.length > 0,
  };
}
