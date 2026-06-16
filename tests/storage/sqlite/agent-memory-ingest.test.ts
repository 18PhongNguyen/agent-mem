import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { AgentMemoryIngestService } from '../../../src/services/memory/AgentMemoryIngestService.js';
import {
  AgentEventsRepository,
  MemoryItemsRepository,
  ProjectsRepository,
  ServerSessionsRepository,
} from '../../../src/storage/sqlite/index.js';

function withDb(fn: (db: Database) => void): void {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe('agent-neutral memory ingest', () => {
  it('normalizes an agent event into shared project, session, event, and memory records', () => {
    withDb(db => {
      const service = new AgentMemoryIngestService(db);

      const result = service.ingestMemory({
        platformSource: 'codex-cli',
        agentId: 'codex/default',
        agentType: 'coding-agent',
        project: {
          name: 'Agent Mem',
          rootPath: 'D:/Agent-mem',
          slug: 'agent-mem',
        },
        session: {
          contentSessionId: 'codex-chat-1',
          memorySessionId: 'shared-memory-1',
          title: 'Implement shared memory',
        },
        event: {
          sourceType: 'api',
          eventType: 'memory.observation',
          occurredAtEpoch: 1771050000000,
          payload: {
            toolName: 'shell',
            command: 'bun test',
          },
        },
        memory: {
          kind: 'observation',
          type: 'decision',
          title: 'Use memory_items as shared memory core',
          text: 'Agent-neutral ingest writes canonical memory items for all coding agents.',
          facts: ['memory_items is the new shared store'],
          concepts: ['shared-memory', 'agent-neutral'],
          filesModified: ['src/services/memory/AgentMemoryIngestService.ts'],
        },
        source: {
          sourceUri: 'agent://codex/default/codex-chat-1/1',
        },
        actor: {
          type: 'agent',
          id: 'codex/default',
        },
        teamId: 'team-local',
        workspaceId: 'workspace-local',
      });

      const projects = new ProjectsRepository(db);
      const sessions = new ServerSessionsRepository(db);
      const events = new AgentEventsRepository(db);
      const memories = new MemoryItemsRepository(db);

      const project = projects.getByRootPath('D:/Agent-mem');
      expect(project?.id).toBe(result.project.id);
      expect(project?.metadata.teamId).toBe('team-local');

      const session = sessions.getByMemorySessionId('shared-memory-1');
      expect(session?.id).toBe(result.session.id);
      expect(session?.platformSource).toBe('codex');
      expect(session?.metadata.agentId).toBe('codex/default');

      const storedEvent = events.getById(result.event.id);
      expect(storedEvent?.platformSource).toBe('codex');
      expect(storedEvent?.serverSessionId).toBe(session?.id);
      expect(storedEvent?.payload).toMatchObject({
        platformSource: 'codex',
        agentId: 'codex/default',
        actor: { type: 'agent', id: 'codex/default' },
      });

      const storedMemory = memories.getById(result.memory.id);
      expect(storedMemory?.projectId).toBe(project?.id);
      expect(storedMemory?.serverSessionId).toBe(session?.id);
      expect(storedMemory?.metadata).toMatchObject({
        platformSource: 'codex',
        agentId: 'codex/default',
        agentType: 'coding-agent',
        teamId: 'team-local',
        workspaceId: 'workspace-local',
      });
      expect(memories.search(project!.id, 'agent-neutral').map(item => item.id)).toContain(result.memory.id);
    });
  });

  it('is idempotent for repeated source URIs from the same agent event', () => {
    withDb(db => {
      const service = new AgentMemoryIngestService(db);
      const request = {
        platformSource: 'Claude Code',
        agentId: 'claude/main',
        project: {
          name: 'Agent Mem',
          rootPath: 'D:/Agent-mem',
        },
        session: {
          contentSessionId: 'claude-session-1',
        },
        event: {
          sourceType: 'hook' as const,
          eventType: 'memory.observation',
          occurredAtEpoch: 1771050000000,
          payload: {},
        },
        memory: {
          kind: 'observation' as const,
          type: 'decision',
          title: 'Keep one canonical memory row per event source',
        },
        source: {
          sourceUri: 'agent://claude/main/claude-session-1/tool-1',
        },
      };

      const first = service.ingestMemory(request);
      const second = service.ingestMemory(request);

      const memories = new MemoryItemsRepository(db);
      const sources = memories.listSources(first.memory.id);
      expect(second.memory.id).toBe(first.memory.id);
      expect(memories.listByProject(first.project.id, 10)).toHaveLength(1);
      expect(sources).toHaveLength(1);
      expect(sources[0]?.sourceUri).toBe('agent://claude/main/claude-session-1/tool-1');
    });
  });
});
