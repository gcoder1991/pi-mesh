# pi-mesh

A production-oriented Pi extension that combines a durable Host-owned agent mesh with Claude Code-style direct sub-agents.

It provides the parallel entry points:

```text
Agent / get_subagent_result / steer_subagent
MeshManager → the same SubagentRuntime implementation → DAG nodes
```

It keeps:

- host-owned child-agent management
- isolated in-process Pi AgentSessions with a shared Host ModelRuntime
- graph, sequence, parallel, race, supervisor/mixture, reflection, and debate operators
- bounded concurrency, retries, timeouts, and graph size
- status, pause/resume, cancellation, fail-fast behavior, and result aggregation
- durable mailbox send/broadcast/inbox/ack
- child growth proposals with explicit Host approval
- atomic run checkpoints and interrupted-run recovery
- bundled, user, and trusted project agent definitions

Normal Host execution intentionally avoids Astralink's ACP/text-frame protocol, protocol digests, repair turns, launch attestations, and transport-session abstraction. Pi tool schemas provide the command envelope; in-process AgentSessions reuse the Host's authenticated ModelRuntime. A subprocess RPC/JSON path remains only behind `PI_MESH_PI_BINARY` for deterministic tests.

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
maxNodes: 128
defaultNodeTimeoutMs: 1800000
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

`maxAgentDepth` limits the longest dependency chain, including approved growth. `maxConcurrentAgents` is one shared per-Pi-session cap across Direct Agents, scheduled Agents, Mesh runs, and Mesh nodes; each Run's `maxConcurrency` is an additional per-run cap. `maxNodes` caps a Mesh. `defaultNodeTimeoutMs` defaults each attempt to 30 minutes unless the task supplies `timeoutMs`; at 80% the child is told to stop repeating the same strategy and wrap up before hard cancellation. Mailbox settings cap each message and each recipient's unacknowledged content. `childExtensions` and `childSkills` map trusted logical names to explicit resource paths. Child AgentSessions share the Host ModelRuntime, so extension-registered providers and authentication are inherited automatically. A Child without an explicit model inherits the Host's active model; task/Agent model pins remain authoritative. `joinMode` is `smart`, `async`, or `group`. `retentionDays` and `maxTerminalRuns` bound terminal Run state, and `debugMaxBytes` rotates `debug.jsonl` to `debug.jsonl.1`. Settings are session-scoped; use `/reload` after changing them.

## Tools

The extension registers native `mesh` plus compatibility tools `Agent`, `get_subagent_result`, and `steer_subagent`. Direct Agent supports foreground/background execution, bounded queueing, steer/resume, opt-in persistent sessions, transcripts, context inheritance, explicit Child extension/skill allowlists, memory, schedules, and strict Worktree isolation. Direct registries are isolated per Pi session and large results keep a bounded preview plus a full artifact. While agents run, a below-editor main panel shows `main` plus Direct Agents and Mesh nodes with live elapsed time, turns, tool count/activity, and tokens. At an empty prompt press `↓` or `←`, navigate with `↑`/`↓`, and press `Enter` for the live status/conversation page. The page supports `j/k`, arrows, PageUp/PageDown, Home/End, inline `Enter` steering, and two-press `x` stop confirmation. Use `/agents` or `ctrl+shift+a` for management; `/agents` also lists and cancels scheduled jobs.

Run `/mesh-tree` or press `ctrl+shift+m` to open the native live Mesh inspector modeled on `pi-subagents`' `/subagents-fleet`. The dependency-shaped node roster stays on the left; the selected node's task, status, model, elapsed time, tokens, tools, conversation, and artifacts appear on the right. Use `↑`/`↓` or `j`/`k` to select nodes, `Shift+K`/`Shift+J` or `PgUp`/`PgDn` to scroll detail, `r` to refresh, and `Esc` to close. Active Runs remain visible, and completed Runs linger for 20 seconds.

See `docs/parity-matrix.md`, `docs/replacement-delta.md`, and `docs/release-review.md` for the final replacement audit.

### Multi-model consensus

Use `/consensus <task>` for independent implementations followed by two critique/revision rounds, normalized ledgers, majority voting, and one canonical integration result. The command reads `ctx.modelRegistry.getAvailable()`, so it sees the same authenticated/custom provider catalog as `/model`, then asks once for the participant count, exact model set, and Finalizer model through `ask_user_question`. If that tool is unavailable, it asks the same choices in a normal response and waits.

The default recommendation is three distinct models (18 Mesh nodes); five models create 28 nodes and cost more. The generated run uses `operator: "graph"`, `worktree: true`, `failFast: true`, explicit task models, stable node IDs, and a foreground Mesh call. A strict majority selects the baseline when available; ties use the chosen Finalizer and are reported as `FINALIZER_TIEBREAK`. Minority opinions remain in the final audit object but only one canonical result is returned.

`/consensus` requires at least three available models and a clean Git checkout. It validates custom `provider/model` IDs against the Host catalog, calls `mesh list_agents` before routing, and never disables Worktree isolation. The current implementation is a Host prompt/Graph template rather than a second scheduler; existing Mesh recovery, retries, evidence, model precedence, and resource restrictions remain authoritative.

