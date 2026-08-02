# Replacement target audit: `@tintinweb/pi-subagents`

Audited against `/Users/relvf/Code/pi-subagents/README.md` and its current source.

## Compatible public surface

- Tools: `Agent`, `get_subagent_result`, `steer_subagent`
- `/agents` management command and `ctrl+shift+a` FleetView shortcut
- Foreground/background execution, bounded queue, wait, verbose conversation, steer, resume, graceful turn limits
- Case-insensitive agent lookup, fuzzy model resolution, prompt replace/append, context inheritance
- Explicit Child extension/MCP and skill allowlists, tool allow/deny lists, isolated specialists
- Persistent session, transcript, memory, direct worktree isolation
- Completion notifications, join modes, lifecycle events, cross-extension event RPC
- Session-scoped cron/interval/one-shot schedules

## Intentional architectural differences

1. **Nested delegation is Host-approved growth.** `allowed_subagents` is parsed as a routing/privilege declaration, but a Child does not receive a hidden child-owned scheduler. It submits `mesh_control grow`; the Host owns topology, depth, approval, mailbox, fencing, recovery, and accounting.
2. **Resources are fail-closed explicit allowlists.** `extensions: true`, wildcard discovery, arbitrary absolute paths, and implicit skill inheritance are rejected. Trusted mesh settings map logical names to concrete resources.
3. **Unknown agent types fail closed.** There is no permissive general-purpose fallback that could silently grant broader tools.
4. **Mesh adds durable DAG semantics absent from the target.** Native graph operators, retries, attempt evidence, leases, crash recovery, mailbox/growth fencing, dependency evidence, and multi-writer handoffs remain first-class.
5. **UI is intentionally smaller.** FleetView provides a live list, keyboard navigation, conversation overlay, steering, stopping, and completion linger, but does not reproduce every decorative token/tool animation.

These differences are security/control-plane choices, not missing execution capabilities.
