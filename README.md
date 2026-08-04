# pi-mesh

A production-oriented Pi extension that combines a durable Host-owned agent mesh with Claude Code-style direct sub-agents.

It provides the parallel entry points:

```text
Agent / get_subagent_result / steer_subagent
MeshManager → the same SubagentRuntime implementation → DAG nodes
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
pi install npm:@gcoder1991/pi-mesh
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
maxConcurrentAgents: 8
maxNodes: 64
messagePayloadMaxBytes: 32768
recipientUnreadMaxBytes: 1048576
childExtensions: {}
childSkills: {}
joinMode: smart
debug: false
retentionDays: 30
maxTerminalRuns: 100
debugMaxBytes: 4194304
```

`maxAgentDepth` limits the longest dependency chain, including approved growth. `maxConcurrentAgents` is one shared per-Pi-session cap across Direct Agents, scheduled Agents, Mesh runs, and Mesh nodes; each Run's `maxConcurrency` is an additional per-run cap. `maxNodes` caps a Mesh. Mailbox settings cap each message and each recipient's unacknowledged content. `childExtensions` and `childSkills` map trusted logical names to explicit resource paths. `joinMode` is `smart`, `async`, or `group`. `retentionDays` and `maxTerminalRuns` bound terminal Run state, and `debugMaxBytes` rotates `debug.jsonl` to `debug.jsonl.1`. Settings are session-scoped; use `/reload` after changing them.

## Tools

The extension registers native `mesh` plus compatibility tools `Agent`, `get_subagent_result`, and `steer_subagent`. Direct Agent supports foreground/background execution, bounded queueing, steer/resume, opt-in persistent sessions, transcripts, context inheritance, explicit Child extension/skill allowlists, memory, schedules, and strict Worktree isolation. Direct registries are isolated per Pi session and large results keep a bounded preview plus a full artifact. While agents run, a below-editor main panel shows `main` plus Direct Agents and Mesh nodes with live elapsed time, turns, tool count/activity, and tokens. At an empty prompt press `↓` or `←`, navigate with `↑`/`↓`, and press `Enter` for the live status/conversation page. The page supports `j/k`, arrows, PageUp/PageDown, Home/End, inline `Enter` steering, and two-press `x` stop confirmation. Use `/agents` or `ctrl+shift+a` for management; `/agents` also lists and cancels scheduled jobs.

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
Async runs send a deduplicated follow-up notification when they finish. You can also use:

```json
{ "action": "status", "runId": "..." }
{ "action": "cancel", "runId": "..." }
{ "action": "list" }
```

Run checkpoints are stored under `.pi/mesh/runs/`. Every attempt writes machine-readable `attempt-result.json` and human-readable `diagnostic.md` under `.pi/mesh/artifacts/<run>/<node>/attempt-<n>/`; failed-node status output links to both files. On session shutdown, active children are terminated, worktrees are finalized, leases are released, and runs remain paused. After reopening Pi, call `{ "action": "recover" }` for interrupted running Runs, or `resume` for a deliberately/gracefully paused Run. Nodes interrupted without terminal attempt evidence are restarted. Tasks must therefore be idempotent or inspect existing work before writing. Synchronous runs return aggregated nested-model usage to Pi; detached async usage remains available in run/node state and its completion notification.

Mailbox records live under `.pi/mesh/messages/`, and growth proposals under `.pi/mesh/growth/`. Children receive a restricted `mesh_control` tool for `send`, `broadcast`, `reply`, `inbox`, `ack`, and `grow`. A `grow` call only writes a proposal. The Host must inspect `growth_list` and commit it with `growth_decide`.

Advanced scheduling is selected on `run` with `operator`: `graph`, `sequence`, `parallel`, `race`, `supervisor`, `mixture`, `reflection`, or `debate`. These are DAG topology presets over one shared runtime, not eight independent reasoning protocols: supervisor/mixture use the last task as synthesizer, reflection/debate are bounded sequential chains, and race cancels remaining nodes after the first success. Per-task `retries` and `timeoutMs` cover retry and timeout behavior without a second operator runtime.

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

`PI_MESH_PI_BINARY` can point tests or explicitly controlled installations at a specific Pi executable. Pi extensions are trusted code with the user's full system permissions; the cross-extension RPC event bus therefore assumes trusted co-loaded extensions rather than pretending to sandbox them. Child Pi processes inherit the Host environment so configured providers can authenticate. Use only trusted Agent definitions, Child resources, extensions, and environments.
