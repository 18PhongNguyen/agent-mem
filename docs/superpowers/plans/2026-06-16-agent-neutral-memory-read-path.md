# Agent-Neutral Memory Read Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy `observations`-based context injection with a new `memory_items`-based read path so all agents (Claude Code, Codex, Cursor, Gemini, Windsurf) share one project-scoped memory store.

**Architecture:** `ObservationBackfillService` migrates legacy rows into `memory_items` on first access per project. `MemoryContextCompiler` resolves `cwd` → project UUID and fetches items, with automatic legacy fallback. `MemoryContextRenderer` formats items with agent attribution. `ContextBuilder` wires all pieces together behind unchanged public signatures.

**Tech Stack:** TypeScript, Bun test, `bun:sqlite` Database, existing `MemoryItemsRepository` / `ProjectsRepository` / `AgentMemoryIngestService`.

---

## File Map

| Path | Action | Responsibility |
|---|---|---|
| `src/services/memory/ObservationBackfillService.ts` | Create | Reads `observations`, writes each as `memory_items` via `AgentMemoryIngestService` |
| `src/services/context/MemoryContextCompiler.ts` | Create | Resolves `cwd` → project UUID, fetches `MemoryItem[]`, triggers backfill, returns fallback signal |
| `src/services/context/sections/MemoryContextRenderer.ts` | Create | Renders `MemoryItem[]` as a rich, agent-attributed context string |
| `src/services/context/ContextBuilder.ts` | Modify | Wires compiler + renderer; adds `memory_source` + `agent_count` to `ContextInjectStats` |
| `tests/storage/sqlite/observation-backfill.test.ts` | Create | Backfill field mapping + idempotency |
| `tests/services/context/memory-context-compiler.test.ts` | Create | Project resolution, fallback conditions |
| `tests/services/context/memory-context-renderer.test.ts` | Create | Format correctness, token cap, empty state |

---

### Task 1: ObservationBackfillService

**Files:**
- Create: `src/services/memory/ObservationBackfillService.ts`
- Test: `tests/storage/sqlite/observation-backfill.test.ts`

- [ ] Create test file with helpers and first failing test:

```typescript
// tests/storage/sqlite/observation-backfill.test.ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ObservationBackfillService } from '../../../src/services/memory/ObservationBackfillService.js';
import { MemoryItemsRepository, ProjectsRepository } from '../../../src/storage/sqlite/index.js';
import { ensureServerStorageSchema } from '../../../src/storage/sqlite/schema.js';

function withDb(fn: (db: Database) => void): void {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  ensureServerStorageSchema(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      merged_into_project TEXT,
      memory_session_id TEXT NOT NULL DEFAULT 'sess-1',
      type TEXT NOT NULL DEFAULT 'decision',
      title TEXT,
      narrative TEXT,
      facts TEXT NOT NULL DEFAULT '[]',
      concepts TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      discovery_tokens INTEGER,
      created_at TEXT,
      created_at_epoch INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      platform_source TEXT
    )
  `);
  try { fn(db); } finally { db.close(); }
}

