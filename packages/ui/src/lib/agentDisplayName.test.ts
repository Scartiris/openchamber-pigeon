import { describe, expect, test } from 'bun:test';

import { agentBuiltinLabelKey, formatAgentDisplayName } from './agentDisplayName';

describe('formatAgentDisplayName', () => {
  test('maps built-in agents to localized labels without changing the id', () => {
    expect(formatAgentDisplayName('build', '构建')).toBe('构建');
    expect(formatAgentDisplayName('plan', '计划')).toBe('计划');
    expect(formatAgentDisplayName('chat', '聊天')).toBe('聊天');
  });

  test('falls back to capitalizing when the key is missing / untranslated', () => {
    expect(formatAgentDisplayName('reviewer', agentBuiltinLabelKey('reviewer'))).toBe('Reviewer');
    expect(formatAgentDisplayName('build', '')).toBe('Build');
  });
});
