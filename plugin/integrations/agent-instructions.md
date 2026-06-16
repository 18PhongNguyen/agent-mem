# claude-mem: Agent Instruction Templates

Copy the relevant snippet into each agent's system prompt file.
Replace `{platform}` with your agent name and `{project-name}` with your project identifier.

---

## Claude Code → `CLAUDE.md`

```markdown
## Shared Memory (claude-mem)

After completing any significant decision, bugfix, or discovery, call the `memory_save` MCP tool:

- `platformSource`: "claude-code"
- `agentId`: "claude-code/main"
- `projectName`: "{project-name}"  (e.g. "my-org/my-repo")
- `rootPath`: the absolute path to this project root
- `type`: decision | bugfix | discovery | refactor | feature | change
- `title`: one-line summary
- `text`: explanation of what was decided, found, or fixed

Other agents (Cursor, Codex, Gemini…) will see this memory in their next session.
```

---

## Codex → `AGENTS.md`

```markdown
## Shared Memory (claude-mem)

After completing any significant decision, bugfix, or discovery, call the `memory_save` MCP tool:

- `platformSource`: "codex"
- `agentId`: "codex/main"
- `projectName`: "{project-name}"
- `rootPath`: the absolute path to this project root
- `type`: decision | bugfix | discovery | refactor | feature | change
- `title`: one-line summary
- `text`: explanation of what was decided, found, or fixed

Other agents (Claude Code, Cursor, Gemini…) will see this memory in their next session.
```

---

## Cursor → `.cursor/rules/claude-mem.mdc`

```markdown
---
description: Shared memory across all agents via claude-mem
alwaysApply: true
---

## Shared Memory (claude-mem)

After completing any significant decision, bugfix, or discovery, call the `memory_save` MCP tool:

- `platformSource`: "cursor"
- `agentId`: "cursor/default"
- `projectName`: "{project-name}"
- `rootPath`: the absolute path to this project root
- `type`: decision | bugfix | discovery | refactor | feature | change
- `title`: one-line summary
- `text`: explanation of what was decided, found, or fixed

Other agents (Claude Code, Codex, Gemini…) will see this memory in their next session.
```

---

## Gemini CLI → `GEMINI.md`

```markdown
## Shared Memory (claude-mem)

After completing any significant decision, bugfix, or discovery, call the `memory_save` MCP tool:

- `platformSource`: "gemini"
- `agentId`: "gemini/default"
- `projectName`: "{project-name}"
- `rootPath`: the absolute path to this project root
- `type`: decision | bugfix | discovery | refactor | feature | change
- `title`: one-line summary
- `text`: explanation of what was decided, found, or fixed

Other agents (Claude Code, Cursor, Codex…) will see this memory in their next session.
```

---

## Windsurf → `.windsurfrules`

```markdown
## Shared Memory (claude-mem)

After completing any significant decision, bugfix, or discovery, call the `memory_save` MCP tool:

- `platformSource`: "windsurf"
- `agentId`: "windsurf/default"
- `projectName`: "{project-name}"
- `rootPath`: the absolute path to this project root
- `type`: decision | bugfix | discovery | refactor | feature | change
- `title`: one-line summary
- `text`: explanation of what was decided, found, or fixed

Other agents (Claude Code, Cursor, Gemini…) will see this memory in their next session.
```

---

## When to call `memory_save` — decision guide

Call it when you:
- Made an architectural or design decision ("use X instead of Y because…")
- Fixed a non-trivial bug ("root cause was…", "fixed by…")
- Discovered something non-obvious about the codebase ("X is why Y behaves like Z")
- Completed a refactor or feature worth summarising

Do NOT call it for:
- Trivial edits (typo fixes, formatting)
- Work-in-progress that hasn't resolved yet
- Things already captured by previous `memory_save` calls in the same session
