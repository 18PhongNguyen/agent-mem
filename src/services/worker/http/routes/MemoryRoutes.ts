
import express, { Request, Response } from 'express';
import { z } from 'zod';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { validateBody } from '../middleware/validateBody.js';
import { logger } from '../../../../utils/logger.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { AgentMemoryIngestService } from '../../../memory/AgentMemoryIngestService.js';

const saveMemorySchema = z.object({
  text: z.string().trim().min(1),
  title: z.string().optional(),
  project: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const VALID_TYPES = ['decision', 'bugfix', 'discovery', 'refactor', 'feature', 'change'] as const;

const ingestMemorySchema = z.object({
  platformSource: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  projectName: z.string().trim().min(1),
  rootPath: z.string().trim().min(1),
  type: z.enum(VALID_TYPES),
  title: z.string().optional(),
  text: z.string().optional(),
  facts: z.array(z.string()).optional(),
  concepts: z.array(z.string()).optional(),
  filesModified: z.array(z.string()).optional(),
  sessionId: z.string().optional(),
}).strict();

export class MemoryRoutes extends BaseRouteHandler {
  constructor(
    private dbManager: DatabaseManager,
    private defaultProject: string
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.post('/api/memory/save', validateBody(saveMemorySchema), this.handleSaveMemory.bind(this));
    app.post('/api/memory/ingest', validateBody(ingestMemorySchema), this.handleIngestMemory.bind(this));
  }

  private handleSaveMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const { text, title, project, metadata } = req.body as z.infer<typeof saveMemorySchema>;
    const explicitProject = typeof project === 'string' && project.trim()
      ? project.trim()
      : undefined;
    const metadataProject = typeof metadata?.project === 'string' && metadata.project.trim()
      ? metadata.project.trim()
      : undefined;
    const targetProject = explicitProject || metadataProject || this.defaultProject;

    const sessionStore = this.dbManager.getSessionStore();
    const chromaSync = this.dbManager.getChromaSync();

    const memorySessionId = sessionStore.getOrCreateManualSession(targetProject);

    const observation = {
      type: 'discovery',  // Use existing valid type
      title: title || text.substring(0, 60).trim() + (text.length > 60 ? '...' : ''),
      subtitle: 'Manual memory',
      facts: [] as string[],
      narrative: text,
      concepts: [] as string[],
      files_read: [] as string[],
      files_modified: [] as string[],
      metadata: metadata ? JSON.stringify(metadata) : null,
    };

    const result = sessionStore.storeObservation(
      memorySessionId,
      targetProject,
      observation,
      0,  // promptNumber
      0   
    );

    logger.info('HTTP', 'Manual observation saved', {
      id: result.id,
      project: targetProject,
      title: observation.title
    });

    if (!chromaSync) {
      logger.debug('CHROMA', 'ChromaDB sync skipped (chromaSync not available)', { id: result.id });
      res.json({
        success: true,
        id: result.id,
        title: observation.title,
        project: targetProject,
        message: `Memory saved as observation #${result.id}`
      });
      return;
    }
    chromaSync.syncObservation(
      result.id,
      memorySessionId,
      targetProject,
      observation,
      0,
      result.createdAtEpoch,
      0
    ).catch(err => {
      logger.error('CHROMA', 'ChromaDB sync failed', { id: result.id }, err as Error);
    });

    res.json({
      success: true,
      id: result.id,
      title: observation.title,
      project: targetProject,
      message: `Memory saved as observation #${result.id}`
    });
  });

  private handleIngestMemory = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    const body = req.body as z.infer<typeof ingestMemorySchema>;

    const db = this.dbManager.getConnection();
    const ingestService = new AgentMemoryIngestService(db);

    const sourceUri = `agent://${body.platformSource}/${body.projectName}/${body.type}/${body.sessionId ?? 'manual'}/${Date.now()}`;

    const result = ingestService.ingestMemory({
      platformSource: body.platformSource,
      agentId: body.agentId,
      project: {
        name: body.projectName,
        rootPath: body.rootPath,
        slug: body.projectName.split('/').pop(),
      },
      session: {
        contentSessionId: body.sessionId,
      },
      event: {
        sourceType: 'api',
        eventType: 'memory.manual',
        occurredAtEpoch: Date.now(),
        payload: {},
      },
      memory: {
        kind: 'observation',
        type: body.type,
        title: body.title,
        text: body.text,
        facts: body.facts,
        concepts: body.concepts,
        filesModified: body.filesModified,
      },
      source: { sourceUri },
    });

    logger.info('HTTP', 'Memory ingested via MCP', {
      id: result.memory.id,
      project: body.projectName,
      platformSource: body.platformSource,
    });

    res.json({
      success: true,
      id: result.memory.id,
      projectId: result.project.id,
      title: result.memory.title ?? body.type,
    });
  });
}
