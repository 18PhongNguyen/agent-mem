# Agent-Neutral Memory Read Path Design

**Date:** 2026-06-16
**Status:** Approved
**Scope:** Replace legacy `observations`-based context injection with a new `memory_items`-based read path, enabling true cross-agent memory sharing across Claude Code, Codex, Cursor, Gemini, and Windsurf within the same project.

---

## Background

The write path is complete: `AgentMemoryIngestService` normalises events from any agent into canonical `memory_items` records in `~/.claude-mem/claude-mem.db`. The read path (`ContextBuilder`) still reads exclusively from the legacy `observations` table, so memories written by one agent are invisible to all others.

---

## Goals

- All agents working on the same project share one memory store (`memory_items`)
- Context format is redesigned around the richer `memory_items` schema (agent attribution, concepts, filesModified)
- Existing `observations` data is preserved and backfilled into `memory_items` — no data loss
- `generateContext()` / `generateContextWithStats()` signatures are unchanged — zero breakage for callers

## Non-Goals

- Migrating `summaries` → `memory_items` (deferred)
- Changing the hook API or agent adapters
- Postgres / server-beta path (SQLite only)

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│               ~/.claude-mem/claude-mem.db            │
│  ┌──────────────┐          ┌──────────────────────┐  │
│  │ observations │──backfill─▶│   memory_items       │  │
│  │  (legacy)    │          │   (primary)          │  │
│  └──────────────┘          └──────────────────────┘  │
└─────────────────────────────────────────────────────┘
        ↑ fallback only                 ↑ primary
        │                               │
        └──── MemoryContextCompiler ────┘
                       │
               MemoryContextRenderer
               (rich format, agent-attributed)
                       │
           /api/context/inject  (unchanged endpoint)
                       │
           contextHandler → agent additionalContext
```

---

## Component 1: ObservationBackfillService

**File:** `src/services/memory/ObservationBackfillService.ts`

One-shot, idempotent migration that reads the legacy `observations` table and writes each row into `memory_items` via `AgentMemoryIngestService`.

**Trigger:** Called by `MemoryContextCompiler` before the first context query for a project, when the project has `observations` but zero `memory_items`. Runs async — the first response may still use the legacy fallback; subsequent responses use `memory_items`.

**Field mapping:**

| `observations` | `IngestMemoryRequest` |
|---|---|
| `project` (string) | `project.slug` + `project.rootPath` via `getProjectContext(cwd)` |
| `type` | `memory.type` |
| `title` | `memory.title` |
| `narrative` | `memory.text` |
| `facts` (JSON string) | `memory.facts` |
| `concepts` (JSON string) | `memory.concepts` |
| `files_modified` (JSON string) | `memory.filesModified` |
| `platform_source` (via sdk_sessions join) | `platformSource` |
| `memory_session_id` | `session.memorySessionId` |
| `created_at_epoch` | `event.occurredAtEpoch` |

**Idempotency:** `source_uri = 'legacy://observations/<id>'` written to `memory_sources`. The unique index `ux_memory_sources_source_uri` guarantees re-runs are safe.

**Not backfilled:** `summaries` — deferred to a future task.

---

## Component 2: MemoryContextCompiler

**File:** `src/services/context/MemoryContextCompiler.ts`

Query layer replacing `ObservationCompiler`. Returns `MemoryItem[]` plus a `source` discriminant.

**Project resolution:**
```
cwd → ProjectsRepository.getByRootPath(cwd)
      → project.id (UUID)
```
`getByRootPath` is the canonical resolver. `cwd` is always available from `ContextInput` (falls back to `process.cwd()`). No slug-based lookup needed — slug is optional metadata, rootPath is the stable identity key.

**Query strategy:**
`MemoryItemsRepository.listByProject(project.id, limit)` — recent-first. FTS search (`MemoryItemsRepository.search`) is a future enhancement, not part of this implementation.

**Fallback:** If `project` row does not exist or `memory_items` count is zero for the project, return `{ source: 'legacy' }` — caller uses the existing `ObservationCompiler` path unchanged.

**Return type:**
```typescript
type CompilerResult =
  | { source: 'memory_items'; items: MemoryItem[] }
  | { source: 'legacy' };
