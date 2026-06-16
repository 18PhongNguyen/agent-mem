// SPDX-License-Identifier: Apache-2.0

import type { MemoryItem } from '../../../core/schemas/memory-item.js';
import { CHARS_PER_TOKEN_ESTIMATE } from '../types.js';

const MAX_DISPLAY_ITEMS = 10;

function formatRelativeTime(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffHours = Math.floor(diffMs / 3_600_000);
  if (diffHours < 1) return 'just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function renderMemoryContext(
  items: MemoryItem[],
  projectName: string,
  tokenBudget: number,
  _forHuman: boolean
): string {
  if (items.length === 0) return '';

  const agentSources = new Set(
    items
      .map(i => (i.metadata as Record<string, unknown>)?.platformSource as string)
      .filter(Boolean)
  );
  const agentCount = agentSources.size || 1;
  const lastUpdated = formatRelativeTime(items[0].createdAtEpoch);
  const displayName = projectName.split('/').pop() ?? projectName;

  const border = '═'.repeat(52);
  const headerLines = [
    `╔══ Project Memory: ${displayName} ${'═'.repeat(Math.max(0, 32 - displayName.length))}╗`,
    `║ ${items.length} ${items.length === 1 ? 'memory' : 'memories'} · ${agentCount} agent${agentCount !== 1 ? 's' : ''} · last updated ${lastUpdated}`,
    `╚${border}╝`,
    '',
  ];

  let tokenCount = estimateTokens(headerLines.join('\n'));
  const bodyLines: string[] = [];
  let shown = 0;

  for (const item of items.slice(0, MAX_DISPLAY_ITEMS)) {
    const meta = (item.metadata ?? {}) as Record<string, unknown>;
    const platform = (meta.platformSource as string | undefined) ?? 'unknown';
    const date = formatDate(item.createdAtEpoch);
    const entry: string[] = [];

    entry.push(`[${platform}] ${date} · ${item.type}`);
    if (item.title) entry.push(`  ${item.title}`);
    if (item.facts && item.facts.length > 0) entry.push(`  Facts: ${item.facts.join(' · ')}`);
    if (item.filesModified && item.filesModified.length > 0) entry.push(`  Files: ${item.filesModified.join(', ')}`);
    if (item.concepts && item.concepts.length > 0) entry.push(`  Concepts: ${item.concepts.join(', ')}`);
    entry.push('');

    const entryTokens = estimateTokens(entry.join('\n'));
    if (tokenCount + entryTokens > tokenBudget) break;

    bodyLines.push(...entry);
    tokenCount += entryTokens;
    shown++;
  }

  const remaining = items.length - shown;
  const footer = remaining > 0
    ? [`─── ${remaining} earlier ${remaining === 1 ? 'memory' : 'memories'} (/memory full to expand) ───`]
    : [];

  return [...headerLines, ...bodyLines, ...footer].join('\n').trimEnd();
}