describe('ObservationBackfillService', () => {
  it('migrates observations into memory_items with correct field mapping', () => {
    withDb(db => {
      db.prepare(`
        INSERT INTO observations (project, memory_session_id, type, title, narrative, facts, concepts, files_modified, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('test/project', 'sess-1', 'decision', 'Use shared memory', 'We decided this', '["fact one"]', '["shared-mem"]', '["src/foo.ts"]', 1771050000000);
      db.prepare(`INSERT INTO sdk_sessions (memory_session_id, platform_source) VALUES (?, ?)`).run('sess-1', 'codex');

      const svc = new ObservationBackfillService(db);
      const result = svc.backfill('test/project', 'D:/test/project');

      expect(result.migrated).toBe(1);
      expect(result.skipped).toBe(0);

      const projects = new ProjectsRepository(db);
      const project = projects.getByRootPath('D:/test/project');
      expect(project).not.toBeNull();

      const memories = new MemoryItemsRepository(db);
      const items = memories.listByProject(project!.id, 10);
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('decision');
      expect(items[0].title).toBe('Use shared memory');
      expect(items[0].text).toBe('We decided this');
      expect(items[0].facts).toEqual(['fact one']);
      expect(items[0].concepts).toEqual(['shared-mem']);
      expect(items[0].filesModified).toEqual(['src/foo.ts']);
      expect((items[0].metadata as Record<string, unknown>).platformSource).toBe('codex');

      const sources = memories.listSources(items[0].id);
      expect(sources[0].sourceUri).toBe('legacy://observations/1');
    });
  });

  it('is idempotent — double run produces one memory_items row', () => {
    withDb(db => {
      db.prepare(`
        INSERT INTO observations (project, memory_session_id, type, title, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run('test/project', 'sess-1', 'decision', 'Same thing', 1771050000000);

      const svc = new ObservationBackfillService(db);
      const first = svc.backfill('test/project', 'D:/test/project');
      const second = svc.backfill('test/project', 'D:/test/project');

      expect(first.migrated).toBe(1);
      expect(second.migrated).toBe(0);
      expect(second.skipped).toBe(1);

      const projects = new ProjectsRepository(db);
      const project = projects.getByRootPath('D:/test/project');
      const memories = new MemoryItemsRepository(db);
      expect(memories.listByProject(project!.id, 10)).toHaveLength(1);
    });
  });
});
```

- [ ] Run test to confirm it fails (service not found):

```
bun test tests/storage/sqlite/observation-backfill.test.ts
```

Expected: error — `Cannot find module '.../ObservationBackfillService.js'`

- [ ] Create `src/services/memory/ObservationBackfillService.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import { AgentMemoryIngestService } from './AgentMemoryIngestService.js';

interface LegacyObservationRow {
  id: number;
  memory_session_id: string;
  platform_source: string | null;
  type: string;
  title: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  files_modified: string | null;
  created_at_epoch: number;
}

export class ObservationBackfillService {
  private ingest: AgentMemoryIngestService;

  constructor(private db: Database) {
    this.ingest = new AgentMemoryIngestService(db);
  }

  backfill(projectName: string, rootPath: string): { migrated: number; skipped: number } {
    let rows: LegacyObservationRow[];
    try {
      rows = this.db.prepare(`
        SELECT
          o.id,
          o.memory_session_id,
          COALESCE(s.platform_source, 'claude') as platform_source,
          o.type,
          o.title,
          o.narrative,
          o.facts,
          o.concepts,
          o.files_modified,
          o.created_at_epoch
        FROM observations o
        LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
        WHERE (o.project = ? OR o.merged_into_project = ?)
        ORDER BY o.created_at_epoch ASC
      `).all(projectName, projectName) as LegacyObservationRow[];
    } catch {
      return { migrated: 0, skipped: 0 };
    }

    let migrated = 0;
    let skipped = 0;

    for (const row of rows) {
      const sourceUri = `legacy://observations/${row.id}`;
      const existing = this.db.prepare(
        'SELECT id FROM memory_sources WHERE source_uri = ?'
      ).get(sourceUri);

      if (existing) {
        skipped++;
        continue;
      }

      try {
        this.ingest.ingestMemory({
          platformSource: row.platform_source ?? 'claude',
          agentId: row.platform_source ?? 'claude',
          project: {
            name: projectName,
            rootPath,
            slug: projectName.split('/').pop(),
          },
          session: {
            memorySessionId: row.memory_session_id,
          },
          event: {
            sourceType: 'hook',
            eventType: 'memory.observation',
            occurredAtEpoch: row.created_at_epoch,
            payload: {},
          },
          memory: {
            kind: 'observation',
            type: row.type,
            title: row.title ?? undefined,
            text: row.narrative ?? undefined,
            facts: row.facts ? (JSON.parse(row.facts) as string[]) : undefined,
            concepts: row.concepts ? (JSON.parse(row.concepts) as string[]) : undefined,
            filesModified: row.files_modified ? (JSON.parse(row.files_modified) as string[]) : undefined,
          },
          source: { sourceUri },
        });
        migrated++;
      } catch {
        skipped++;
      }
    }

    return { migrated, skipped };
  }
}
```

- [ ] Run tests to confirm they pass:

```
bun test tests/storage/sqlite/observation-backfill.test.ts
```

Expected: `2 pass, 0 fail`

- [ ] Commit:

```
git add src/services/memory/ObservationBackfillService.ts tests/storage/sqlite/observation-backfill.test.ts
git commit -m "feat(memory): add ObservationBackfillService for legacy observation migration"
```

---

### Task 2: MemoryContextCompiler

**Files:**
- Create: `src/services/context/MemoryContextCompiler.ts`
- Test: `tests/services/context/memory-context-compiler.test.ts`

- [ ] Create test directory and test file:

```typescript
// tests/services/context/memory-context-compiler.test.ts
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { compileMemoryContext } from '../../../src/services/context/MemoryContextCompiler.js';
import { AgentMemoryIngestService } from '../../../src/services/memory/AgentMemoryIngestService.js';
import { ensureServerStorageSchema } from '../../../src/storage/sqlite/schema.js';

function withDb(fn: (db: Database) => void): void {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  ensureServerStorageSchema(db);
  db.run(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      merged_into_project TEXT,
      memory_session_id TEXT NOT NULL DEFAULT 'sess-1',
      type TEXT NOT NULL DEFAULT 'decision',
      title TEXT,
      narrative TEXT,
      facts TEXT NOT NULL DEFAULT '[]',
      concepts TEXT NOT NULL DEFAULT '[]',
      files_read TEXT NOT NULL DEFAULT '[]',
      files_modified TEXT NOT NULL DEFAULT '[]',
      discovery_tokens INTEGER,
      created_at TEXT,
      created_at_epoch INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sdk_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT,
      platform_source TEXT
    )
  `);
  try { fn(db); } finally { db.close(); }
}

describe('compileMemoryContext', () => {
  it('returns memory_items when project has items written by AgentMemoryIngestService', () => {
    withDb(db => {
      const svc = new AgentMemoryIngestService(db);
      svc.ingestMemory({
        platformSource: 'claude-code',
        agentId: 'claude/main',
        project: { name: 'test/proj', rootPath: 'D:/test/proj' },
        session: { contentSessionId: 'sess-1' },
        event: { sourceType: 'hook', eventType: 'memory.observation', occurredAtEpoch: Date.now(), payload: {} },
        memory: { kind: 'observation', type: 'decision', title: 'Use memory_items' },
        source: { sourceUri: 'agent://claude/sess-1/1' },
      });

      const result = compileMemoryContext(db, 'D:/test/proj', 'test/proj', 20);

      expect(result.source).toBe('memory_items');
      if (result.source === 'memory_items') {
        expect(result.items).toHaveLength(1);
        expect(result.items[0].title).toBe('Use memory_items');
        expect(result.projectName).toBe('test/proj');
      }
    });
  });

  it('triggers backfill and returns memory_items when project only has legacy observations', () => {
    withDb(db => {
      db.prepare(`
        INSERT INTO observations (project, memory_session_id, type, title, created_at_epoch)
        VALUES (?, ?, ?, ?, ?)
      `).run('test/proj', 'sess-1', 'decision', 'Legacy title', Date.now());

      const result = compileMemoryContext(db, 'D:/test/proj', 'test/proj', 20);

      expect(result.source).toBe('memory_items');
      if (result.source === 'memory_items') {
        expect(result.items[0].title).toBe('Legacy title');
      }
    });
  });

  it('returns legacy when no project exists and no observations exist', () => {
    withDb(db => {
      const result = compileMemoryContext(db, 'D:/nonexistent', 'no/project', 20);
      expect(result.source).toBe('legacy');
    });
  });

  it('returns legacy when project exists but has zero memory_items', () => {
    withDb(db => {
      // Create project via ingest then delete all items to simulate empty project
      const svc = new AgentMemoryIngestService(db);
      svc.ingestMemory({
        platformSource: 'claude-code',
        agentId: 'claude/main',
        project: { name: 'empty/proj', rootPath: 'D:/empty/proj' },
        session: { contentSessionId: 'sess-x' },
        event: { sourceType: 'hook', eventType: 'memory.observation', occurredAtEpoch: Date.now(), payload: {} },
        memory: { kind: 'observation', type: 'decision', title: 'temp' },
        source: { sourceUri: 'agent://claude/sess-x/1' },
      });
      db.run('DELETE FROM memory_items');

      const result = compileMemoryContext(db, 'D:/empty/proj', 'empty/proj', 20);
      expect(result.source).toBe('legacy');
    });
  });
});
```

- [ ] Run test to confirm it fails:

```
bun test tests/services/context/memory-context-compiler.test.ts
```

Expected: error — `Cannot find module '.../MemoryContextCompiler.js'`

- [ ] Create `src/services/context/MemoryContextCompiler.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import type { MemoryItem } from '../../core/schemas/memory-item.js';
import { MemoryItemsRepository, ProjectsRepository } from '../../storage/sqlite/index.js';
import { ensureServerStorageSchema } from '../../storage/sqlite/schema.js';
import { ObservationBackfillService } from '../memory/ObservationBackfillService.js';

export type MemoryCompilerResult =
  | { source: 'memory_items'; items: MemoryItem[]; projectName: string }
  | { source: 'legacy' };

export function compileMemoryContext(
  db: Database,
  cwd: string,
  projectName: string,
  limit: number
): MemoryCompilerResult {
  ensureServerStorageSchema(db);

  const projectsRepo = new ProjectsRepository(db);
  let project = projectsRepo.getByRootPath(cwd);

  if (!project) {
    const backfill = new ObservationBackfillService(db);
    const result = backfill.backfill(projectName, cwd);
    if (result.migrated === 0 && result.skipped === 0) {
      return { source: 'legacy' };
    }
    project = projectsRepo.getByRootPath(cwd);
  }

  if (!project) return { source: 'legacy' };

  const memoriesRepo = new MemoryItemsRepository(db);
  const items = memoriesRepo.listByProject(project.id, limit);

  if (items.length === 0) return { source: 'legacy' };

  return { source: 'memory_items', items, projectName };
}
```

- [ ] Run tests to confirm they pass:

```
bun test tests/services/context/memory-context-compiler.test.ts
```

Expected: `4 pass, 0 fail`

- [ ] Commit:

```
git add src/services/context/MemoryContextCompiler.ts tests/services/context/memory-context-compiler.test.ts
git commit -m "feat(context): add MemoryContextCompiler with backfill trigger and legacy fallback"
```

---

### Task 3: MemoryContextRenderer

**Files:**
- Create: `src/services/context/sections/MemoryContextRenderer.ts`
- Test: `tests/services/context/memory-context-renderer.test.ts`

- [ ] Create test file:

```typescript
// tests/services/context/memory-context-renderer.test.ts
import { describe, expect, it } from 'bun:test';
import { renderMemoryContext } from '../../../src/services/context/sections/MemoryContextRenderer.js';
import type { MemoryItem } from '../../../src/core/schemas/memory-item.js';

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'item-1',
    projectId: 'proj-1',
    serverSessionId: null,
    legacyObservationId: null,
    kind: 'observation',
    type: 'decision',
    title: 'Test title',
    subtitle: null,
    text: null,
    narrative: null,
    facts: ['fact one'],
    concepts: ['shared-mem'],
    filesRead: [],
    filesModified: ['src/foo.ts'],
    metadata: { platformSource: 'codex', agentId: 'codex/main' },
    createdAtEpoch: Date.now() - 3_600_000,
    updatedAtEpoch: Date.now() - 3_600_000,
    ...overrides,
  };
}

describe('renderMemoryContext', () => {
  it('renders header with memory count and agent count', () => {
    const item1 = makeItem({ metadata: { platformSource: 'codex' } });
    const item2 = makeItem({ id: 'item-2', metadata: { platformSource: 'claude-code' }, title: 'Other title' });
    const output = renderMemoryContext([item1, item2], 'parent/myproject', 99999, false);

    expect(output).toContain('Project Memory: myproject');
    expect(output).toContain('2 memories');
    expect(output).toContain('2 agents');
  });

  it('renders platform source label on each entry', () => {
    const output = renderMemoryContext([makeItem()], 'parent/proj', 99999, false);
    expect(output).toContain('[codex]');
  });

  it('renders title, facts, files, and concepts', () => {
    const output = renderMemoryContext([makeItem()], 'parent/proj', 99999, false);
    expect(output).toContain('Test title');
    expect(output).toContain('fact one');
    expect(output).toContain('src/foo.ts');
    expect(output).toContain('shared-mem');
  });

  it('caps output at token budget and shows remaining count', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Title ${i}` })
    );
    // Very small budget — only a few items should fit
    const output = renderMemoryContext(items, 'parent/proj', 200, false);
    expect(output).toContain('earlier memories');
  });

  it('returns empty string for empty items array', () => {
    expect(renderMemoryContext([], 'parent/proj', 99999, false)).toBe('');
  });
});
```

- [ ] Run test to confirm it fails:

```
bun test tests/services/context/memory-context-renderer.test.ts
```

Expected: error — `Cannot find module '.../MemoryContextRenderer.js'`

- [ ] Create `src/services/context/sections/MemoryContextRenderer.ts`:

```typescript
// SPDX-License-Identifier: Apache-2.0

