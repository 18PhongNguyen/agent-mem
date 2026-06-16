// SPDX-License-Identifier: Apache-2.0

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const memorySaveToolDefinition: McpToolDefinition = {
  name: 'memory_save',
  description:
    'Save a memory to the shared project memory store. All agents reading context from this project will see it. Use after decisions, discoveries, or bugfixes worth remembering across sessions.',
  inputSchema: {
    type: 'object',
    properties: {
      platformSource: {
        type: 'string',
        description: 'Your agent identity: "codex", "cursor", "gemini", "claude-code"',
      },
      agentId: {
        type: 'string',
        description: 'Specific agent instance, e.g. "cursor/default"',
      },
      projectName: {
        type: 'string',
        description: 'Project identifier, e.g. "my-org/my-repo"',
      },
      rootPath: {
        type: 'string',
        description: 'Absolute path to project root, e.g. "/home/user/my-repo"',
      },
      type: {
        type: 'string',
        enum: ['decision', 'bugfix', 'discovery', 'refactor', 'feature', 'change'],
        description: 'Memory type',
      },
      title: { type: 'string' },
      text: { type: 'string', description: 'Narrative / explanation' },
      facts: { type: 'array', items: { type: 'string' } },
      concepts: { type: 'array', items: { type: 'string' } },
      filesModified: { type: 'array', items: { type: 'string' } },
      sessionId: {
        type: 'string',
        description: 'Content session ID from the calling agent',
      },
    },
    required: ['platformSource', 'agentId', 'projectName', 'rootPath', 'type'],
  },
};

type PostFn = (
  endpoint: string,
  body: Record<string, unknown>
) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

export function createMemorySaveHandler(postFn: PostFn) {
  return async (args: unknown) =>
    postFn('/api/memory/ingest', args as Record<string, unknown>);
}
