// tests/servers/mcp-memory-save.test.ts
import { describe, expect, it } from 'bun:test';
import { memorySaveToolDefinition, createMemorySaveHandler } from '../../src/servers/tools/memory-save.js';

describe('memorySaveToolDefinition', () => {
  it('has name memory_save', () => {
    expect(memorySaveToolDefinition.name).toBe('memory_save');
  });

  it('requires platformSource, agentId, projectName, rootPath, and type', () => {
    const required = memorySaveToolDefinition.inputSchema.required ?? [];
    expect(required).toContain('platformSource');
    expect(required).toContain('agentId');
    expect(required).toContain('projectName');
    expect(required).toContain('rootPath');
    expect(required).toContain('type');
  });

  it('lists optional fields in properties', () => {
    const props = Object.keys(memorySaveToolDefinition.inputSchema.properties);
    expect(props).toContain('title');
    expect(props).toContain('text');
    expect(props).toContain('facts');
    expect(props).toContain('concepts');
    expect(props).toContain('filesModified');
    expect(props).toContain('sessionId');
  });
});

describe('createMemorySaveHandler', () => {
  it('calls postFn with /api/memory/ingest and the full args object', async () => {
    const calls: Array<{ endpoint: string; body: Record<string, unknown> }> = [];

    const mockPostFn = async (endpoint: string, body: Record<string, unknown>) => {
      calls.push({ endpoint, body });
      return { content: [{ type: 'text' as const, text: '{"success":true}' }] };
    };

    const handler = createMemorySaveHandler(mockPostFn);
    const args = {
      platformSource: 'codex',
      agentId: 'codex/main',
      projectName: 'my-org/repo',
      rootPath: '/home/user/repo',
      type: 'decision',
      title: 'Test decision',
    };

    await handler(args);

    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe('/api/memory/ingest');
    expect(calls[0].body).toEqual(args);
  });

  it('returns isError true when postFn returns error content', async () => {
    const mockPostFn = async (_endpoint: string, _body: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'Worker error' }],
      isError: true as const,
    });

    const handler = createMemorySaveHandler(mockPostFn);
    const result = await handler({ platformSource: 'codex', agentId: 'x', projectName: 'p', rootPath: '/p', type: 'decision' });

    expect(result.isError).toBe(true);
  });
});
