# Security policy

## Supported versions

Security fixes are provided for the latest release.

## Reporting

Please report suspected vulnerabilities privately through GitHub Security Advisories for this repository. Do not include secrets, production transcripts, or provider credentials in a report.

## Trust boundaries

- The core API is a synchronous, pure transform and performs no network, filesystem, logging, evaluation, or tool execution.
- Tool inputs and outputs are treated as opaque values. Callers remain responsible for secret handling and redaction.
- The CLI parses untrusted JSON and imposes a 64 MiB input limit by default.
- Reconciliation does not prove whether an external side effect committed. Use durable idempotency keys for side-effecting tools.