```text
/consensus Implement the requested change and run focused tests
```

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
{ "action": "retry_failed", "runId": "..." }
{ "action": "cancel", "runId": "..." }
{ "action": "list" }
```
Run checkpoints are stored under `.pi/mesh/runs/` and carry the originating Pi session ID; other sessions neither list nor recover them. Every attempt writes machine-readable `attempt-result.json` and human-readable `diagnostic.md` under `.pi/mesh/artifacts/<run>/<node>/attempt-<n>/`; failed-node status output links to both files. Use `retry_failed` after a partial failure or cancellation: successful nodes stay terminal, while unsuccessful nodes resume their persisted Agent session; if that session is unavailable, the replacement receives the prior error, output path, and bounded output tail so it continues instead of restarting blindly. On session shutdown, active children are terminated, worktrees are finalized, leases are released, and runs remain paused. After reopening the same Pi session, call `{ "action": "recover" }` for interrupted running Runs, or `resume` for a deliberately/gracefully paused Run. Nodes interrupted without terminal attempt evidence are restarted. Tasks must therefore be idempotent or inspect existing work before writing. Synchronous runs return aggregated nested-model usage to Pi; detached async usage remains available in run/node state and its completion notification.

Mailbox records live under `.pi/mesh/messages/`, and growth proposals under `.pi/mesh/growth/`. Children receive a restricted `mesh_control` tool for `status`, `send`, `broadcast`, `reply`, `inbox`, `ack`, and `grow`. `status` returns a bounded topology snapshot without task text or outputs. A `grow` call only writes a proposal; foreground scheduling pauses and returns control to the Host for `growth_list` / `growth_decide`, then resumes automatically after the pending decisions are resolved. Committed growth receipts include the added node IDs, per-node status, and success/failure counts.

## Workflow commands

Place YAML workflows in `~/.pi/agent/mesh/workflows/*.yaml` or, for trusted projects, `.pi/mesh/workflows/*.yaml`. Each filename (or explicit `name`) is registered as a slash command after session startup/reload. Project workflows override global workflows with the same name only while that project is current and trusted; handlers re-discover the workflow at invocation and fail closed after a project/trust switch or file removal. Invalid files are reported independently and do not suppress valid workflows.

```yaml
name: review-and-fix
description: Review a target, fix it, then verify
operator: graph
maxConcurrency: 2
inputs:
  focus: regressions
tasks:
  - id: inspect
    agent: scout
    task: Review {{target}} for {{focus}}
  - id: fix
    agent: worker
    dependsOn: [inspect]
    task: Fix the reported issues in {{target}}
  - id: verify
    agent: qa
    dependsOn: [fix]
    task: Verify {{target}}
```

Run it with simple `key=value` arguments:

```text
/review-and-fix target=src focus=security
```

Missing placeholders fail before creating a Run. Workflows use the existing Mesh validation, Agent discovery, model resolution, retry, timeout, worktree, and recovery paths; they do not execute template expressions or arbitrary code.

Use `stages` instead of `tasks` to compose multiple existing operators. Stage dependencies connect every entry node to the preceding stage's exit nodes, and the compiler emits one ordinary `graph` Run:

```yaml
name: composed-consensus
worktree: true
maxConcurrency: 3
stages:
  - id: candidates
    operator: parallel
    tasks:
      - { id: a, agent: worker, model: provider/model-a, task: "Implement {{target}}" }
      - { id: b, agent: worker, model: provider/model-b, task: "Implement {{target}}" }
  - id: review
    operator: debate
    dependsOn: [candidates]
    tasks:
      - { id: critique, agent: reviewer, integration: true, task: "Compare both handoffs" }
      - { id: rebuttal, agent: analyst, task: "Resolve the critique" }
  - id: final
    operator: supervisor
    dependsOn: [review]
    tasks:
      - { id: vote-a, agent: reviewer, task: "Evaluate candidate A" }
      - { id: vote-b, agent: reviewer, task: "Evaluate candidate B" }
      - { id: integrate, agent: worker, integration: true, task: "Select and integrate the winner" }
```

Stages support `graph`, `sequence`, `parallel`, `supervisor`, `mixture`, `reflection`, and `debate`. `race` remains a whole-Run operator because its first-success cancellation semantics cannot be flattened safely inside a larger graph. Task IDs are namespaced as `<stage>.<task>`. Host built-ins, pi-mesh commands, and names already registered by another extension are rejected instead of being shadowed. YAML tasks use the same strict schema as the `mesh` tool; unknown fields and wrong types such as `integration: "false"` are rejected before command registration.

The package includes `workflows/consensus.yaml`, an 18-node fixed three-model implementation of the same two-round consensus protocol. Copy it into a workflow directory, then provide exact model IDs:

```bash
cp node_modules/@gcoder1991/pi-mesh/workflows/consensus.yaml ~/.pi/agent/mesh/workflows/
```

```text
/consensus-yaml Implement authentication with OAuth, tests, and migration notes
```

`promptInput: task` means the complete text after the slash command is assigned to `{{task}}`, including spaces and punctuation. The bundled workflow keeps model and Agent choices as editable YAML defaults; change `inputs.modelA`, `modelB`, `modelC`, and `finalizer` in the copied file. Workflows without `promptInput` continue to accept `key=value` arguments.
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

Child launches use a `DefaultResourceLoader` with default extension and Skill discovery disabled, then add only explicitly approved Child resources. Mesh AgentSessions receive the restricted `mesh_control` custom tool. They cannot call the Host `mesh` tool recursively. Their ordinary tool allowlist comes from the agent definition.

AgentSession isolation is logical rather than an OS sandbox: Child sessions share the Host process and ModelRuntime but receive separate conversation state, resource loaders, tool scopes, and optional persistent session files.

## Development

```bash
npm install
npm test
```

`PI_MESH_PI_BINARY` remains an internal test transport override. Pi extensions are trusted code with the user's full system permissions; in-process AgentSessions are not a security sandbox. Use only trusted Agent definitions, Child resources, extensions, and environments.
