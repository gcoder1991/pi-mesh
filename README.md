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
mailboxNotifications: false
debug: false
retentionDays: 30
maxTerminalRuns: 100
debugMaxBytes: 4194304
```

`maxAgentDepth` limits the longest dependency chain, including approved growth. `maxConcurrentAgents` is one shared per-Pi-session cap across Direct Agents, scheduled Agents, Mesh runs, and Mesh nodes; each Run's `maxConcurrency` is an additional per-run cap. `maxNodes` caps a Mesh. `defaultNodeTimeoutMs` defaults each attempt to 30 minutes unless the task supplies `timeoutMs`; at 80% the child is told to stop repeating the same strategy and wrap up before hard cancellation. Mailbox settings cap each message and each recipient's unacknowledged content. `childExtensions` and `childSkills` map trusted logical names to explicit resource paths. Child AgentSessions share the Host ModelRuntime, so extension-registered providers and authentication are inherited automatically. A Child without an explicit model inherits the Host's active model; task/Agent model pins remain authoritative. `joinMode` is `smart`, `async`, or `group`. `retentionDays` and `maxTerminalRuns` bound terminal Run state, and `debugMaxBytes` rotates `debug.jsonl` to `debug.jsonl.1`. Host calls refresh current trust, discovery and resource settings on the same project/session Manager. Use `/reload` for a clean lifecycle restart after configuration changes.

## Tools

The extension registers native `mesh` plus compatibility tools `Agent`, `get_subagent_result`, and `steer_subagent`. Direct Agent supports foreground/background execution, bounded queueing, steer/resume, opt-in persistent sessions, transcripts, context inheritance, explicit Child extension/skill allowlists, memory, schedules, and strict Worktree isolation. Direct registries are isolated per Pi session and large results keep a bounded preview plus a full artifact. While agents run, a below-editor main panel shows `main` plus Direct Agents and Mesh nodes with live elapsed time, turns, tool count/activity, and tokens. At an empty prompt press `↓` or `←`, navigate with `↑`/`↓`, and press `Enter` for the live status/conversation page. The page supports `j/k`, arrows, PageUp/PageDown, Home/End, inline `Enter` steering, and two-press `x` stop confirmation. Use `/agents` or `ctrl+shift+a` for management; `/agents` also lists and cancels scheduled jobs.

Run `/mesh-tree` or press `ctrl+shift+m` to open the native live Mesh inspector modeled on `pi-subagents`' `/subagents-fleet`. The dependency-shaped node roster stays on the left; the selected node's task, status, model, elapsed time, tokens, tools, conversation, and artifacts appear on the right. Use `↑`/`↓` or `j`/`k` to select nodes, `Shift+K`/`Shift+J` or `PgUp`/`PgDn` to scroll detail, `r` to refresh, and `Esc` to close. Active Runs remain visible, and completed Runs linger for 20 seconds.

See `docs/parity-matrix.md`, `docs/replacement-delta.md`, and `docs/release-review.md` for the final replacement audit.

### Multi-model consensus

Use `/consensus <task>` for independent implementations followed by two critique/revision rounds, normalized ledgers, majority voting, and one canonical integration result. The command reads `ctx.modelRegistry.getAvailable()`, so it sees the same authenticated/custom provider catalog as `/model`, then asks once for the participant count, exact model set, and Finalizer model through `ask_user_question`. If that tool is unavailable, it asks the same choices in a normal response and waits.

The default recommendation is three distinct models (18 Mesh nodes); five models create 28 nodes and cost more. The generated run uses `operator: "graph"`, `worktree: true`, `failFast: true`, explicit task models, stable node IDs, and a background Mesh call. The Host ends its current turn after the run receipt and is awakened by the completion notification. A strict majority selects the baseline when available; ties use the chosen Finalizer and are reported as `FINALIZER_TIEBREAK`. Minority opinions remain in the final audit object but only one canonical result is returned.

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

Mesh runs are background by default. Do not sleep or poll after the run receipt. If the Mesh result is all the Host is waiting for, it should end the current turn; otherwise it may continue independent work. Completion sends a deduplicated follow-up that triggers a new turn when the Host is idle. Set `"async": false` only when blocking is explicitly required.

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

Set `worktree: true` to require explicit current Host project trust and a clean Git checkout and run every node in its own detached temporary worktree. Changed work is committed and archived to a retained `pi-mesh/<run>/<node>-<attempt>` branch pointing at final HEAD; the main checkout stays untouched. Each attempt records `attempt-result.json` with exit code, signal, bounded stderr, usage, model, timestamps, and output reference. Writer attempts also record a binary patch and `handoff.json` under `.pi/mesh/artifacts/<run>/<node>/`. `worktreeSetupHook` may name an explicitly selected executable setup script in that trusted repository. Internal Git commands disable hooks and fsmonitor; diff capture disables external diff and textconv. This is **not a Git sandbox**: other executable configuration, including clean/smudge filters, may still run in a trusted repository. Without Host trust, automatic Worktree/setupHook entry is rejected; trust the project explicitly or choose a new non-worktree Agent. Standalone Worktree helpers assume their caller has already authorized Git; this guarantee does not restrict a model’s separately authorized bash commands. If preservation fails, the worktree is left in place and the node fails with its path. Capture of the commit, retained branch, full patch and handoff happens **before** node success and successful attempt evidence; capture failure blocks dependents. A valid handoff with only directory-removal failure remains successful with a cleanup warning. Output/checkpoint failures, lease loss and shutdown retain working-copy or captured evidence rather than silently deleting the only copy. Use `handoff_list` for integration commands.

Automatic retry, `retry_failed` and restart recovery first use the node's own saved commit (validated against its owned branch), before a dependency baseline. An unpreserved or changed saved branch is an actionable refusal, not a silent reset. Multiple writer dependencies still require `integration: true`. `baseCommit` is the checkout base of this attempt; `handoffBaseCommit` is the stable first/dependency baseline. The final patch covers **all** attempts, including earlier failed attempts and retries that make no new changes. Integrate with the supplied `git cherry-pick <handoffBaseCommit>..<finalCommit>` range (or the full patch), not just the last commit. Review the range before applying it; the current attempt's cwd may differ from earlier absolute paths.

### Background run

Background is the default; `"async": true` is optional:

```json
{ "action": "run", "tasks": [{ "agent": "worker", "task": "Run the long check" }] }
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
Run checkpoints are stored under `.pi/mesh/runs/` and carry the originating Pi session ID; other sessions neither list nor recover them. Every attempt writes machine-readable `attempt-result.json` and human-readable `diagnostic.md` under `.pi/mesh/artifacts/<run>/<node>/attempt-<n>/`; failed-node status output links to both files. Use `retry_failed` after a partial failure or operator cancellation: successful nodes stay terminal, while unsuccessful nodes resume their persisted Agent session; if that session is unavailable, the replacement receives the prior error, output path, and bounded output tail so it continues instead of restarting blindly. On session shutdown, active children are terminated, worktrees are finalized, leases are released, and runs remain paused. After reopening the same Pi session, call `{ "action": "recover" }` for interrupted running Runs, or `resume` for a deliberately/gracefully paused Run. Nodes interrupted without terminal attempt evidence are restarted. Tasks must therefore be idempotent or inspect existing work before writing. Each attempt retains its own usage, while node/run totals accumulate across retries. Foreground results and the first background status claim report only previously unreported usage; repeated queries do not bill it again. Completion notifications never claim usage or impersonate the SDK billing API.