import type { MemoryItem } from '../../../core/schemas/memory-item.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../types.js';

const MAX_DISPLAY_ITEMS = 10;

function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffHours = Math.floor(diffMs / 3_600_000);
  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function renderMemoryContext(
  items: MemoryItem[],
  projectName: string,
  tokenBudget: number,
  _forHuman: boolean
): string {
  if (items.length === 0) return '';

  const agentSources = new Set(
    items
      .map(i => (i.metadata as Record<string, unknown>)?.platformSource as string)
      .filter(Boolean)
  );
  const agentCount = agentSources.size || 1;
  const lastUpdated = formatRelativeTime(items[0].createdAtEpoch);
  const displayName = projectName.split('/').pop() ?? projectName;

  const border = '═'.repeat(52);
  const headerLines = [
    `╔══ Project Memory: ${displayName} ${'═'.repeat(Math.max(0, 32 - displayName.length))}╗`,
    `║ ${items.length} ${items.length === 1 ? 'memory' : 'memories'} · ${agentCount} agent${agentCount !== 1 ? 's' : ''} · last updated ${lastUpdated}`,
    `╚${border}╝`,
    '',
  ];

  let tokenCount = estimateTokens(headerLines.join('\n'));
  const bodyLines: string[] = [];
  let shown = 0;

  for (const item of items.slice(0, MAX_DISPLAY_ITEMS)) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const platform = (meta.platformSource as string | undefined) ?? 'unknown';
    const date = formatDate(item.createdAtEpoch);
    const entry: string[] = [];

    entry.push(`[${platform}] ${date} · ${item.type}`);
    if (item.title) entry.push(`  ${item.title}`);
    if (item.facts && item.facts.length > 0) entry.push(`  Facts: ${item.facts.join(' · ')}`);
    if (item.filesModified && item.filesModified.length > 0) entry.push(`  Files: ${item.filesModified.join(', ')}`);
    if (item.concepts && item.concepts.length > 0) entry.push(`  Concepts: ${item.concepts.join(', ')}`);
    entry.push('');

    const entryTokens = estimateTokens(entry.join('\n'));
    if (tokenCount + entryTokens > tokenBudget) break;

    bodyLines.push(...entry);
    tokenCount += entryTokens;
    shown++;
  }

  const remaining = items.length - shown;
  const footer = remaining > 0
    ? [`─── ${remaining} earlier ${remaining === 1 ? 'memory' : 'memories'} (/memory full to expand) ───`]
    : [];

  return [...headerLines, ...bodyLines, ...footer].join('\n').trimEnd();
}
```

- [ ] Run tests to confirm they pass:

```
bun test tests/services/context/memory-context-renderer.test.ts
```

Expected: `5 pass, 0 fail`

- [ ] Commit:

```
git add src/services/context/sections/MemoryContextRenderer.ts tests/services/context/memory-context-renderer.test.ts
git commit -m "feat(context): add MemoryContextRenderer with agent attribution and token budget"
```

---

### Task 4: Wire ContextBuilder

**Files:**
- Modify: `src/services/context/ContextBuilder.ts`

- [ ] Add `memory_source` and `agent_count` to `ContextInjectStats` interface in `ContextBuilder.ts` (around line 106):

Replace:
```typescript
export interface ContextInjectStats {
  observation_count: number;
  session_count: number;
  timeline_depth_days: number;
  has_session_summary: boolean;
  obs_type_bugfix: number;
  obs_type_discovery: number;
  obs_type_decision: number;
  obs_type_refactor: number;
  obs_type_other: number;
  tokens_injected: number;
  tokens_saved_vs_naive: number;
  search_strategy: string;
}
```

With:
```typescript
export interface ContextInjectStats {
  observation_count: number;
  session_count: number;
  timeline_depth_days: number;
  has_session_summary: boolean;
  obs_type_bugfix: number;
  obs_type_discovery: number;
  obs_type_decision: number;
  obs_type_refactor: number;
  obs_type_other: number;
  tokens_injected: number;
  tokens_saved_vs_naive: number;
  search_strategy: string;
  memory_source: 'memory_items' | 'legacy';
  agent_count: number;
}
```

- [ ] Add new imports at the top of `ContextBuilder.ts` (after the existing imports block):

```typescript
import { compileMemoryContext } from './MemoryContextCompiler.js';
import { renderMemoryContext } from './sections/MemoryContextRenderer.js';
import type { MemoryItem } from '../../core/schemas/memory-item.js';
```

- [ ] Add `buildMemoryInjectStats` function after the existing `buildInjectStats` function (around line 160):

```typescript
const MEMORY_STAT_TYPE_BUCKETS = new Set(['bugfix', 'discovery', 'decision', 'refactor']);

