# agent-mem

> A fork of [claude-mem](https://github.com/thedotmack/claude-mem) extended with **agent-neutral shared memory** — persistent context that works across Claude Code, Cursor, Gemini CLI, Windsurf, and any MCP-compatible agent.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-13.6.1-green.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](package.json)

---

## What's different in this fork

| Feature | Upstream claude-mem | This fork |
|---|---|---|
| Persistent session memory | Claude Code only | All MCP-compatible agents |
| Memory write API | Hook-based (Claude Code) | `POST /api/memory/ingest` + `memory_save` MCP tool |
| Context injection | Claude Code sessions | Agent-attributed, token-budgeted renderer |
| IDE config templates | None | Cursor, Gemini CLI, Windsurf ready-to-use |
| Legacy observation backfill | None | `ObservationBackfillService` for migration |

### New in this fork

- **`memory_save` MCP tool** — any agent (Cursor, Windsurf, Gemini, Codex…) can write a memory entry through a single MCP call without Claude Code hooks
- **`POST /api/memory/ingest`** — HTTP endpoint wrapping `AgentMemoryIngestService`, enabling programmatic memory writes from scripts, CI pipelines, or custom agents
- **MCP config templates** — drop-in `.cursor/mcp.json`, `.gemini/mcp.json`, `.windsurf/mcp.json` with agent instruction snippets
- **`MemoryContextCompiler` + `MemoryContextRenderer`** — wires relevant observations into agent context with per-agent attribution and configurable token budget
- **`ObservationBackfillService`** — migrates legacy observations to the new agent-neutral schema

---

## Installation

### Step 1 — Install the base plugin

Pick the method for your primary agent:

**Claude Code**
```bash
npx claude-mem install
# or from inside Claude Code:
/plugin marketplace add thedotmack/claude-mem
/plugin install claude-mem
```

**Gemini CLI**
```bash
npx claude-mem install --ide gemini-cli
```

**OpenCode**
```bash
npx claude-mem install --ide opencode
```

Restart the IDE after installation.

---

### Step 2 — Enable shared memory for additional agents

This fork adds agent-neutral memory so Cursor, Windsurf, Gemini CLI, and Codex can all read and write to the same store.

**Register the MCP server**

Copy the config file from `plugin/integrations/` to the correct location:

| Agent | Source file | Destination |
|---|---|---|
| Cursor | `plugin/integrations/cursor-mcp.json` | `<project-root>/.cursor/mcp.json` |
| Windsurf | `plugin/integrations/windsurf-mcp.json` | `<project-root>/.windsurf/mcp.json` |
| Gemini CLI | `plugin/integrations/gemini-settings-patch.json` | merge into `~/.gemini/settings.json` |

Claude Code and Codex pick up the MCP server automatically via the plugin — no action needed.

**Add agent instructions**

Copy the relevant snippet from [`plugin/integrations/agent-instructions.md`](plugin/integrations/agent-instructions.md) into each agent's system prompt file, replacing `{project-name}` with your repo identifier (e.g. `"my-org/my-repo"`):

| Agent | System prompt file |
|---|---|
| Claude Code | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Cursor | `.cursor/rules/claude-mem.mdc` |
| Gemini CLI | `GEMINI.md` |
| Windsurf | `.windsurfrules` |

**Verify**

Ask any agent:
> "Use memory_save to record that we decided to use shared memory across agents in this project."

Then open a different agent — the memory should appear in injected context at session start.

Full setup reference: [`plugin/integrations/SETUP.md`](plugin/integrations/SETUP.md)

---

## How It Works

```
Agent session
    │
    ├─ SessionStart hook → MemoryContextCompiler fetches relevant observations
    │                       MemoryContextRenderer injects context with token budget
    │
    ├─ Tool calls / edits → PostToolUse hook captures observations
    │
    ├─ memory_save MCP tool ──────────────────────────────────┐
    │                                                          │
    └─ POST /api/memory/ingest ────────────────────────────── ▼
                                                    AgentMemoryIngestService
                                                    SQLite + Chroma vector DB
                                                    (shared across all agents)
```

**Core components:**

1. **Lifecycle hooks** (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) — Claude Code integration
2. **Worker service** — HTTP API on port `37777` with web viewer UI and 10 search endpoints, managed by Bun
3. **SQLite + Chroma** — hybrid keyword + semantic search, shared across agents
4. **`memory_save` MCP tool** — agent-neutral write path, no hooks required
5. **`MemoryContextCompiler`** — backfill-aware context assembly with legacy fallback
6. **`mem-search` skill** — natural language queries with progressive disclosure

---

## MCP Search Tools

Three-layer workflow for token-efficient memory retrieval:

```typescript
// 1. Get compact index (~50-100 tokens/result)
search(query="authentication bug", type="bugfix", limit=10)

// 2. Inspect timeline around interesting results
timeline(observation_id=123)

// 3. Fetch full details only for relevant IDs (~500-1000 tokens/result)
get_observations(ids=[123, 456])
```

**~10x token savings** by filtering before fetching details.

---

## System Requirements

- **Node.js** 20.0.0 or higher
- **Bun** — auto-installed if missing
- **uv** — Python package manager for Chroma, auto-installed if missing
- **SQLite 3** — bundled

---

## Configuration

Settings live in `~/.claude-mem/settings.json` (created on first run).

```json
{
  "CLAUDE_MEM_MODE": "code",
  "workerPort": 37777
}
```

Available modes: `code` (default English), `code--zh` (Simplified Chinese), `code--ja` (Japanese).

---

## Development

```bash
npm run build-and-sync   # Build, sync to marketplace, restart worker
npm test                 # Run test suite
npm run typecheck        # Type-check without emitting
```

File layout:

| Path | Purpose |
|---|---|
| `src/` | TypeScript source |
| `plugin/` | Built plugin (hooks, skills, modes, worker) |
| `~/.claude/plugins/marketplaces/thedotmack/` | Installed plugin location |
| `~/.claude-mem/claude-mem.db` | SQLite database |
| `~/.claude-mem/chroma/` | Vector embeddings |

---

## Contributing

1. Fork this repo
2. Create a feature branch
3. Make changes with tests
4. Submit a Pull Request

---

## Credits

Built on top of [claude-mem](https://github.com/thedotmack/claude-mem) by [Alex Newman (@thedotmack)](https://github.com/thedotmack).

Fork maintained by [Phong Nguyen (@18PhongNguyen)](https://github.com/18PhongNguyen).

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