Mailbox records live under `.pi/mesh/messages/`, and growth proposals under `.pi/mesh/growth/`. Children receive a restricted `mesh_control` tool for `status`, `send`, `broadcast`, `reply`, `inbox`, `ack`, and `grow`. `status` returns a bounded topology snapshot without task text or outputs. A `grow` call only writes a proposal; foreground scheduling pauses and returns control to the Host for `growth_list` / `growth_decide`, then resumes automatically after the pending decisions are resolved **only if no manual pause is also in force**. A stale pending requester never prevents denial; approval revalidates the current requester attempt, Host authorization and graph under the Manager lease. Committed growth receipts include the added node IDs, per-node status, and success/failure counts.

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

### Direct Agent lifecycle and contact

Direct children use a project- and Host-session-specific root:
`.pi/mesh/sessions/direct/<host-session-hash>/<agent-id>/`. The SDK's early
`sessionFile` is recorded before its first JSONL flush. Resume requires the actual
original, valid file; a missing file is never replaced by an empty session.
Legacy external/unprovable references are retained with recovery diagnostics, not
read or migrated from the Host's sessions. Keep these records and original files
when recovering work. At 1024 records, new launches are refused: preserve the
recovery evidence and use a new Host session rather than silently evicting records.

Queued and running executions share the Host Fleet limit with Mesh. Waiting is
cancellable; a queued foreground `Agent` waits for its own stable completion.
Direct Manager shutdown cancels every admitted record and waits for completion and
execution close even if an abort checkpoint fails. Its resolved promise confirms
drain, **not checkpoint durability**: storage errors retain their record ID and
original cause in Manager `diagnostics`, and the Host emits `subagents:diagnostic`
before discarding that Manager. Final record status does not erase this diagnostic.
A rejected drain is reported and retains the Manager's Fleet ownership rather
than assuming it is safe to release. Shutdown/disposal is idempotent.

