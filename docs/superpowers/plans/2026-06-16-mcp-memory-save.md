# MCP `memory_save` Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow any MCP-capable agent to proactively write a memory item into the shared `memory_items` store via a new `memory_save` MCP tool backed by a new `POST /api/memory/ingest` HTTP route.

**Architecture:** New route `POST /api/memory/ingest` in `MemoryRoutes.ts` wraps `AgentMemoryIngestService`. A new exported module `src/servers/tools/memory-save.ts` defines the MCP tool definition and handler factory; `mcp-server.ts` imports and registers it. No existing routes, tools, or tests are modified.

**Tech Stack:** TypeScript, Bun test, Express, Zod, `@modelcontextprotocol/sdk`, `bun:sqlite`, `AgentMemoryIngestService`.

---

## File Map

| Path | Action | Responsibility |
|---|---|---|
| `src/services/worker/http/routes/MemoryRoutes.ts` | Modify | Add `POST /api/memory/ingest` handler + Zod schema |
| `src/servers/tools/memory-save.ts` | Create | Exported tool definition + handler factory (testable) |
| `src/servers/mcp-server.ts` | Modify | Import and register `memory_save` tool |
| `tests/services/worker/http/routes/memory-ingest.test.ts` | Create | HTTP route: valid payload, validation errors |
| `tests/servers/mcp-memory-save.test.ts` | Create | MCP tool: schema shape, handler routing |

---

### Task 1: HTTP Route — `POST /api/memory/ingest`

**Files:**
- Modify: `src/services/worker/http/routes/MemoryRoutes.ts`
- Create: `tests/services/worker/http/routes/memory-ingest.test.ts`

- [ ] Create the test file with a failing test:

