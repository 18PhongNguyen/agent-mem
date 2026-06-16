# MCP `memory_save` Tool Design

**Goal:** Allow any MCP-capable agent (Codex, Cursor, Gemini, Claude Code…) to proactively write a memory item into the shared `memory_items` store, identified by its own `platformSource`.

**Approach:** New HTTP route `POST /api/memory/ingest` wraps `AgentMemoryIngestService`. New MCP tool `memory_save` calls that route. Existing routes and tools are untouched.

---

## Architecture

```
Agent (Codex / Cursor / Gemini / ...)
  └─ MCP tool: memory_save(platformSource, rootPath, ...)
        └─ callWorkerAPIPost('/api/memory/ingest', body)
              └─ MemoryRoutes: POST /api/memory/ingest
                    └─ AgentMemoryIngestService.ingestMemory()
                          └─ memory_items table (shared store)
```

The worker already receives tool calls from the MCP server via `workerHttpRequest`. The new route follows the same pattern as existing POST routes.

---

## HTTP Route

**File:** `src/services/worker/http/routes/MemoryRoutes.ts`

**Endpoint:** `POST /api/memory/ingest`

**Request body** (Zod-validated, strict):

| Field | Type | Required | Description |
|---|---|---|---|
| `platformSource` | `string` | yes | Agent identity: `"codex"`, `"cursor"`, `"gemini"`, `"claude-code"` |
| `agentId` | `string` | yes | Agent instance: `"codex/main"`, `"cursor/default"` |
| `projectName` | `string` | yes | Project identifier: `"my-org/my-repo"` |
| `rootPath` | `string` | yes | Absolute path to project root |
| `type` | `string` (enum) | yes | `decision` \| `bugfix` \| `discovery` \| `refactor` \| `feature` \| `change` |
| `title` | `string` | no | Short title |
| `text` | `string` | no | Narrative / explanation |
| `facts` | `string[]` | no | Bullet-style facts |
| `concepts` | `string[]` | no | Concept tags |
| `filesModified` | `string[]` | no | Relative file paths |
| `sessionId` | `string` | no | Content session ID from the calling agent |

**`sourceUri` generation** (internal, not exposed in request):
```
agent://{platformSource}/{sessionId ?? 'manual'}/{Date.now()}
```
Idempotency is handled by `AgentMemoryIngestService` — if a `sourceUri` already exists in `memory_sources`, it returns the existing record without writing a duplicate.

**Response:**
```typescript
{ success: true, id: string, projectId: string, title: string }
```

**Errors:** 400 for validation failures (missing required fields), 500 for unexpected errors.

---

## MCP Tool

**File:** `src/servers/mcp-server.ts` — added to the `tools` array

**Tool name:** `memory_save`

**Description:**
> Save a memory to the shared project memory store. All agents reading context from this project will see it. Use after decisions, discoveries, or bugfixes worth remembering across sessions.

**Input schema:**

```typescript
{
  type: 'object',
  properties: {
    platformSource: { type: 'string', description: 'Your agent identity: "codex", "cursor", "gemini", "claude-code"' },
    agentId:        { type: 'string', description: 'Specific agent instance, e.g. "cursor/default"' },
    projectName:    { type: 'string', description: 'Project identifier, e.g. "my-org/my-repo"' },
    rootPath:       { type: 'string', description: 'Absolute path to project root, e.g. "/home/user/my-repo"' },
    type:           { type: 'string', enum: ['decision','bugfix','discovery','refactor','feature','change'] },
    title:          { type: 'string' },
    text:           { type: 'string', description: 'Narrative / explanation' },
    facts:          { type: 'array', items: { type: 'string' } },
    concepts:       { type: 'array', items: { type: 'string' } },
    filesModified:  { type: 'array', items: { type: 'string' } },
    sessionId:      { type: 'string' },
  },
  required: ['platformSource', 'agentId', 'projectName', 'rootPath', 'type'],
}
```

**Handler:** `callWorkerAPIPost('/api/memory/ingest', args)` — same pattern as other POST tools. Returns `isError: true` on worker failure without throwing.

---

## Tests

### `tests/services/worker/http/routes/memory-ingest.test.ts`

Tests HTTP route directly against an in-memory SQLite DB (same pattern as `observation-backfill.test.ts`):

1. Valid payload → `memory_items` row created with correct `platformSource`, `type`, `title`
2. Double POST with same payload → only 1 row (idempotency)
3. Missing required field (`platformSource`) → 400 response
4. Missing required field (`rootPath`) → 400 response

### `tests/servers/mcp-memory-save.test.ts`

Tests MCP tool definition and handler in isolation (mock `callWorkerAPIPost`):

1. Tool definition has correct `name`, all required fields in `inputSchema`
2. Handler forwards full body to `/api/memory/ingest`
3. Worker error response → tool returns `{ isError: true }` without throwing

---

## File Map

| Path | Action |
|---|---|
| `src/services/worker/http/routes/MemoryRoutes.ts` | Add `POST /api/memory/ingest` handler |
| `src/servers/mcp-server.ts` | Add `memory_save` tool to `tools` array |
| `tests/services/worker/http/routes/memory-ingest.test.ts` | New — HTTP route tests |
| `tests/servers/mcp-memory-save.test.ts` | New — MCP tool tests |

No existing routes, tools, or tests are modified.