Slots are released only after execution close. Each Manager retains its session
Fleet pool even while idle; Host shutdown/new/switch releases only its drained
Managers' ownership, not another same-PID Host's pool (including a shared session
ID). The registry entry retires only after the last owner drains.
Continuations of an ID are
single-flight and wait for the previous execution to drain. `stopReason` and
`partial` distinguish max-turn wrap-up, timeout, cancellation and errors from a
complete answer. Partial output remains readable; large output keeps its full
artifact and a bounded 50 KiB / 2000-line display (including verbose views).

`Agent` resume retains the flat schema: provide `resume`, `prompt`, `description`
and `subagent_type`, without spawn-only settings. `steer_subagent` remains strictly
for running Agents. User/UI and tool-signal cancellations block automatic resume.
Only an explicit user command authorizes continuation:

```text
/agents resume <agent-id> <new instruction>
```

The opt-in, Host-only `send_subagent` tool contacts an **existing** Direct ID; it
never creates a replacement ID or crosses Host sessions. Enable it explicitly in
trusted project `.pi/mesh/settings.yaml` (or global mesh settings):

```yaml
directCommunication: true # default: false
```

```json
{"agent_id":"<existing-id>","message":"Focus on the failing check","expected_generation":1,"message_id":"direction-1"}
```

A queued/not-yet-ready child stores a direction; a running child is steered; a
settling child is rechecked after close. A legal persistent, non-worktree terminal
child can request a continuation. User/unknown cancellation is **never** unlocked
by this tool, message text, or a peer-supplied authorization claim. Receipts such
as `queued`, `steered` and `continuation_requested` mean acceptance, not completion;
use `get_subagent_result` to check. Directions are at most 32 KiB, with 16 queued
or close-waiting directions and 128 receipt entries per ID. Replays are deduplicated
within a generation; `expected_generation` rejects stale targets.

Foreground executions return their newly consumed usage and do not also trigger
a follow-up notification. Background/RPC/scheduled generations notify once. The
first result query can claim previously unreported child usage; repeated queries
return cumulative totals in details without charging that usage again. A query
does not itself make a model call. Notifications do not pretend to update the SDK
usage ledger. Schedules restore at `session_start`, including no-UI modes; fire
rechecks current trust and allowlists. Missed one-shot jobs are not replayed.


### Mesh lifecycle, evidence and optional mailbox hints

Pause is a drain, not an immediate termination: active attempts may finish and
inspect `mesh_control status`, `inbox` and `ack`, but may not `send`, `reply`,
`broadcast` or `grow` while paused. Fleet waiters drain without starting children.
`resume` waits for the old loop **and execution close** and coalesces concurrent
requests. Cancel on a drained run converges immediately; recovery also converges
`cancelling` even when no interrupted node remains. Shutdown closes intake first,
drains actual executions (including paused runs), then marks interrupted nodes
paused and retains worktree evidence. Quota and leases are never released merely
because an abort signal fired.

