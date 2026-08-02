# pi-subagents replacement contract

pi-mesh replaces the core Host tool surface while retaining Host-owned topology and approval; it is an architectural replacement, not a strict behavioral superset of every single-Agent detail.

## Compatibility surfaces

- Native `mesh` DAG tool remains authoritative.
- Compatibility tools: `Agent`, `get_subagent_result`, `steer_subagent`.
- Persistent child sessions support steer, resume, transcripts, thinking levels, max-turn wrap-up, and context inheritance.
- Async completion delivers a deduplicated follow-up notification to the parent.
- Agent definitions support the commonly used pi-subagents frontmatter and filename-as-name.
- `/agents` provides agent/status/settings management and a compact live widget/viewer.
- Session-scoped schedules, bounded memory, lifecycle events, and cross-extension RPC are included.

## Child resource policy

Extensions/MCP and skills are supported, but never inherited implicitly.

Global or trusted-project mesh settings declare named paths:

```yaml
childExtensions:
  mcp: /absolute/path/to/mcp-extension.ts
childSkills:
  web-search: /absolute/path/to/web-search/SKILL.md
```

An agent opts in by name:

```yaml
extensions: mcp
skills: web-search
```

Unknown names fail closed. Project maps are ignored until Pi trusts the project. pi-mesh itself and other agent-management extensions cannot be admitted to a child allowlist. Child tools are still restricted by `tools` and `disallowed_tools`.

## Deliberate differences

- Child delegation remains Host-approved growth rather than an independent recursive scheduler; `allowed_subagents` limits which Agent types a Child may propose.
- Worktree preservation continues to produce final commit, binary patch, and handoff manifest.
- Run lease, attempt fencing, bounded state, and recovery evidence remain mandatory.
