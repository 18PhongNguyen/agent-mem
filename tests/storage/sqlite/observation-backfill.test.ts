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