Checkpoints are guarded by both the owner token and the known disk revision.
Stale Managers cannot cancel, grow or overwrite a live owner. Lost ownership
aborts/drains local work without publishing its stale attempt artifacts; wait
for drain, then explicitly call `recover` to reload current disk state. Recovery
does not replace locally executing Run objects. Initial checkpoint failure starts
no child. Storage failures require repair before retry/recovery; inspect the
reported worktree, attempt, session and output paths first.

New Mesh sessions live under
`.pi/mesh/sessions/mesh/<run-id>/<node-id>/`. `onReady` records the actual SDK
session path before its first JSONL flush; no header is fabricated. A missing
original file starts an explicitly described **new execution with repair
context**, never a pretend restored session; an unsafe/corrupt existing file is
rejected. Runtime full output artifacts remain intact; node displays and combined
dependency evidence are bounded to 50 KiB / 2000 lines. The composed task/repair/
dependency prompt reserves 32/8/20 KiB slices within Runtime's 64 KiB task budget,
with the full task retained in the checkpoint. `partial`, `maxTurns`, timeout and
errors never count as dependency success. Timeout calls `abort("timeout")`.

Mailbox remains durable storage by default. Enable optional Host-local hints:

```yaml
mailboxNotifications: true # default: false
```

Both Host send/broadcast and in-process child `mesh_control` reuse the same
`onMessageStored` callback into `MeshManager.notifyMessageStored(message)`.
Hints coalesce by recipient attempt within a microtask and stop after eight
short hints per attempt. Only the still-running, matching execution is steered;
queued, paused, closing, cancelled and terminal recipients only retain mail.
These local callbacks do not resume, spawn, acknowledge automatically, or implement
a transport. A notification failure cannot turn a stored receipt into an unsent
message. They are not transported over the legacy RPC test hook. The separately
authorized Host bridge below deliberately does not use the general notification
callback for passive mail.

Inbox preserves old unacknowledged mail across node attempts. Inspect `from`,
`source`, `senderAttempt`, `createdAt` and `replyTo`; Host-relayed display labels
are `displayFrom`, **not child identity or authorization**. Broadcast returns
per-recipient `outcome`/`stored` receipts and an explicit `partial` result. Outcomes
are `stored` (durable write returned), `stored-visible` (exact payload verified but
durability/cleanup warning), `not-stored`, or `unknown`. Only `not-stored` is safe
to resend. A `stored-visible` ID must not be retried with a new ID; inspect its
`durabilityWarning`. For `unknown`, inspect the existing ID in the spool before
resending. `notificationError` is independent of storage. `stored: false` alone
is **not** safe-retry advice: it also covers unknown visibility.
`ack` means mailbox consumption, not acceptance or completion of a business task.

Background completion notices deduplicate by Run execution epoch and attempt
set; a paused drain is not completion, and foreground results do not send a
second follow-up. Mesh operators remain finite topology presets (bounded
reflection/debate chains and final fan-in), not permanently online collaborators.


### Review follow-up: retry authority and storage uncertainty

`retry_failed` waits for the old epoch's completion, child close and loop finally,
then rechecks owner, revision, trust, status and cancellation version. Concurrent
requests single-flight. Successful nodes never reopen. Fleet UI stops are `user`,
Host model `cancel` is `operator`, and tool-signal/unknown aborts are `unknown`.
Internal failfast/race, timeout and shutdown retain their actual causes. User and
unknown stops persist an automatic-continuation lock. Old cancelled checkpoints
without provenance are conservative, not implicit authorization. A node-local
stop also protects its dependents without preventing unrelated failed nodes'
legal retries. Model arguments, mailbox contents and peers cannot unlock stops.
The actual user command (also available without a dialog UI) is:

```text
/mesh retry <existing-run-id>
```

It authorizes one drained retry, not future cancellations. A new cancellation
while waiting invalidates the earlier authorization. Never create another ID to
bypass a stop.

Atomic writes now report visibility separately from durability. Mesh checkpoints
compensate a failed post-rename write only under the original lease and after
verifying the exact written payload. Direct and scheduler checkpoints also use
exact-payload compensation. The original fsync/open/close/cleanup error remains
an error, not a swallowed warning. One-shot faults restore usage claim markers
on disk as well as in memory; final delivery failure repairs the staged receipt
and retains the worktree. If compensation cannot be completed, diagnostics
explicitly report uncertainty: preserve checkpoints, attempt receipts and working
copies for manual reconciliation. This is not a multi-file transaction and cannot
guarantee rollback or billing exactly-once across permanent media failure or a
crash between durable claim and caller receipt.

