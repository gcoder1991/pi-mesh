# Release review

Fresh post-implementation review focused on correctness, security, recovery, package boundaries, and target compatibility.

## Resolved findings

1. **Project paths hardcoded `.pi`** — replaced with Pi's exported `CONFIG_DIR_NAME` in runtime code.
2. **Managers leaked across session replacements** — Mesh and direct Agent managers are now keyed by Pi session id and torn down on `session_shutdown`.
3. **Persistent Child sessions need durable resume** — in-process sessions now persist through Pi's `SessionManager`, store the exact session file, and reopen it on resume.
4. **Registry writes were rename-only and unbounded** — moved to fsync-backed atomic store with schema, project identity, and record-count validation.
5. **RPC stderr could race `agent_settled`** — settlement waits for the stderr stream turn; the formerly flaky fail-fast test passes repeatedly.
6. **Direct background agents ignored configured concurrency** — added bounded queue, queued status, start events, cancellation, and a real-process concurrency test.
7. **Frontmatter was not authoritative for caller overrides** — agent model, thinking, max turns, context, background, isolated, and worktree settings now take precedence.
8. **Resource settings were checked only at spawn and followed symlinks** — validated eagerly and reject symlink endpoints.
9. **FleetView used non-standard key handling and unsafe widths** — switched to injected keybindings plus `matchesKey`, ANSI-safe wrapping/truncation, and overlay mode guards.
10. **Lifecycle payloads omitted target-compatible duration/token fields** — added bounded duration, real tool-use counts, stopped lifecycle events, and lifetime token summaries.
11. **Mesh control was filtered out by the Child tool allowlist** — Mesh-only children now explicitly activate `mesh_control`, with a real Pi/provider tool-call E2E.
12. **Direct cancellation and registry persistence had races** — terminal generation fencing, session-scoped registries, resolved launch-policy restore, and bounded output artifacts are covered.
13. **Scheduler and cross-extension RPC lost launch/session semantics** — schedule options and absolute next-run timestamps persist; RPC v2 uses the active Pi context and Child UI dialogs fail closed.
14. **Mailbox recipient locks could survive a sender crash forever** — stale recipient locks are reclaimed after 60 seconds without stealing active locks.
15. **Direct and Mesh concurrency caps were independent** — one per-session `FleetLimiter` now bounds Direct, scheduled, and all Mesh AgentSessions together.
16. **Async Mesh runs required polling** — detached runs now deliver deduplicated completion follow-ups.
17. **The status viewer lacked the pi-subagents detail UX** — the unified Direct+Mesh page now has rich status, keybinding-aware scrolling, inline steer composition, and two-press stop confirmation; `/agents` exposes scheduled job cancellation.
18. **Run artifacts and debug logs were unbounded** — terminal Run retention and debug log rotation now have bounded defaults.
19. **Host and Child task schemas could drift** — both use one shared `MeshTaskSchema`.
20. **Custom providers disappeared in isolated Child processes** — Child execution now uses in-process `AgentSession`s with the Host `modelRuntime`; model precedence remains task/Agent pin over Host current model.
## Residual risks

- A live CPA smoke test passed with `cpa/gpt-5.6-sol`; deterministic tests also register a provider only in the Host runtime to prove that Child AgentSessions reuse it.
- The named Mesh operators are tested topology presets over one shared DAG runtime; reflection, debate, mixture, and supervisor are not claimed as independent reasoning engines.
- The unified status page adapts the useful MIT-licensed pi-subagents conversation-viewer behavior, but intentionally does not reproduce every decorative token/context animation.
- Nested child-owned managers are intentionally replaced by Host-approved Mesh growth with runtime-enforced `allowed_subagents`.

## Security evidence

- Production dependency audit: zero known vulnerabilities (`npm audit --omit=dev --registry=https://registry.npmjs.org`).
- Project resources require Pi trust.
- Child extensions/skills require named allowlists and automatic discovery stays disabled.
- Worktree requests fail closed and preserve changed work through branch/patch/handoff evidence.
- Pi extensions are trusted code with full user permissions; cross-extension RPC explicitly uses a trusted-extension event-bus model rather than claiming an in-process sandbox.
- Child AgentSessions share the Host process and ModelRuntime, so isolation is logical rather than an OS sandbox; only trusted Agents/resources/environments are supported.
