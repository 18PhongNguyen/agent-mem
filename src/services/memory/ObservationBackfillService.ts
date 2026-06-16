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
