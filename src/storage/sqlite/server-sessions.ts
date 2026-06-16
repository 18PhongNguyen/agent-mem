// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import { CreateServerSessionSchema, ServerSessionSchema, type CreateServerSession, type ServerSession, type ServerSessionStatus } from '../../core/schemas/session.js';
import { ensureServerStorageSchema } from './schema.js';
import { parseJsonObject, stringifyJson } from './serde.js';

interface ServerSessionRow {
  id: string;
  project_id: string;
  content_session_id: string | null;
  memory_session_id: string | null;
  platform_source: string;
  title: string | null;
  status: ServerSessionStatus;
  metadata: string;
  started_at_epoch: number;
  completed_at_epoch: number | null;
  updated_at_epoch: number;
}

function mapServerSessionRow(row: ServerSessionRow): ServerSession {
  return ServerSessionSchema.parse({
    id: row.id,
    projectId: row.project_id,
    contentSessionId: row.content_session_id,
    memorySessionId: row.memory_session_id,
    platformSource: row.platform_source,
    title: row.title,
    status: row.status,
    metadata: parseJsonObject(row.metadata),
    startedAtEpoch: row.started_at_epoch,
    completedAtEpoch: row.completed_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  });
}

export class ServerSessionsRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  create(input: CreateServerSession): ServerSession {
    const session = CreateServerSessionSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO server_sessions (
        id, project_id, content_session_id, memory_session_id, platform_source,
        title, status, metadata, started_at_epoch, completed_at_epoch, updated_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      session.projectId,
      session.contentSessionId ?? null,
      session.memorySessionId ?? null,
      session.platformSource ?? 'claude',
      session.title ?? null,
      'active',
      stringifyJson(session.metadata),
      now,
      null,
      now
    );

    return this.getById(id)!;
  }

  upsertActive(input: CreateServerSession): ServerSession {
    const session = CreateServerSessionSchema.parse(input);
    const platformSource = session.platformSource ?? 'claude';
    const existing = this.findActive({
      projectId: session.projectId,
      platformSource,
      contentSessionId: session.contentSessionId ?? null,
      memorySessionId: session.memorySessionId ?? null,
    });

    if (!existing) {
      return this.create({
        ...session,
        platformSource,
      });
    }

    const now = Date.now();
    this.db.prepare(`
      UPDATE server_sessions
      SET
        content_session_id = ?,
        memory_session_id = ?,
        title = ?,
        metadata = ?,
        updated_at_epoch = ?
      WHERE id = ?
    `).run(
      session.contentSessionId ?? existing.contentSessionId,
      session.memorySessionId ?? existing.memorySessionId,
      session.title ?? existing.title,
      stringifyJson({
        ...existing.metadata,
        ...session.metadata,
      }),
      now,
      existing.id,
    );

    return this.getById(existing.id)!;
  }

  markCompleted(id: string, completedAtEpoch = Date.now()): ServerSession | null {
    this.db.prepare(`
      UPDATE server_sessions
      SET status = 'completed', completed_at_epoch = ?, updated_at_epoch = ?
      WHERE id = ?
    `).run(completedAtEpoch, completedAtEpoch, id);

    return this.getById(id);
  }

  getById(id: string): ServerSession | null {
    const row = this.db.prepare('SELECT * FROM server_sessions WHERE id = ?').get(id) as ServerSessionRow | null;
    return row ? mapServerSessionRow(row) : null;
  }

  getByMemorySessionId(memorySessionId: string): ServerSession | null {
    const row = this.db.prepare('SELECT * FROM server_sessions WHERE memory_session_id = ? ORDER BY started_at_epoch DESC LIMIT 1').get(memorySessionId) as ServerSessionRow | null;
    return row ? mapServerSessionRow(row) : null;
  }

  findActive(input: {
    projectId: string;
    platformSource: string;
    contentSessionId?: string | null;
    memorySessionId?: string | null;
  }): ServerSession | null {
    if (input.memorySessionId) {
      const row = this.db.prepare(`
        SELECT * FROM server_sessions
        WHERE project_id = ? AND platform_source = ? AND memory_session_id = ? AND status = 'active'
        ORDER BY started_at_epoch DESC
        LIMIT 1
      `).get(input.projectId, input.platformSource, input.memorySessionId) as ServerSessionRow | null;
      if (row) return mapServerSessionRow(row);
    }

    if (input.contentSessionId) {
      const row = this.db.prepare(`
        SELECT * FROM server_sessions
        WHERE project_id = ? AND platform_source = ? AND content_session_id = ? AND status = 'active'
        ORDER BY started_at_epoch DESC
        LIMIT 1
      `).get(input.projectId, input.platformSource, input.contentSessionId) as ServerSessionRow | null;
      if (row) return mapServerSessionRow(row);
    }

    return null;
  }

  listByProject(projectId: string): ServerSession[] {
    const rows = this.db.prepare('SELECT * FROM server_sessions WHERE project_id = ? ORDER BY started_at_epoch DESC').all(projectId) as ServerSessionRow[];
    return rows.map(mapServerSessionRow);
  }
}
