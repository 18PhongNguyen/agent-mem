# Agent Neutral Memory Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first agent-neutral memory ingest path so Claude Code, Codex, Gemini, Cursor, Windsurf, and future server clients can write to one shared `memory_items` store.

**Architecture:** Add an additive service that normalizes incoming agent events into canonical project/session/event/memory records. Keep legacy `observations` untouched, but make `memory_items` usable as the shared memory source of truth for new integrations. Preserve server/team scale-out by putting agent attribution, source IDs, and remote-ready metadata on the canonical records instead of in adapter-specific tables.

**Tech Stack:** TypeScript, Bun test, SQLite server-owned repositories, Zod schemas.

---

### Task 1: Canonical Ingest Service

**Files:**
- Create: `src/services/memory/AgentMemoryIngestService.ts`
- Modify: `src/storage/sqlite/projects.ts`
- Modify: `src/storage/sqlite/server-sessions.ts`
- Modify: `src/storage/sqlite/agent-events.ts`
- Modify: `src/storage/sqlite/index.ts`
- Test: `tests/storage/sqlite/agent-memory-ingest.test.ts`

- [x] Write failing tests showing one Codex event creates/reuses a project and session, writes `agent_events`, creates a searchable `memory_items` row, and stores agent/platform attribution in metadata.
- [x] Run the focused test and confirm it fails because the service does not exist.
- [x] Add repository helpers for project/session upsert and platform source persistence.
- [x] Implement `AgentMemoryIngestService.ingestMemory()` with idempotent source handling through `memory_sources.source_uri`.
- [x] Run the focused test and confirm it passes.

### Task 2: Scale-To-Server Compatibility

**Files:**
- Modify: `src/services/memory/AgentMemoryIngestService.ts`
- Test: `tests/storage/sqlite/agent-memory-ingest.test.ts`

- [x] Write failing tests showing the ingest request accepts remote-ready metadata (`actor`, `teamId`, `workspaceId`) without changing the storage contract.
- [x] Run the focused test and confirm it fails for missing metadata handling.
- [x] Add metadata threading to project, session, event, memory item, and memory source records.
- [x] Run the focused test and confirm it passes.

### Task 3: Verification

**Files:**
- Run focused storage tests.
- Run root typecheck if dependencies permit.

- [x] Run `bun test tests/storage/sqlite/server-storage.test.ts tests/storage/sqlite/agent-memory-ingest.test.ts`.
- [x] Run `npm run typecheck:root`.
- [x] Report exact verification results and any environmental blockers.
