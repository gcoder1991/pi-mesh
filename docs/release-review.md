# Release review

Fresh post-implementation review focused on correctness, security, recovery, package boundaries, and target compatibility.

## Resolved findings

1. **Project paths hardcoded `.pi`** — replaced with Pi's exported `CONFIG_DIR_NAME` in runtime code.
2. **Managers leaked across session replacements** — Mesh and direct Agent managers are now keyed by Pi session id and torn down on `session_shutdown`.
3. **Persistent child sessions used a per-session directory as the session root** — child `--session-dir` now uses Pi's actual session directory and `--session-id` selects the durable child session.
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
## Residual risks

- No live paid-provider smoke test is possible without provider credentials; real Pi loader/RPC/process behavior is covered with a deterministic OS-process mock.
- The named Mesh operators are tested topology presets over one shared DAG runtime; reflection, debate, mixture, and supervisor are not claimed as independent reasoning engines.
- Decorative target UI details (animated per-tool counters and exact Claude Code row styling) are not reproduced; functional list/view/steer/stop behavior is covered.
- Nested child-owned managers are intentionally replaced by Host-approved Mesh growth with runtime-enforced `allowed_subagents`.

## Security evidence

- Production dependency audit: zero known vulnerabilities (`npm audit --omit=dev --registry=https://registry.npmjs.org`).
- Project resources require Pi trust.
- Child extensions/skills require named allowlists and automatic discovery stays disabled.
- Worktree requests fail closed and preserve changed work through branch/patch/handoff evidence.
