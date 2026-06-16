// SPDX-License-Identifier: Apache-2.0

import { Database } from 'bun:sqlite';
import type { MemoryItem } from '../../core/schemas/memory-item.js';
import { MemoryItemsRepository, ProjectsRepository } from '../../storage/sqlite/index.js';
import { ensureServerStorageSchema } from '../../storage/sqlite/schema.js';
import { ObservationBackfillService } from '../memory/ObservationBackfillService.js';

export type MemoryCompilerResult =
  | { source: 'memory_items'; items: MemoryItem[]; projectName: string }
  | { source: 'legacy' };

export function compileMemoryContext(
  db: Database,
  cwd: string,
  projectName: string,
  limit: number
): MemoryCompilerResult {
  ensureServerStorageSchema(db);

  const projectsRepo = new ProjectsRepository(db);
  let project = projectsRepo.getByRootPath(cwd);

  if (!project) {
    const backfill = new ObservationBackfillService(db);
    const result = backfill.backfill(projectName, cwd);
    if (result.migrated === 0 && result.skipped === 0) {
      return { source: 'legacy' };
    }
    project = projectsRepo.getByRootPath(cwd);
  }

  if (!project) return { source: 'legacy' };

  const memoriesRepo = new MemoryItemsRepository(db);
  const items = memoriesRepo.listByProject(project.id, limit);

  if (items.length === 0) return { source: 'legacy' };

  return { source: 'memory_items', items, projectName };
}
