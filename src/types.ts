export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}
export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  output: unknown;
  isError?: boolean;
}
export type AgentPart = TextPart | ToolCallPart | ToolResultPart;
export interface AgentMessage {
  role: AgentRole;
  parts: readonly AgentPart[];
}

export type PendingPolicy = "error" | "remove" | "keep";
export type OrphanPolicy = "remove" | "keep";
export interface ReconcileOptions {
  pending?: PendingPolicy;
  orphanResults?: OrphanPolicy;
  cancellationMessage?: string | ((call: ToolCallPart) => string);
  maxMessages?: number;
  maxParts?: number;
}

export type ChangeKind =
  | "complete-pending"
  | "remove-pending"
  | "move-result"
  | "remove-orphan"
  | "remove-invalid-call"
  | "remove-duplicate-call"
  | "remove-duplicate-result";
export interface ReconcileChange {
  kind: ChangeKind;
  toolCallId: string;
  messageIndex: number;
  detail: string;
}
export interface ReconcileResult {
  messages: AgentMessage[];
  changes: ReconcileChange[];
  pendingToolCallIds: string[];
  safeToReplay: boolean;
  changed: boolean;
}

export class ReconcileLimitError extends RangeError {
  override name = "ReconcileLimitError";
}
