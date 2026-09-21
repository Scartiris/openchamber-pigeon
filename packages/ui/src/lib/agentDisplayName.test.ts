import { describe, expect, test } from 'bun:test';

import { agentBuiltinLabelKey, formatAgentDisplayName } from './agentDisplayName';

describe('formatAgentDisplayName', () => {
  test('maps built-in build to the localized label without changing the id', () => {
    expect(formatAgentDisplayName('build', '构建')).toBe('构建');
  });

  test('falls back to capitalizing when the key is missing / untranslated', () => {
    expect(formatAgentDisplayName('reviewer', agentBuiltinLabelKey('reviewer'))).toBe('Reviewer');
    expect(formatAgentDisplayName('build', '')).toBe('Build');
  });
});
