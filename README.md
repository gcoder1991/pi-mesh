# pi-mesh

A production-oriented Pi extension that combines a durable Host-owned agent mesh with Claude Code-style direct sub-agents.

It provides the parallel entry points:

```text
Agent / get_subagent_result / steer_subagent
MeshManager → shared Subagent Runtime → DAG nodes
```

It keeps:

- host-owned child-agent management
- isolated Pi child processes
- graph, sequence, parallel, race, supervisor/mixture, reflection, and debate operators
- bounded concurrency, retries, timeouts, and graph size
- status, pause/resume, cancellation, fail-fast behavior, and result aggregation
- durable mailbox send/broadcast/inbox/ack
- child growth proposals with explicit Host approval
- atomic run checkpoints and interrupted-run recovery
- bundled, user, and trusted project agent definitions

It intentionally drops Astralink's ACP/text-frame protocol, protocol digests, repair turns, launch attestations, and transport-session abstraction. Pi tool schemas provide the command envelope; direct child processes provide isolation.

## Install

```bash
pi install /absolute/path/to/pi-mesh
```

For development:

```bash
pi -e ./index.ts
```

## Settings

Pi's documented global configuration root is `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), so pi-mesh reads global settings from:

```text
~/.pi/agent/mesh/settings.yaml
```

A trusted project may override individual values in `.pi/mesh/settings.yaml`:

```yaml
maxAgentDepth: 8
maxConcurrentAgents: 4
maxNodes: 64
messagePayloadMaxBytes: 32768
recipientUnreadMaxBytes: 1048576
childExtensions: {}
childSkills: {}
joinMode: smart
debug: false
```

`maxAgentDepth` limits the longest dependency chain, including approved growth. `maxConcurrentAgents` caps Mesh nodes and direct background Agents; `maxNodes` caps a Mesh. Mailbox settings cap each message and each recipient's unacknowledged content. `childExtensions` and `childSkills` map trusted logical names to explicit resource paths. `joinMode` is `smart`, `async`, or `group`. Set `debug: true` to append structured events to `.pi/mesh/debug.jsonl`. Settings are session-scoped; use `/reload` after changing them.

## Tools

The extension registers native `mesh` plus compatibility tools `Agent`, `get_subagent_result`, and `steer_subagent`. Direct Agent supports foreground/background execution, bounded queueing, steer/resume, persistent sessions, transcripts, context inheritance, explicit Child extension/skill allowlists, memory, schedules, and strict Worktree isolation. Use `/agents` or `ctrl+shift+a` for management/FleetView.

See `docs/parity-matrix.md`, `docs/replacement-delta.md`, and `docs/release-review.md` for the final replacement audit.

### Native mesh

### Discover agents

```json
{ "action": "list_agents" }
```

Agent definitions are loaded in override order:

1. bundled `agents/*.md`
2. `~/.pi/agent/agents/*.md`
3. nearest trusted `.pi/agents/*.md`

Project definitions override user and bundled definitions with the same name. The parent model is instructed to call `list_agents` before its first Mesh run, or whenever routing is uncertain, so newly added agents do not require source changes.

Use the frontmatter `description` as the routing contract: state **when the parent should choose the agent**, not merely what its title is. The Markdown body is the child system prompt and should explain how the selected agent works.

```markdown
---
name: security-auditor
description: Read-only security reviewer for authentication, permissions, secrets, input validation, and trust-boundary changes; use after security-sensitive edits
tools: read,grep,find,ls,bash
---
Review the assigned scope for exploitable security problems. Do not edit files.
```

Agent definitions are discovered when listed or launched. Use `/reload` after changing mesh settings; reloading cleanly stops active children and leaves their runs paused for recovery.

Bundled routing roles:

| Agent | Use when |
|---|---|
| `scout` | Relevant local files or symbols are not yet known |
| `analyst` | A request or draft plan contains ambiguity, contradictions, or missing constraints |
| `planner` | Discovery is complete but design boundaries, decomposition, or dependency ordering remain unresolved |
| `worker` | A focused implementation task needs code changes and verification |
| `reviewer` | Completed code or a plan needs independent static review |
| `qa` | Completed behavior needs real command execution and artifact-backed scenario evidence |

