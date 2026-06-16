// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import type { AgentEvent, AgentEventSourceType } from '../../core/schemas/agent-event.js';
import type { MemoryItem, MemoryItemKind } from '../../core/schemas/memory-item.js';
import type { Project } from '../../core/schemas/project.js';
import type { ServerSession } from '../../core/schemas/session.js';
import {
  AgentEventsRepository,
  MemoryItemsRepository,
  ProjectsRepository,
  ServerSessionsRepository,
} from '../../storage/sqlite/index.js';

export interface IngestMemoryRequest {
  platformSource: string;
  agentId: string;
  agentType?: string;
  project: {
    name: string;
    rootPath?: string;
    slug?: string;
  };
  session: {
    contentSessionId?: string;
    memorySessionId?: string;
    title?: string;
  };
  event: {
    sourceType: AgentEventSourceType;
    eventType: string;
    occurredAtEpoch: number;
    payload?: Record<string, unknown>;
  };
  memory: {
    kind: MemoryItemKind;
    type: string;
    title?: string;
    text?: string;
    facts?: string[];
    concepts?: string[];
    filesModified?: string[];
  };
  source: {
    sourceUri: string;
  };
  actor?: {
    type: string;
    id: string;
  };
  teamId?: string;
  workspaceId?: string;
}

export interface IngestMemoryResult {
  project: Project;
  session: ServerSession;
  event: AgentEvent;
  memory: MemoryItem;
}

function normalizePlatformSource(raw: string): string {
  return raw.split(/[-\s]/)[0].toLowerCase();
}

export class AgentMemoryIngestService {
  private projects: ProjectsRepository;
  private sessions: ServerSessionsRepository;
  private events: AgentEventsRepository;
  private memories: MemoryItemsRepository;

  constructor(db: Database) {
    this.projects = new ProjectsRepository(db);
    this.sessions = new ServerSessionsRepository(db);
    this.events = new AgentEventsRepository(db);
    this.memories = new MemoryItemsRepository(db);
  }

  ingestMemory(request: IngestMemoryRequest): IngestMemoryResult {
    const platformSource = normalizePlatformSource(request.platformSource);

    const project = this.projects.upsertByIdentity({
      name: request.project.name,
      slug: request.project.slug,
      rootPath: request.project.rootPath,
      metadata: {
        ...(request.teamId ? { teamId: request.teamId } : {}),
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      },
    });

    const session = this.sessions.upsertActive({
      projectId: project.id,
      contentSessionId: request.session.contentSessionId,
      memorySessionId: request.session.memorySessionId,
      platformSource,
      title: request.session.title,
      metadata: {
        agentId: request.agentId,
        ...(request.agentType ? { agentType: request.agentType } : {}),
      },
    });

    const event = this.events.create({
      projectId: project.id,
      serverSessionId: session.id,
      sourceType: request.event.sourceType,
      eventType: request.event.eventType,
      platformSource,
      payload: {
        ...(request.event.payload ?? {}),
        platformSource,
        agentId: request.agentId,
        ...(request.actor ? { actor: request.actor } : {}),
      },
      contentSessionId: request.session.contentSessionId,
      memorySessionId: request.session.memorySessionId,
      occurredAtEpoch: request.event.occurredAtEpoch,
    });

    const existingSource = this.memories.getSourceByUri(request.source.sourceUri);
    if (existingSource) {
      const existingMemory = this.memories.getById(existingSource.memoryItemId)!;
      return { project, session, event, memory: existingMemory };
    }

    const memory = this.memories.create({
      projectId: project.id,
      serverSessionId: session.id,
      kind: request.memory.kind,
      type: request.memory.type,
      title: request.memory.title,
      text: request.memory.text,
      facts: request.memory.facts,
      concepts: request.memory.concepts,
      filesModified: request.memory.filesModified,
      metadata: {
        platformSource,
        agentId: request.agentId,
        ...(request.agentType ? { agentType: request.agentType } : {}),
        ...(request.teamId ? { teamId: request.teamId } : {}),
        ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      },
    });

    this.memories.addSource({
      memoryItemId: memory.id,
      sourceType: 'import',
      sourceUri: request.source.sourceUri,
    });

    return { project, session, event, memory };
  }
}
