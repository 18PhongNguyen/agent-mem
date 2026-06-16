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
