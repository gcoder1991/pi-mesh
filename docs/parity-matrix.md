# Feature-by-feature replacement verification

Each row must have an automated check before release.

| Capability | Evidence | Status |
|---|---|---|
| Direct Agent foreground | `test/e2e/subagent.e2e.test.ts` | pass |
| Direct Agent background | `test/e2e/subagent.e2e.test.ts` | pass |
| get result / wait / verbose | `test/e2e/subagent.e2e.test.ts` | pass |
| mid-run steer | `test/e2e/subagent.e2e.test.ts`, `test/integration/subagent-runtime.test.ts` | pass |
| same-process resume | `test/e2e/subagent.e2e.test.ts` | pass |
| session-scoped persisted registry and restart resume | `test/integration/session-registry.test.ts` | pass |
| parent context inheritance | `test/e2e/subagent-features.e2e.test.ts` | pass |
| thinking level | `test/e2e/subagent-features.e2e.test.ts` | pass |
| graceful max-turn protocol | `test/integration/subagent-runtime.test.ts` | pass |
| explicit Child extension/MCP allowlist | `test/integration/subagent-runtime.test.ts`, `test/e2e/subagent.e2e.test.ts` | pass |
| explicit Child skill allowlist | same | pass |
| tool allowlist/denylist and Mesh-only `mesh_control` exposure | `test/integration/manager.test.ts`, `test/integration/subagent-runtime.test.ts`, `test/e2e/process.e2e.test.ts` | pass |
| prompt replace/append | `test/integration/subagent-runtime.test.ts`, `test/e2e/subagent-features.e2e.test.ts` | pass |
| model fuzzy resolution and Host model inheritance | `test/unit/model-resolution.test.ts`, `test/unit/extension.test.ts` | pass |
| Host extension provider/runtime inheritance | `test/integration/subagent-runtime.test.ts`, live CPA smoke | pass |
| transcript and conversation | `test/integration/subagent-runtime.test.ts` | pass |
| direct Agent worktree | `test/integration/direct-agent-worktree.test.ts` | pass |
| memory scope/read-only authority | `test/unit/memory.test.ts` | pass |
| Direct and async Mesh completion notification and join | `test/unit/notifications.test.ts`, extension E2E | pass |
| lifecycle events and real tool-use telemetry | `test/e2e/subagent.e2e.test.ts`, `test/integration/session-concurrency.test.ts` | pass |
| cross-extension RPC v2 and active-session context | `test/unit/subagent-rpc.test.ts` | pass |
| /agents management and scheduled-job cancellation | `test/unit/compat-management.test.ts`, `test/unit/scheduler.test.ts` | pass |
| one-shot scheduling | `test/e2e/subagent-features.e2e.test.ts` | pass |
| Direct result preview and full output artifact bounds | `test/integration/session-registry.test.ts` | pass |
| cancellation escalation and terminal fencing | `test/e2e/process.e2e.test.ts`, `test/integration/session-concurrency.test.ts` | pass |
| cron and repeating interval schedules, option persistence, restore timing | `test/unit/scheduler.test.ts`, `test/e2e/subagent-features.e2e.test.ts` | pass |
| Unified FleetView and pi-subagents-style status/conversation page, keybindings, inline steer, two-key stop | `test/unit/fleet-view.test.ts`, `test/unit/conversation-viewer.test.ts` | pass |
| nested child-owned delegation | Host-approved mesh growth only; see `docs/replacement-delta.md` | intentional secure difference |
| native mesh DAG/recovery/worktree | existing integration and E2E suites | pass |
| operator topology presets and race cancellation | `test/integration/advanced.test.ts`, `test/integration/manager.test.ts` | pass |
| shared per-session Direct/Mesh fleet concurrency | `test/unit/fleet-limiter.test.ts`, `test/integration/fleet-concurrency.test.ts` | pass |
| mailbox stale lock recovery | `test/unit/store.test.ts` | pass |
| terminal Run retention and debug log bounds | `test/unit/store.test.ts`, `test/unit/settings.test.ts` | pass |
| shared Host/Child Mesh task schema | `src/schemas.ts`, extension/control tests | pass |

The extension is not production-ready while any non-intentional blocker remains.
