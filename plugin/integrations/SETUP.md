# claude-mem Integration Setup

Files in this directory let non-Claude-Code agents (Cursor, Gemini, Windsurf) write to the shared memory store.

## Step 1: Register the MCP server

Copy the config file to the correct location in your project:

| Agent | Copy this file | To |
|---|---|---|
| **Cursor** | `cursor-mcp.json` | `<project-root>/.cursor/mcp.json` |
| **Windsurf** | `windsurf-mcp.json` | `<project-root>/.windsurf/mcp.json` |
| **Gemini CLI** | `gemini-settings-patch.json` | merge into `~/.gemini/settings.json` |

Claude Code and Codex get the MCP server automatically via the plugin — no action needed.

> The config uses the same auto-discovery launcher as Claude Code, so it finds mcp-server.cjs
> regardless of where claude-mem is installed.

## Step 2: Add agent instructions

Copy the relevant snippet from `agent-instructions.md` into each agent's system prompt file,
replacing `{project-name}` with your project identifier (e.g. `"my-org/my-repo"`).

| Agent | System prompt file |
|---|---|
| Claude Code | `CLAUDE.md` (project root) |
| Codex | `AGENTS.md` (project root) |
| Cursor | `.cursor/rules/claude-mem.mdc` |
| Gemini CLI | `GEMINI.md` (project root) |
| Windsurf | `.windsurfrules` (project root) |

## Verify it works

After setup, ask the agent:

> "Use memory_save to record that we decided to use shared memory across agents in this project."

Then check another agent's session — the memory should appear in the injected context.