Recovery validates each checkpoint independently (regular file <=16 MiB, bounded
nodes/fields, identities, statuses, graph/dependencies and finite nonnegative
usage). Invalid JSON or shapes retain the original file and any prior safe
in-memory reference, with path-specific diagnostics in Manager/Host recovery
output. They do not execute or hide other valid records. Attempt receipts are
bounded to 1 MiB. Valid actual attempt usage is accounted independently of receipt
delivery status or confirmation, and the accounting marker is checkpointed before
another claim/attempt. A missing/future `committedRevision` cannot recover success;
legacy evidence is retained, not fabricated as confirmed delivery.


### Second review: bounded recoverable state and joining callers

Every caller joining a retry flight retains its own cancellation signal, including
an already-aborted signal. It shares the same execution Promise, does not upgrade
the flight's authorization, and revokes pending authorization through the
persisted unknown-stop/version mechanism. Listeners are removed on settlement.
Recovery also leaves pending local retry/resume objects canonical during the
old-loop completion reaction window.

Host/child send receipts no longer duplicate the full message body per recipient.
All recipient IDs, outcomes and safe-retry distinctions remain available for
32 KiB broadcasts. If warning strings themselves overflow the response budget,
`warningsTruncated` marks compact warning summaries; the bounded core receipts
remain, including every ID/outcome. Only `not-stored` permits a safe resend.
The lower-level `storeMessages` still returns verified stored messages for callers
that need them; tools use `messageReceiptDetails` instead.

Admission and growth now budget the **actual serialized checkpoint bytes**, not
raw task lengths: JSON escaping and indentation count. The 16 MiB reader/writer
ceiling is unchanged. Admission reserves 96 KiB per node plus 2 MiB of run
headroom for runtime evidence/paths; legal individual 64 KiB tasks can therefore
be refused in combination before topology commit or child execution. Reduce the
number or size of tasks instead of producing an unrecoverable checkpoint.

When inline node evidence exceeds 32 KiB (or history exceeds 1024 entries), full
output/error/activity/worktree history is first saved in an immutable
`artifacts/<run>/<node>/attempt-<n>/evidence-<sha256>.json` snapshot. The node's
`evidencePath` locates it; `previous` links preserve earlier snapshots/history.
Only then are inline previews shortened and the latest history entry retained.
Full runtime output, diagnostics, binary patches and handoffs are not truncated
or deleted. `status`, child growth receipts, retry/dependency prompts and
`handoff_list` expose the references (large displays may point to the checkpoint).
Attempt error previews are bounded before writing the <=1 MiB recovery receipt.
Every Manager checkpoint is shape-validated and byte-checked before writing.
Snapshots are evidence, not a new database or automatic authorization source;
recovery does not follow arbitrary evidence paths. Persistent media failures can
still prevent evidence/checkpoint delivery and require explicit repair.

### Default-off Host bridge (Cross RPC v1)

This is a **thin adapter**, not a new communication system. Cross owns authenticated
Host-to-Host Unix IPC and its `info`/`send`/`received` EventBus RPC. Mesh owns the
existing Managers, Fleet, spool and execution fences. Ordinary Host↔Direct and
same-run `mesh_control` tools retain their own semantics. No Cross source import,
extra dependency, Manager reconstruction, daemon, database, scheduler, outbox,
automatic relay, automatic retry, or automatic acknowledgement is introduced.

#### User configuration and deployment

Both Hosts need the frozen Cross RPC/received contract and this Mesh extension.
Start Cross explicitly with **`--cross-session-rpc=true`**; Mesh separately defaults
to `bridge.enabled: false`. Trust the actual current project through Pi's user
trust surface. A managed child with the runtime's synchronous frozen identity
cannot become a bridge. The runtime installs identity on its public child-local EventBus before any
approved path factory executes (including aliases of Mesh), not just in a later
inline factory. The identity check is child-local, not a process-global
flag; another Host in the same PID is not suppressed.

