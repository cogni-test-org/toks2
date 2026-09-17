---
description: Observability finish pass — add minimal, high-signal logging/metrics for the changes in this branch (post-PR, no refactors).
---

# Observability Finish Pass (Node, Post-PR)

Goal: add **minimal, high-signal** logging/metrics for the changes in this branch. **No refactors** and **no observability redesign**.

## 0) Scope + budget (non-negotiable)

- Touch only files in the layer you changed:
  - Route/controller: `app/src/app/**`
  - Use-case/feature/service: `app/src/features/**`
  - External IO (adapters): `app/src/adapters/**`
- **Max 3 logs/request** (4 only if streaming).
- **Event names must come from the event registry.** No inline strings.
  - App-local + shared registry: `app/src/shared/observability/index.ts` (`EVENT_NAMES`).
  - Cross-node / shared events live in `@cogni/node-shared` (`packages/node-shared/src/observability/events/index.ts`) — add there only if the event is shared across nodes; otherwise add a node-local name to the app-local `EVENT_NAMES`.
- Use the typed log helper `logEvent()` (re-exported from `@cogni/node-shared` via `@/shared/observability`). Only call `logger.warn/error/fatal` directly for non-info levels.

## 1) Multi-node identity (verify, don't add)

Node identity flows from `.cogni/repo-spec.yaml`, not env vars. The logger and metrics registry receive `nodeId` at bootstrap. Your job is to **verify it's present**, not add it.

- Every log line MUST already carry `nodeId` in its base bindings (set at bootstrap). If it doesn't, that's a bug — file it.
- Every metric MUST already carry `node_id` as a default label. If it doesn't, that's a bug — file it.
- Do NOT add node-specific event names. Events are domain-scoped; `nodeId` in the payload discriminates.
- Inter-node calls (billing callbacks to/from the operator, SSO, future federation) MUST log BOTH `sourceNodeId` and `targetNodeId`.
- See your node's `app/src/shared/observability/AGENTS.md`.

## 2) Decide what to instrument (pick one)

- Endpoint behavior changed → add **route COMPLETE log** (+ rely on existing `http_*` metrics).
- Business logic changed → add **feature COMPLETE log** (only if route can't capture the key outcome fields).
- External dependency changed → add **adapter ERROR log** (errors only).
- Inter-node communication changed → add **internode SENT/RECEIVED/FAILED logs** with both node IDs.
- Pure refactor → usually add nothing.

## 3) Required logs (minimum set)

- Route/controller: `feature.<name>.complete`
  - Fields: `reqId` + `routeId`, plus `status`, `durationMs`, `outcome: success|error`, and **counts only**.
- Adapter (only on failure): `adapter.<dep>.error`
  - Fields: `dep`, `reasonCode`, `status?`, `durationMs`, `reqId?`.
- Inter-node: `internode.callback_sent` / `internode.callback_received` / `internode.callback_failed`
  - Fields: `sourceNodeId`, `targetNodeId`, `callId`, `durationMs`, `status`.
- When outcome=error, you must include `errorCode` (enum from the event registry) identifying the failure class; counts alone are not sufficient. Do not log raw error messages.
- External SDKs that print their own failures must be configured or wrapped before production use. If the SDK emits raw request diagnostics, **drop the entire SDK diagnostic before stdout/stderr/console**; do not sanitize-and-forward raw config, headers, URLs, HTML bodies, or message text. Emit a separate first-party adapter error with only stable fields (`reasonCode` / `error_code`, HTTP status, response key names, counts, duration).
- One-time secret rotation paths belong on internal ops endpoints or scripts, not product UI. Their terminal log should be a single COMPLETE event with target/rotated/skipped/failed counts and an aggregate stable errorCode. Return per-target ids only to the authenticated operator response, not to prod logs.

## 4) Metrics rule

- Add a metric only if you will **alert/graph** it.
- Default: do **not** add feature metrics if existing `http_*` already covers the endpoint.
- Allowed labels only: `route`, `method`, `statusBucket`, `env`, `node_id`, `provider`, `model_class`, `error_code`.
- Forbidden labels: `reqId`, `userId`, wallet, API key, raw path/query, user agent, modelId.

## 5) Privacy + payload safety

Never log: secrets, headers, tokens, signatures, passphrases, raw request config, full URLs, request/response bodies, prompts/content.
Only log: enums, booleans, counts, durations, coarse status buckets.

## 6) Self-check: can you debug a production issue with these changes?

Before marking observability complete, answer YES to every question below. If any answer is NO, you have a gap — fix it or document it as a known shortcoming.

1. **"Which node?"** — Can I filter logs/metrics to a single node? (`nodeId` in log base bindings, `node_id` metric label, `service` Loki label)
2. **"What happened?"** — Is there a deterministic terminal event (success OR error) for every operation? No silent exits.
3. **"Why did it fail?"** — Does every error path emit an `errorCode`? Can I distinguish timeout vs auth vs upstream vs bug?
4. **"Is the adapter alive?"** — If an external dependency (LLM provider, billing ingest, DB) goes down, is there an explicit failure signal? Absence of success logs is NOT a signal — you need explicit failure logs or a heartbeat metric.
5. **"Can I correlate across services?"** — Does `reqId`/`traceId` propagate through the full call chain, including inter-node callbacks?
6. **"Will the dashboard work?"** — Are all metric labels low-cardinality? Is `node_id` in both logs and metrics?

Read your own node's logs to confirm the signal landed — `/logs` (the operator log proxy), scoped to your node.

## 7) Deliverables (in PR description)

- Events added/used (name + fields)
- Metrics added (name + labels) or "none"
- Multi-node: confirmed `nodeId` present in logs + `node_id` in metrics (or filed bug if missing)
- Files changed