```typescript
// tests/services/worker/http/routes/memory-ingest.test.ts
import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { ensureServerStorageSchema } from '../../../../src/storage/sqlite/schema.js';
import { MemoryRoutes } from '../../../../src/services/worker/http/routes/MemoryRoutes.js';
import { MemoryItemsRepository, ProjectsRepository } from '../../../../src/storage/sqlite/index.js';
import type { DatabaseManager } from '../../../../src/services/worker/DatabaseManager.js';

let db: Database;
let server: Server;
let port: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  ensureServerStorageSchema(db);

  const mockDbManager = {
    getConnection: () => db,
  } as unknown as DatabaseManager;

  const app = express();
  app.use(express.json());
  new MemoryRoutes(mockDbManager, 'default/project').setupRoutes(app);

  server = app.listen(0);
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  server.close();
  db.close();
});

const VALID_PAYLOAD = {
  platformSource: 'cursor',
  agentId: 'cursor/default',
  projectName: 'my-org/my-repo',
  rootPath: 'D:/my-repo',
  type: 'decision',
  title: 'Use shared memory',
  text: 'We decided to share memory across agents',
  facts: ['fact one', 'fact two'],
  concepts: ['shared-memory'],
  filesModified: ['src/foo.ts'],
};

describe('POST /api/memory/ingest', () => {
  it('creates a memory_items row with correct platformSource, type, and title', async () => {
    const res = await fetch(`http://localhost:${port}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_PAYLOAD),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(typeof body.id).toBe('string');
    expect(body.title).toBe('Use shared memory');

    const projects = new ProjectsRepository(db);
    const project = projects.getByRootPath('D:/my-repo');
    expect(project).not.toBeNull();

    const memories = new MemoryItemsRepository(db);
    const items = memories.listByProject(project!.id, 10);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('decision');
    expect(items[0].title).toBe('Use shared memory');
    expect(items[0].facts).toEqual(['fact one', 'fact two']);
    expect(items[0].filesModified).toEqual(['src/foo.ts']);
    const meta = items[0].metadata as Record<string, unknown>;
    expect(meta.platformSource).toBe('cursor');
  });

  it('returns 400 when platformSource is missing', async () => {
    const { platformSource: _, ...withoutPlatformSource } = VALID_PAYLOAD;
    const res = await fetch(`http://localhost:${port}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withoutPlatformSource),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when rootPath is missing', async () => {
    const { rootPath: _, ...withoutRootPath } = VALID_PAYLOAD;
    const res = await fetch(`http://localhost:${port}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(withoutRootPath),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when type is not a valid enum value', async () => {
    const res = await fetch(`http://localhost:${port}/api/memory/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_PAYLOAD, type: 'invalid-type' }),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] Run to confirm it fails (route not found):

```
bun test tests/services/worker/http/routes/memory-ingest.test.ts
```

Expected: tests fail — `POST /api/memory/ingest` returns 404.

- [ ] Add the schema and handler to `src/services/worker/http/routes/MemoryRoutes.ts`.

Add after the existing `saveMemorySchema` (line 14) and before the class declaration (line 16):

```typescript
const VALID_TYPES = ['decision', 'bugfix', 'discovery', 'refactor', 'feature', 'change'] as const;

const ingestMemorySchema = z.object({
  platformSource: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  projectName: z.string().trim().min(1),
  rootPath: z.string().trim().min(1),
  type: z.enum(VALID_TYPES),
  title: z.string().optional(),
  text: z.string().optional(),
  facts: z.array(z.string()).optional(),
  concepts: z.array(z.string()).optional(),
  filesModified: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
}).strict();
```

Also add the `AgentMemoryIngestService` import at the top of the file (after the existing imports):

```typescript
import { AgentMemoryIngestService } from '../../../memory/AgentMemoryIngestService.js';
```

Register the route inside `setupRoutes` (add after the existing `app.post('/api/memory/save', ...)` line):

```typescript
app.post('/api/memory/ingest', validateBody(ingestMemorySchema), this.handleIngestMemory.bind(this));
```

Add the handler method inside the `MemoryRoutes` class (after the existing `handleSaveMemory` method):

```typescript
private handleIngestMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
  const body = req.body as z.infer<typeof ingestMemorySchema>;

  const db = this.dbManager.getConnection();
  const ingestService = new AgentMemoryIngestService(db);

  const sourceUri = `agent://${body.platformSource}/${body.projectName}/${body.type}/${body.sessionId ?? 'manual'}/${Date.now()}`;

  const result = ingestService.ingestMemory({
    platformSource: body.platformSource,
    agentId: body.agentId,
    project: {
      name: body.projectName,
      rootPath: body.rootPath,
      slug: body.projectName.split('/').pop(),
    },
    session: {
      contentSessionId: body.sessionId,
    },
    event: {
      sourceType: 'api',
      eventType: 'memory.manual',
      occurredAtEpoch: Date.now(),
      payload: {},
    },
    memory: {
      kind: 'observation',
      type: body.type,
      title: body.title,
      text: body.text,
      facts: body.facts,
      concepts: body.concepts,
      filesModified: body.filesModified,
    },
    source: { sourceUri },
  });

  logger.info('HTTP', 'Memory ingested via MCP', {
    id: result.memory.id,
    project: body.projectName,
    platformSource: body.platformSource,
  });

  res.json({
    success: true,
    id: result.memory.id,
    projectId: result.project.id,
    title: result.memory.title ?? body.type,
  });
});
```

- [ ] Run to confirm tests pass:

```
bun test tests/services/worker/http/routes/memory-ingest.test.ts
```

Expected: `4 pass, 0 fail`

- [ ] Commit:

```
git add src/services/worker/http/routes/MemoryRoutes.ts tests/services/worker/http/routes/memory-ingest.test.ts
git commit -m "feat(memory): add POST /api/memory/ingest route wrapping AgentMemoryIngestService"
```

---

### Task 2: MCP Tool — `memory_save`

**Files:**
- Create: `src/servers/tools/memory-save.ts`
- Modify: `src/servers/mcp-server.ts`
- Create: `tests/servers/mcp-memory-save.test.ts`

- [ ] Create the test file with failing tests:

```typescript
// tests/servers/mcp-memory-save.test.ts
import { describe, expect, it } from 'bun:test';
import { memorySaveToolDefinition, createMemorySaveHandler } from '../../src/servers/tools/memory-save.js';

describe('memorySaveToolDefinition', () => {
  it('has name memory_save', () => {
    expect(memorySaveToolDefinition.name).toBe('memory_save');
  });

  it('requires platformSource, agentId, projectName, rootPath, and type', () => {
    const required = memorySaveToolDefinition.inputSchema.required ?? [];
    expect(required).toContain('platformSource');
    expect(required).toContain('agentId');
    expect(required).toContain('projectName');
    expect(required).toContain('rootPath');
    expect(required).toContain('type');
  });

  it('lists optional fields in properties', () => {
    const props = Object.keys(memorySaveToolDefinition.inputSchema.properties);
    expect(props).toContain('title');
    expect(props).toContain('text');
    expect(props).toContain('facts');
    expect(props).toContain('concepts');
    expect(props).toContain('filesModified');
    expect(props).toContain('sessionId');
  });
});

describe('createMemorySaveHandler', () => {
  it('calls postFn with /api/memory/ingest and the full args object', async () => {
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];

    const mockPostFn = async (endpoint: string, body: Record<string, unknown>) => {
      calls.push({ endpoint, body });
      return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
    };

    const handler = createMemorySaveHandler(mockPostFn);
    const args = {
      platformSource: 'codex',
      agentId: 'codex/main',
      projectName: 'my-org/repo',
      rootPath: '/home/user/repo',
      type: 'decision',
      title: 'Test decision',
    };

    await handler(args);

    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe('/api/memory/ingest');
    expect(calls[0].body).toEqual(args);
  });

  it('returns isError true when postFn returns error content', async () => {
    const mockPostFn = async (_endpoint: string, _body: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'Worker error' }],
      isError: true as const,
    });

    const handler = createMemorySaveHandler(mockPostFn);
    const result = await handler({ platformSource: 'codex', agentId: 'x', projectName: 'p', rootPath: '/p', type: 'decision' });

    expect(result.isError).toBe(true);
  });
});
```

- [ ] Run to confirm it fails (module not found):

```
bun test tests/servers/mcp-memory-save.test.ts
```

Expected: error — `Cannot find module '.../memory-save.js'`

- [ ] Create `src/servers/tools/memory-save.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const memorySaveToolDefinition: McpToolDefinition = {
  name: 'memory_save',
  description:
    'Save a memory to the shared project memory store. All agents reading context from this project will see it. Use after decisions, discoveries, or bugfixes worth remembering across sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      platformSource: {
        type: 'string',
        description: 'Your agent identity: "codex", "cursor", "gemini", "claude-code"',
      },
      agentId: {
        type: 'string',
        description: 'Specific agent instance, e.g. "cursor/default"',
      },
      projectName: {
        type: 'string',
        description: 'Project identifier, e.g. "my-org/my-repo"',
      },
      rootPath: {
        type: 'string',
        description: 'Absolute path to project root, e.g. "/home/user/my-repo"',
      },
      type: {
        type: 'string',
        enum: ['decision', 'bugfix', 'discovery', 'refactor', 'feature', 'change'],
        description: 'Memory type',
      },
      title: { type: 'string' },
      text: { type: 'string', description: 'Narrative / explanation' },
      facts: { type: 'array', items: { type: 'string' } },
      concepts: { type: 'array', items: { type: 'string' } },
      filesModified: { type: 'array', items: { type: 'string' } },
      sessionId: {
        type: 'string',
        description: 'Content session ID from the calling agent',
      },
    },
    required: ['platformSource', 'agentId', 'projectName', 'rootPath', 'type'],
  },
};