function buildMemoryInjectStats(items: MemoryItem[]): ContextInjectStats {
  const agentSources = new Set(
    items
      .map(i => (i.metadata as Record<string, unknown>)?.platformSource as string)
      .filter(Boolean)
  );
  const typeCounts: Record<string, number> = {
    bugfix: 0, discovery: 0, decision: 0, refactor: 0, other: 0,
  };
  for (const item of items) {
    const bucket = MEMORY_STAT_TYPE_BUCKETS.has(item.type) ? item.type : 'other';
    typeCounts[bucket]++;
  }
  const oldestEpoch = items.length > 0
    ? Math.min(...items.map(i => i.createdAtEpoch))
    : Date.now();
  const timelineDepthDays = Math.max(0, Math.floor((Date.now() - oldestEpoch) / 86_400_000));
  const totalChars = items.reduce((sum, i) =>
    sum + (i.title?.length ?? 0) + (i.text?.length ?? 0) +
    (i.facts?.join('').length ?? 0) + (i.concepts?.join('').length ?? 0), 0);

  return {
    observation_count: items.length,
    session_count: agentSources.size,
    timeline_depth_days: timelineDepthDays,
    has_session_summary: false,
    obs_type_bugfix: typeCounts.bugfix,
    obs_type_discovery: typeCounts.discovery,
    obs_type_decision: typeCounts.decision,
    obs_type_refactor: typeCounts.refactor,
    obs_type_other: typeCounts.other,
    tokens_injected: Math.ceil(totalChars / 4),
    tokens_saved_vs_naive: 0,
    search_strategy: 'memory_items',
    memory_source: 'memory_items',
    agent_count: agentSources.size,
  };
}
```

- [ ] Update `generateContextWithStats` in `ContextBuilder.ts`. Replace the `try` block (starting around line 183) with the new version that tries `memory_items` first:

Replace:
```typescript
  try {
    const observations = projects.length > 1
      ? queryObservationsMulti(db, projects, config)
      : queryObservations(db, project, config);
    const summaries = projects.length > 1
      ? querySummariesMulti(db, projects, config)
      : querySummaries(db, project, config);

    if (observations.length === 0 && summaries.length === 0) {
      return { text: renderEmptyState(project, forHuman), stats: null };
    }

    const output = buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      forHuman
    );

    return { text: output, stats: buildInjectStats(observations, summaries, Boolean(input?.full)) };
  } finally {
    db.close();
  }
