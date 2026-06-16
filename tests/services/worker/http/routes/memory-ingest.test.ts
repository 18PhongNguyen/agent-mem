// tests/services/worker/http/routes/memory-ingest.test.ts
import { describe, expect, it, afterEach, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { ensureServerStorageSchema } from '../../../../../src/storage/sqlite/schema.js';
import { MemoryRoutes } from '../../../../../src/services/worker/http/routes/MemoryRoutes.js';
import { MemoryItemsRepository, ProjectsRepository } from '../../../../../src/storage/sqlite/index.js';
import type { DatabaseManager } from '../../../../../src/services/worker/DatabaseManager.js';

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