type PostFn = (
  endpoint: string,
  body: Record<string, unknown>
) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

export function createMemorySaveHandler(postFn: PostFn) {
  return async (args: unknown) =>
    postFn('/api/memory/ingest', args as Record<string, unknown>);
}
```

- [ ] Run tests to confirm they pass:

```
bun test tests/servers/mcp-memory-save.test.ts
```

Expected: `5 pass, 0 fail`

- [ ] Register the tool in `src/servers/mcp-server.ts`.

Add the import near the top of the file, after the existing imports block (around line 40):

```typescript
import { memorySaveToolDefinition, createMemorySaveHandler } from './tools/memory-save.js';
```

Add the tool entry at the end of the `tools` array, just before the closing `]` (around line 892 — after the `reprime_corpus` entry):

```typescript
  {
    ...memorySaveToolDefinition,
    handler: createMemorySaveHandler(callWorkerAPIPost),
  }
```

- [ ] Commit:

```
git add src/servers/tools/memory-save.ts src/servers/mcp-server.ts tests/servers/mcp-memory-save.test.ts
git commit -m "feat(mcp): add memory_save tool for agent-neutral shared memory writes"
```

---

### Task 3: Verification

- [ ] Run the full relevant test suite:

```
bun test tests/services/worker/http/routes/memory-ingest.test.ts tests/servers/mcp-memory-save.test.ts tests/storage/sqlite/agent-memory-ingest.test.ts tests/storage/sqlite/observation-backfill.test.ts
```

Expected: all pass, 0 fail

- [ ] Run typecheck:

```
npm run typecheck:root
```

Expected: no output (zero errors)

- [ ] If typecheck fails on `MemoryRoutes.ts` because `AgentMemoryIngestService` import path is wrong, check the relative path from `src/services/worker/http/routes/` to `src/services/memory/`:

Correct import is:
```typescript
import { AgentMemoryIngestService } from '../../../memory/AgentMemoryIngestService.js';
```

Fix and re-run typecheck.

- [ ] Commit any typecheck fixes (only if changes were needed):

```
git add -A
git commit -m "fix(types): resolve typecheck errors in MemoryRoutes after AgentMemoryIngestService addition"
```

- [ ] Push:

```
git push origin main
```
