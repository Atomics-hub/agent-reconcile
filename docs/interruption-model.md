# Interruption model

Stopping an agent has at least three independent states:

1. **Execution state** — whether the model stream or tool process is still running.
2. **Transcript state** — whether every persisted tool call has one provider-valid result.
3. **Side-effect state** — whether an external action committed.

`AbortController` addresses the first. `agent-reconcile` addresses the second. Only the tool or its durable idempotency record can establish the third.

| Known state                              | Recommended transcript action                                    | External action                           |
| ---------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Tool never started                       | Synthetic cancellation result                                    | None                                      |
| Tool stopped before commit               | Synthetic cancellation result                                    | None                                      |
| Tool committed and result is recoverable | Persist the recovered real result                                | Do not repeat                             |
| Tool status is unknown                   | Keep pending or emit an application-specific indeterminate error | Reconcile by idempotency key before retry |
| Result exists but was persisted late     | Let `agent-reconcile` move it beside its call group              | Do not repeat                             |
| Result has no matching call              | Remove by default                                                | Investigate persistence ordering          |

## Safe stop sequence

1. Prevent new model/tool work from starting.
2. Fire the abort signal.
3. Await the framework's stream/tool settlement boundary.
4. Recover durable tool outcomes when possible.
5. Reconcile the transcript.
6. Persist the reconciled transcript and its `changes` atomically.
7. Resume only when `safeToReplay` is `true`.

The package cannot make steps 1–4 framework-independent. It is intentionally a pure transform for steps 5–6.
