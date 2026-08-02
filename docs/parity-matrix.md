# Feature-by-feature replacement verification

Each row must have an automated check before release.

| Capability | Evidence | Status |
|---|---|---|
| Direct Agent foreground | `test/e2e/subagent.e2e.test.ts` | pass |
| Direct Agent background | `test/e2e/subagent.e2e.test.ts` | pass |
| get result / wait / verbose | `test/e2e/subagent.e2e.test.ts` | pass |
| mid-run steer | `test/e2e/subagent.e2e.test.ts`, `test/integration/subagent-runtime.test.ts` | pass |
| same-process resume | `test/e2e/subagent.e2e.test.ts` | pass |
| persisted registry and restart resume | `test/integration/session-registry.test.ts` | pass |
| parent context inheritance | `test/e2e/subagent-features.e2e.test.ts` | pass |
| thinking level | `test/e2e/subagent-features.e2e.test.ts` | pass |
| graceful max-turn protocol | `test/integration/subagent-runtime.test.ts` (RPC runtime) | pass |
| explicit Child extension/MCP allowlist | `test/integration/subagent-runtime.test.ts`, `test/e2e/subagent.e2e.test.ts` | pass |
| explicit Child skill allowlist | same | pass |
| tool allowlist and denylist | `test/e2e/subagent-features.e2e.test.ts` | pass |
| prompt replace/append | `test/integration/subagent-runtime.test.ts`, `test/e2e/subagent-features.e2e.test.ts` | pass |
| model fuzzy resolution | `test/unit/model-resolution.test.ts` | pass |
| transcript and conversation | `test/integration/subagent-runtime.test.ts` | pass |
| direct Agent worktree | `test/integration/direct-agent-worktree.test.ts` | pass |
| memory scope/read-only authority | `test/unit/memory.test.ts` | pass |
| completion notification and join | `test/unit/notifications.test.ts`, `test/e2e/subagent.e2e.test.ts` | pass |
| lifecycle events | `test/e2e/subagent.e2e.test.ts` | pass |
| cross-extension RPC | `test/unit/subagent-rpc.test.ts` | pass |
| /agents management | `test/unit/compat-management.test.ts` | pass |
| one-shot scheduling | `test/e2e/subagent-features.e2e.test.ts` | pass |
| cron and repeating interval schedules | `test/unit/scheduler.test.ts` | pass |
| FleetView widget, selection, keyboard navigation, conversation overlay, steer/stop | `test/unit/fleet-view.test.ts`, `test/unit/compat-management.test.ts` | pass |
| nested child-owned delegation | Host-approved mesh growth only; see `docs/replacement-delta.md` | intentional secure difference |
| native mesh DAG/recovery/worktree | existing integration and E2E suites | pass |

The extension is not production-ready while any non-intentional blocker remains.
