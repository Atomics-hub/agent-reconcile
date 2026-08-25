# agent-reconcile

Repair interrupted AI agent tool-call histories into safe, replayable transcripts.

[![npm version](https://img.shields.io/npm/v/agent-reconcile.svg)](https://www.npmjs.com/package/agent-reconcile)
[![CI](https://github.com/Atomics-hub/agent-reconcile/actions/workflows/ci.yml/badge.svg)](https://github.com/Atomics-hub/agent-reconcile/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/agent-reconcile.svg)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen.svg)](./package.json)

An abort signal can stop work. It cannot repair the half-written conversation the work leaves behind.

If an agent is interrupted after the model emits a tool call but before the tool result is persisted, the next model request may be rejected, replay the tool, or continue from inconsistent state. `agent-reconcile` closes every interrupted call with an explicit error result, relocates late results beside their call group, removes orphaned and duplicate records, and returns an audit trail of every change.

```sh
npm install agent-reconcile
```

```ts
import { reconcileTranscript } from "agent-reconcile";

const repaired = reconcileTranscript([
  {
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "call_42",
        name: "charge_card",
        input: { orderId: "order_7" },
      },
    ],
  },
]);

repaired.safeToReplay; // true
repaired.messages[1];
// {
//   role: "tool",
//   parts: [{
//     type: "tool-result",
//     toolCallId: "call_42",
//     output: "Tool execution interrupted before a result was recorded: charge_card",
//     isError: true
//   }]
// }
```

## Why this exists

Agent frameworks have real interruption races:

- A stop operation can fire an abort signal and return before the stream pipeline settles, allowing buffered updates to arrive after state is cleared ([Vercel AI SDK issue #13962](https://github.com/vercel/ai/issues/13962)).
- Persisted or replayed tool history can contain malformed arguments or missing counterparts that strict providers reject ([Vercel AI SDK issue #19274](https://github.com/vercel/ai/issues/19274)).
- Orphaned Anthropic tool references have required application-level pruning ([Vercel AI SDK issue #12504](https://github.com/vercel/ai/issues/12504)).

Generic cancellation packages cancel promises. Checkpoint packages persist state. Neither establishes a provider-valid terminal state for every tool call already committed to the transcript.

## What it guarantees

With the default policies, for each unique canonical tool-call ID:

- exactly one result follows its call group;
- missing results become explicit errors;
- late results move directly behind the originating group;
- orphaned results and duplicate calls/results are removed;
- the input is never mutated;
- the output is idempotent: reconciling it again makes no changes;
- work is bounded by configurable message and part limits.

Every edit appears in `changes`. No repair is silent.

```ts
const { messages, changes, changed, safeToReplay, pendingToolCallIds } =
  reconcileTranscript(history);
```

## Provider adapters

The adapter entry point has structural types and no SDK peer dependencies:

```ts
import { reconcileProvider } from "agent-reconcile/adapters";

const openAI = reconcileProvider("openai", openAIMessages);
const anthropic = reconcileProvider("anthropic", anthropicMessages);
const gemini = reconcileProvider("gemini", geminiContents);
const aiSDK = reconcileProvider("ai-sdk", uiMessages);

await save(aiSDK.messages);
```

Supported shapes:

| Adapter       | Calls                  | Results            | Special handling                                          |
| ------------- | ---------------------- | ------------------ | --------------------------------------------------------- |
| OpenAI        | `assistant.tool_calls` | `role: "tool"`     | Parses JSON arguments without throwing on malformed input |
| Anthropic     | `tool_use`             | `tool_result`      | Emits error results with `is_error: true`                 |
| Gemini        | `functionCall`         | `functionResponse` | Correlates ID-less parallel calls FIFO by function name   |
| Vercel AI SDK | dynamic `tool-*` parts | output states      | Converts pending states to `output-error`                 |

Low-level `fromOpenAI`, `toOpenAI`, `fromAnthropic`, `toAnthropic`, `fromGemini`, `toGemini`, `fromAISDK`, and `toAISDK` functions are also exported.

## Policies

The default is deliberately conservative:

```ts
reconcileTranscript(history, {
  pending: "error", // "error" | "remove" | "keep"
  orphanResults: "remove", // "remove" | "keep"
  cancellationMessage: (call) => `Cancelled ${call.name} (${call.id})`,
  maxMessages: 10_000,
  maxParts: 100_000,
});
```

- `pending: "error"` preserves the model's call and creates an error result, which is usually the safest continuation.
- `pending: "remove"` removes unresolved calls. Use this only if dropping the model's decision is acceptable.
- `pending: "keep"` makes no terminal result and returns `safeToReplay: false`.
- `orphanResults: "keep"` retains unmatched results and returns `safeToReplay: false`.

Invalid work limits throw `ReconcileLimitError` before unbounded traversal.

## CLI

Repair canonical JSON from a file or stdin:

```sh
agent-reconcile history.json --pretty
agent-reconcile history.json --provider openai --pretty
cat messages.json | agent-reconcile --provider anthropic
```

Use `--check` in CI. It exits `1` when a repair is needed or the selected policy leaves the transcript unsafe, `2` for invalid input/usage, and `0` for an unchanged replay-safe transcript.

```sh
agent-reconcile persisted-history.json --check
```

The CLI rejects inputs over 64 MiB by default; override with `--max-bytes`.

## Canonical format

```ts
type AgentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      output: unknown;
      isError?: boolean;
    };

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: readonly AgentPart[];
}
```

## The hard boundary: side effects

`agent-reconcile` repairs transcript state. It does **not** know whether an interrupted tool already charged a card, sent an email, or wrote to a database. A synthetic error result must not be interpreted as proof that no side effect occurred.

For side-effecting tools:

1. assign an idempotency key before execution;
2. persist that key with the tool call;
3. query the tool's durable status after interruption;
4. provide the real result when known;
5. synthesize cancellation only when the outcome cannot be recovered safely.

See [Interruption model](./docs/interruption-model.md) for the decision table.

## Performance and portability

- zero runtime dependencies;
- ESM and CommonJS exports;
- Node.js 18+;
- browser-safe core and adapters;
- linear transcript traversal;
- tested with 10,000 interrupted calls and 3,000 generated cases.

## Related package

[`agent-transcript`](https://github.com/Atomics-hub/agent-transcript) audits provider histories and explains replay failures. `agent-reconcile` is the smaller runtime primitive for deterministically closing interrupted tool transactions. Use the auditor for diagnostics and this package in stop/recovery paths.

## Security

Provider payloads remain caller-owned `unknown` values; the library does not execute, stringify, log, or send them from the core API. Read [SECURITY.md](./SECURITY.md) for reporting and trust boundaries.

## License

MIT © Atomics Hub