Only **`getAgentDir()/mesh/settings.yaml`** authorizes the bridge. The entire
`bridge` key in project settings is ignored, **even for trusted projects**. Tools,
peer content, `from` labels and payload booleans cannot change this authorization.
Current trust, user settings, session/root and Cross incarnation are rechecked at
intake and immediately before actions. Editing this user file takes effect on the
next action/receipt without `/reload`; **do not reload to replenish budgets**.

First obtain existing full IDs from Mesh status / `get_subagent_result`, and each
Host's actual session ID and exact Cross 32-lowercase-hex instance ID from local
status. Then configure both directions. Example (replace every illustrative ID,
root, session, attempt and generation; nothing is auto-resolved):

```yaml
bridge:
  enabled: true
  routes:
    - routeId: from-B
      peerInstanceId: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      remoteRoute: from-A
      localTarget:
        kind: mesh
        root: /absolute/canonical/project-A
        sessionId: exact-host-A-session-id
        runId: exact-existing-run-id
        nodeId: exact-node-id
        attempt: 1
      remoteTarget:
        kind: direct
        root: /absolute/canonical/project-B
        sessionId: exact-host-B-session-id
        id: exact-existing-direct-id
        generation: 1
      mode: store # default; only an explicit active mapping may request a hint
```

Host B needs a reciprocal route `from-A`, with A's exact instance ID,
`remoteRoute: from-B`, and swapped targets. Both routes can share the same user
file; a Host cannot use a route whose local target belongs to another root/session.

Frozen configuration schema:
- `bridge`: only `enabled?: boolean` (default false), `routes?: array` (default []).
- At most **16** routes; unique `routeId`. `routeId`/`remoteRoute` match
  `[A-Za-z0-9_-]{1,64}`; `peerInstanceId` is exact lowercase 32hex.
- `localTarget` and `remoteTarget` are required. The latter carries an explicit
  remote generation fence; changing the receiver's mapping cannot silently bind
  an already-sent message to a different attempt.
- Each target has `root` (canonical absolute path, ≤4096 chars), `sessionId`
  (nonempty, ≤512 chars), and either `{kind: mesh, runId, nodeId, attempt}` or
  `{kind: direct, id, generation}`. IDs are safe exact identifiers ≤128 chars;
  node IDs ≤64. Attempts are nonnegative safe integers; Direct generations ≥1.
- `mode?: store | active` defaults to store. Unknown user configuration/target
  fields are rejected. No names, short refs, wildcard/latest lookup or restart
  rebinding. No creation of runs/nodes/Agents, retry/resume/growth, clearing stops,
  or automatic Cross reload occurs.

#### Host tool actions and evidence