```

---

## Component 3: MemoryContextRenderer

**File:** `src/services/context/sections/MemoryContextRenderer.ts`

Renders `MemoryItem[]` into the context string injected into agents. Replaces the combination of `TimelineRenderer` + `SummaryRenderer` + `FooterRenderer`.

**Format:**

```
╔══ Project Memory: <project-name> ══════════════════╗
║ <N> memories · <K> agents · last updated <T> ago   ║
╚════════════════════════════════════════════════════╝

[<platformSource>] <date> · <type>
  <title>
  Facts: <fact1> · <fact2>
  Files: <file1>, <file2>
  Concepts: <concept1>, <concept2>

[<platformSource>] <date> · <type>
  ...

─── <M> earlier memories (/memory full to expand) ───
```

**Rules:**
- Items ordered recent-first
- `platformSource` label on every entry — agents see who wrote what
- `facts`, `concepts`, `filesModified` shown when non-empty
- `text` (narrative) shown only for `kind = 'observation'` with non-empty text and within token budget
- Token budget enforced via existing `TokenCalculator` — same cap as legacy path
- Empty state: delegates to existing `renderAgentEmptyState()` / `renderHumanEmptyState()`

---

## Component 4: MemoryContextBuilder (updated generateContextWithStats)

**File:** `src/services/context/ContextBuilder.ts` (modified in-place)

`generateContextWithStats()` is updated to wire the new components while keeping its public signature identical:

```typescript
// New internal flow
const compiled = await MemoryContextCompiler.query(rawDb, cwd, config);

if (compiled.source === 'legacy') {
  // Existing path — unchanged
  return legacyGenerateContext(db, project, config, ...);
}

const text = MemoryContextRenderer.render(compiled.items, projectName, config, forHuman);
const stats = buildMemoryInjectStats(compiled.items);
return { text, stats };
```

**`ContextInjectStats` additions:**
- `memory_source: 'memory_items' | 'legacy'`
- `agent_count: number` (distinct `platformSource` values in the result set)

---

## Data Flow (end-to-end)

```
Agent session starts
  → hook fires contextHandler
  → GET /api/context/inject
  → generateContextWithStats({ cwd })
  → MemoryContextCompiler.query(db, cwd, config)
      → ProjectsRepository.getByRootPath(cwd)  [resolve project UUID]
      → if project missing or memory_items empty:
          trigger ObservationBackfillService.backfill(project) [async]
          return { source: 'legacy' }  [first call may be legacy]
      → MemoryItemsRepository.listByProject(project.id, limit)
      → return { source: 'memory_items', items }
  → MemoryContextRenderer.render(items, ...)
  → text injected as additionalContext into agent
```

---

## Testing

All tests use `new Database(':memory:')` + `ensureServerStorageSchema()`.

| File | Covers |
|---|---|
| `tests/storage/sqlite/observation-backfill.test.ts` | Field mapping, idempotency (double-run produces one `memory_items` row), `source_uri` uniqueness |
| `tests/services/context/memory-context-compiler.test.ts` | Project resolution via rootPath, fallback when project missing, fallback when memory_items empty |
| `tests/services/context/memory-context-renderer.test.ts` | Format correctness, token budget cap, empty state, multi-agent attribution labels |
| `tests/storage/sqlite/agent-memory-ingest.test.ts` | Unchanged — must continue to pass |

---

## Rollout

1. Build and test all 4 components independently
2. Wire `ContextBuilder` to use new path
3. Run full test suite
4. Deploy — first context call per project triggers async backfill; legacy fallback covers the gap