`analyst`, `planner`, and `qa` are compact adaptations of role ideas from Oh My OpenAgent. OpenAgent-specific orchestration, recursive delegation, session loops, fixed artifact layouts, model routing, and unavailable tools were intentionally removed; Mesh remains the sole scheduler.

### Parallel run

```json
{
  "action": "run",
  "tasks": [
    { "id": "api", "agent": "scout", "task": "Inspect the API layer" },
    { "id": "db", "agent": "scout", "task": "Inspect persistence" }
  ],
  "maxConcurrency": 2,
  "worktree": true
}
```

### Dependency graph

```json
{
  "action": "run",
  "tasks": [
    { "id": "inspect", "agent": "scout", "task": "Find the root cause" },
    { "id": "fix", "agent": "worker", "task": "Apply the fix using the repository context", "dependsOn": ["inspect"] },
    { "id": "review", "agent": "reviewer", "task": "Review the completed fix", "dependsOn": ["fix"] }
  ],
  "failFast": true
}
```

Direct dependencies provide bounded evidence to downstream prompts, including output artifacts and Worktree commit/patch references. With Worktrees, a single Writer dependency becomes the child's base commit; multiple Writer dependencies require `integration: true` so merging is explicit.

### Git worktrees

Set `worktree: true` to require a clean Git checkout and run every node in its own detached temporary worktree. Changed work is committed and archived to a retained `pi-mesh/<run>/<node>-<attempt>` branch pointing at final HEAD; the main checkout stays untouched. Each attempt records `attempt-result.json` with exit code, signal, bounded stderr, usage, model, timestamps, and output reference. Writer attempts also record a binary patch and `handoff.json` under `.pi/mesh/artifacts/<run>/<node>/`. `worktreeSetupHook` may name an executable setup script. If preservation fails, the worktree is left in place and the node fails with its path. Use `handoff_list` for integration commands.

### Background run

```json
{ "action": "run", "async": true, "tasks": [{ "agent": "worker", "task": "Run the long check" }] }
```

Then use:

```json
{ "action": "status", "runId": "..." }
{ "action": "cancel", "runId": "..." }
{ "action": "list" }
```

Run checkpoints are stored under `.pi/mesh/runs/`. Every attempt writes machine-readable `attempt-result.json` and human-readable `diagnostic.md` under `.pi/mesh/artifacts/<run>/<node>/attempt-<n>/`; failed-node status output links to both files. On session shutdown, active children are terminated, worktrees are finalized, leases are released, and runs remain paused. After reopening Pi, call `{ "action": "recover" }` followed by `resume`; nodes interrupted without terminal attempt evidence are restarted. Tasks must therefore be idempotent or inspect existing work before writing. Synchronous runs return aggregated nested-model usage to Pi; detached async usage remains available in run/node state rather than the original completed tool result.

Mailbox records live under `.pi/mesh/messages/`, and growth proposals under `.pi/mesh/growth/`. Children receive a restricted `mesh_control` tool for `send`, `broadcast`, `reply`, `inbox`, `ack`, and `grow`. A `grow` call only writes a proposal. The Host must inspect `growth_list` and commit it with `growth_decide`.

Advanced scheduling is selected on `run` with `operator`: `graph`, `sequence`, `parallel`, `race`, `supervisor`, `mixture`, `reflection`, or `debate`. Supervisor/mixture use the last task as synthesizer; reflection/debate are bounded task sequences. Per-task `retries` and `timeoutMs` cover retry and timeout behavior without a second operator runtime.

## Agent format

```markdown
---
name: tester
description: Runs focused tests
tools: read,bash,grep,find,ls
model: provider/model
---
Run the assigned tests and report exact failures. Do not edit files.
```

Child launches use `--no-extensions --no-skills`, then add only explicitly approved `-e` and `--skill` resources. Mesh children also load the restricted bundled `mesh_control` extension. They cannot call the Host `mesh` tool recursively. Their ordinary tool allowlist comes from the agent definition.

## Development

```bash
npm install
npm test
```

`PI_MESH_PI_BINARY` can point tests or custom installations at a specific Pi executable.