```

With:
```typescript
  try {
    const compiled = compileMemoryContext(db.db, cwd, project, config.totalObservationCount);

    if (compiled.source === 'memory_items') {
      const tokenBudget = 2000;
      const text = renderMemoryContext(compiled.items, compiled.projectName, tokenBudget, forHuman);
      if (!text) return { text: renderEmptyState(project, forHuman), stats: null };
      return { text, stats: buildMemoryInjectStats(compiled.items) };
    }

    // Legacy fallback
    const observations = projects.length > 1
      ? queryObservationsMulti(db, projects, config)
      : queryObservations(db, project, config);
    const summaries = projects.length > 1
      ? querySummariesMulti(db, projects, config)
      : querySummaries(db, project, config);

    if (observations.length === 0 && summaries.length === 0) {
      return { text: renderEmptyState(project, forHuman), stats: null };
    }

    const output = buildContextOutput(
      project,
      observations,
      summaries,
      config,
      cwd,
      input?.session_id,
      forHuman
    );

    return {
      text: output,
      stats: {
        ...buildInjectStats(observations, summaries, Boolean(input?.full)),
        memory_source: 'legacy',
        agent_count: 1,
      },
    };
  } finally {
    db.close();
  }
```

- [ ] Commit:

```
git add src/services/context/ContextBuilder.ts
git commit -m "feat(context): wire MemoryContextCompiler and MemoryContextRenderer into ContextBuilder"
```

---

### Task 5: Verification

**Files:**
- Run all relevant test files
- Run root typecheck

- [ ] Run the full relevant test suite:

```
bun test tests/storage/sqlite/observation-backfill.test.ts tests/storage/sqlite/agent-memory-ingest.test.ts tests/services/context/memory-context-compiler.test.ts tests/services/context/memory-context-renderer.test.ts
```

Expected: all pass, 0 fail

- [ ] Run root typecheck:

```
npm run typecheck:root
```

Expected: no output (zero errors)

- [ ] If typecheck reports errors on `buildInjectStats` callers that don't have `memory_source`/`agent_count` — the legacy path already spreads the stats with those two fields added. Check if any other callers of `buildInjectStats` exist:

```
grep -r "buildInjectStats" src/
```

If other callers exist outside `ContextBuilder.ts`, they will need the same spread:
```typescript
{ ...buildInjectStats(...), memory_source: 'legacy', agent_count: 1 }
```

- [ ] Commit verification results and any typecheck fixes:

```
git add -A
git commit -m "fix(context): resolve typecheck errors in ContextBuilder stats callers"
```

(Only if there are fixes. Skip if no changes.)

- [ ] Push:

```
git push origin main
```
