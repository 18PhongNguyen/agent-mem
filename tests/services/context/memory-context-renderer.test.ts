// tests/services/context/memory-context-renderer.test.ts
import { describe, expect, it } from 'bun:test';
import { renderMemoryContext } from '../../../src/services/context/sections/MemoryContextRenderer.js';
import type { MemoryItem } from '../../../src/core/schemas/memory-item.js';

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'item-1',
    projectId: 'proj-1',
    serverSessionId: null,
    legacyObservationId: null,
    kind: 'observation',
    type: 'decision',
    title: 'Test title',
    subtitle: null,
    text: null,
    narrative: null,
    facts: ['fact one'],
    concepts: ['shared-mem'],
    filesRead: [],
    filesModified: ['src/foo.ts'],
    metadata: { platformSource: 'codex', agentId: 'codex/main' },
    createdAtEpoch: Date.now() - 3_600_000,
    updatedAtEpoch: Date.now() - 3_600_000,
    ...overrides,
  };
}

describe('renderMemoryContext', () => {
  it('renders header with memory count and agent count', () => {
    const item1 = makeItem({ metadata: { platformSource: 'codex' } });
    const item2 = makeItem({ id: 'item-2', metadata: { platformSource: 'claude-code' }, title: 'Other title' });
    const output = renderMemoryContext([item1, item2], 'parent/myproject', 99999, false);

    expect(output).toContain('Project Memory: myproject');
    expect(output).toContain('2 memories');
    expect(output).toContain('2 agents');
  });

  it('renders platform source label on each entry', () => {
    const output = renderMemoryContext([makeItem()], 'parent/proj', 99999, false);
    expect(output).toContain('[codex]');
  });

  it('renders title, facts, files, and concepts', () => {
    const output = renderMemoryContext([makeItem()], 'parent/proj', 99999, false);
    expect(output).toContain('Test title');
    expect(output).toContain('fact one');
    expect(output).toContain('src/foo.ts');
    expect(output).toContain('shared-mem');
  });

  it('caps output at token budget and shows remaining count', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `item-${i}`, title: `Title ${i}` })
    );
    // Very small budget — only a few items should fit
    const output = renderMemoryContext(items, 'parent/proj', 200, false);
    expect(output).toContain('earlier memories');
  });

  it('returns empty string for empty items array', () => {
    expect(renderMemoryContext([], 'parent/proj', 99999, false)).toBe('');
  });
});