All bridge actions use the existing **`mesh`** tool name (not a new spawn/relay
name that bypasses Cross's known-sensitive tool gate):

```text
mesh(action="bridge_status")
mesh(action="bridge_send", routeId="from-B", content="Host-transcribed data")
mesh(action="bridge_inbox")
mesh(action="bridge_inbox", messageId="in-<qualified-sha256>")
mesh(action="bridge_ack", messageId="in-<qualified-sha256>")
mesh(action="bridge_send", routeId="from-B", forwardInboxId="in-<qualified-sha256>")
```

`bridge_status`/`bridge_inbox`/`bridge_ack` remain usable by the current trusted
Host when the adapter is disabled or Core RPC is unavailable. They do not require
live targets and never consume child usage. Cross may conservatively gate these
new actions in peer-only/unknown/cancelled turns; no permissions are widened here.
The inbox lists reservation and independent failure-attempt IDs. Selecting a base
ID returns its owned reservation/outcome and owned associated failure history.
`bridge_status.failureCount` also exposes failures without a reservation. Status
keeps local identity, counts, budgets and diagnostics within the tool budget;
large route configurations use explicitly marked summaries (not truncated full
targets), referencing `getAgentDir()/mesh/settings.yaml` by exact route ID. Large selected content stays on disk with an `evidencePath`
reference rather than erasing core IDs from the receipt. Ack retains the record.

Payload schema is exactly `{version:1, route, target, content,
claim:"host-transcribed-not-user"}`. Cross's reserved prefix and BridgeEnvelope
stay unchanged. A new send uses the **actual Host incarnation** as `origin`, a
fresh `correlationId`, 30s expiry, hops=0 and budget=4. Forwarding accepts only an
owned existing incoming spool ID: it reads the original body/origin/correlation/
expiry, increments hops and decrements budget. Supplying replacement content on a
forward, an empty forward ID, or a caller-supplied `messageId` on send is rejected. These transcribed origin fields are **not** authentication
of a child or user; the authenticated source is the immediate Cross relay Host.

Limits are intentionally conservative: body ≤32KiB UTF-8 and well-formed Unicode,
complete serialized wire text ≤48KiB (JSON escaping counts), canonical evidence
content ≤64KiB (outer JSON quoting adds overhead; canonical spool files <132KiB).
The existing Mesh target mailbox still applies its configured payload/unread
limits. TTL ≤30s, hops ≤4, and remaining envelope budget ≥1 are hard gates.
The adapter has **256 total attempts / 64 per exact target** for its lifetime,
shared between incoming and outgoing. Persistent reservations independently cap
new admissions at 256/user-agent-directory and 64/target across ack/restart/config changes;
failed unstored attempts still consume the live adapter budget. Active admission
reservations are capped at **8 notification opportunities per target/attempt or
generation**, including inactive opportunities; restart does not replenish them.
No settled event or enable toggle refills budgets. This bounded passive evidence
has no automatic retention deletion/reset; reaching the ceiling requires explicit
operator review, not clearing the only evidence to resume an automatic loop.

Incoming processing requires the frozen authenticated event, exact current local
identity, fixed peer/route/target, valid schema/TTL/budgets and a **successful first
synchronous `reply({handled:true})`**. Validation rejection does not claim;
`canHandle=false`, late or duplicate claims never process. Diagnostics are bounded
and local. Missing Core info fails synchronously; send RPC subscribes before emit,
has an absolute ≤5s wait, aborts/unsubscribes on shutdown, and never retries.

Evidence reuses the spool layout under the user agent directory:
**`getAgentDir()/.pi/mesh/messages/host-bridge/`**,
not an invented run or outbound delivery queue. Incoming IDs are
`in-` + SHA256(`authenticatedSourceInstanceId + ":" + messageId`), independent of
receiver incarnation, project root, mapping, target, ack and generation.
This is deliberately conservative across all Hosts sharing that user agent
directory: the same authenticated incoming ID is never executed twice there,
even after an explicit change of Host session/project. Ordinary new sends have
distinct Cross message IDs. Incoming and outgoing reservations from those Hosts
share the persistent ceiling; they do not replenish one another. `putMessage`'s new
optional `ifAbsent` and the persistent 256/64 admission recheck share the same
recipient lock for incoming and outgoing reservations; duplicates consume no
additional quota. The lock is never stolen by age (a paused process may still
own it), and release verifies the open file identity. Busy/stale/unknown locks
fail closed with their path. For orphan-lock repair, first stop **all** writers
sharing that spool, inspect retained records, then explicitly remove only the
orphan lock before restarting. Never delete evidence or reclaim a live lock. Its `duplicate` receipt never asserts original durability. This suppresses
re-execution after ack/restart/mapping changes; the authenticated relay remains
part of identity. Cross also has its separate incarnation dedup and 256 budget.

Canonical reservation stores authenticated source, original envelope, fixed local
target and route. Only a durable `stored` reservation proceeds to a Mesh mailbox
copy; Direct store mode stays in the passive Host inbox. Separate
`<inboxId>-outcome` evidence reports canonical storage, target mailbox storage and
notification separately. Only a verified reservation owner writes that fixed
outcome. A `not-stored` or `unknown` admission instead records a unique
`failure-<UUID>` with its actual local identity, base inbox ID, original envelope
and admission result. These passive failure files use the existing spool with
a separate recipient lock and a durable 256-total/64-target cap (independent
of the unchanged reservation cap). These are **retained-file capacities**:
ack/restart/toggle do not remove files or refill that capacity. The live attempt
budget is in memory, not a permanent count of every failed attempt. After a
restart another failed canonical write can be attempted even when failure storage
is full; it cannot add a 65th retained failure for that target. No unlimited
restart-proof accounting of all failures is promised.
At most 256 canonical outcomes plus 256 reservations plus 256 failures are
created; failure evidence has the same 64KiB content bound. All inbox IDs stay
discoverable within the tool budget (metadata is omitted when needed). If even
failure storage is unavailable/full, bounded diagnostics retain its attempted
base ID, attempted failure ID, both storage outcomes and bounded UTF-8 error
previews; no storage or retry safety is fabricated. A native read failure after
synchronous claim but before canonical admission can leave passive failure
evidence only after fresh current authorization and budget checks succeed.
Revoked trust, cancellation, session/incarnation or route changes do not grant
permission to write such evidence. Cleanup faults cannot erase a confirmed
write/rename or duplicate; a concurrent ACK is retained, never overwritten.
`stored`, `stored-visible`, `not-stored`, `unknown` are
not interchangeable; unknown is **not safe retry**. A crash between files can
leave a reservation without a target copy/outcome, intentionally preventing
replay rather than claiming cross-file exactly-once. Inspect original IDs; there
is no automatic crash repair. Unique evidence is never silently deleted. Existing
`messageReceiptDetails` still preserves ordinary mailbox core IDs/outcomes while
compressing oversized warnings.

**Cross `accepted` means claim only**, not spool storage, model processing or
business success. Sender `out-<messageId>` reservations/outcomes are passive local
evidence, not an outbox; a send returns only Cross's receipt and local write
outcomes. It does not know remote storage unless the user inspects that Host's
inbox/evidence. Unknown receipts must not be retried with replacement IDs or reset
origin/budget. There is no automatic model response or ACK protocol.

Store mode never calls `notifyMessageStored`, even with general
`mailboxNotifications: true`. Active Mesh uses an ownership/attempt/cancel fence
and a short mailbox hint; Direct uses exact current running/ready generation and
transcribed data, **never `Direct.send` or terminal continuation**. Runtime's
new internal `steerActive` refuses pre-ready/future prompts, closed, cancelled or
nonstreaming SDK executions. A requested/submitted hint is not processing success.
The adapter never calls Host `pi.sendMessage` (including `triggerTurn:false`), so
claimed busy-Host bridge data cannot queue an extra Host turn. Passive spool and
explicit inspection are the display surface.

#### Verification scope

Ordinary `npm test` includes permanent component/security/generation/I/O bridge
checks and remains sibling-independent. The separate required-source integration
is **not** silently skipped or counted in ordinary `npm test`:

```sh
# Run under the private HOME/agentDir/TMP/network guard wrapper.
npm run test:bridge -- --cross-source /absolute/path/to/frozen/pi-cross-session
```

It privately copies and SHA256-records the actual Cross extension/contract, links
only already-installed same-family SDK dependencies, and exercises two real SDK
Hosts, actual Cross Unix IPC and full Mesh extension/Managers/spool. Active
Direct hints reach actual provider context in the same generation; active Mesh
hints cause an actual `mesh_control inbox` tool call and the returned mailbox
content reaches the provider in the same attempt. Additional Direct scenarios
exercise preflight rejection, default retry backoff/agent_end drain cancellation,
and close-gated continuation without leaking an old hint into the new generation.
Public `AgentSessionRuntime.newSession/switchSession` exercise pending native
Cross discovery, unknown receipts and old/new observer/ownership scopes. Providers are deterministic/local,
not live model services; there are no simulated children in that test. The harness
calls registered tool definitions to arrange/send fixture work (it does not claim
an end-to-end SDK tool-selection/permission test from those calls). Busy Host
prompt/abort/history/provider calls are actual SDK operations, not sendMessage
stubs. Permanent ordinary tests separately exercise two OS processes with native
ifAbsent/check-write barriers, SIGSTOP/CONT and pre/post-rename I/O faults.
Full multi-OS deployment and production TUI/Escape,
hostile same-UID processes and permanent media loss are outside this integration.
Pure-version runs require the complete SDK family to resolve consistently; a
mismatched installed tree deliberately fails this script rather than claiming a
pure SDK version. See the bridge HANDOFF/log matrix for exact executed scope.
