/**
 * Map well-known English server/config messages to UI i18n keys.
 * Residual safety net when a backend still returns English.
 */
import type { I18nKey } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n';

const SERVER_MESSAGE_PATTERNS: Array<{ test: RegExp; key: I18nKey }> = [
  { test: /Configuration reloaded successfully/i, key: 'serverMessage.opencode.configReloaded' },
  { test: /Restart your connected OpenCode server/i, key: 'serverMessage.opencode.manualRestart' },
  { test: /Interrupted by OpenCode restart/i, key: 'serverMessage.session.interruptedByRestart' },
  { test: /The running turn was interrupted when OpenCode restarted/i, key: 'serverMessage.session.interruptedByRestartDetail' },
  { test: /Restart OpenCode to apply/i, key: 'serverMessage.opencode.restartToApply' },
  { test: /No skills were installed/i, key: 'serverMessage.opencode.noSkillsInstalled' },
  { test: /Failed to get git status/i, key: 'serverMessage.git.statusFailed' },
  { test: /Failed to get git diff|Failed to get commit diff|Failed to get git file diff/i, key: 'serverMessage.git.diffFailed' },
  { test: /Failed to create commit/i, key: 'gitView.toast.createCommitFailed' },
  { test: /Failed to create branch/i, key: 'gitView.toast.createBranchFailed' },
  { test: /Failed to push/i, key: 'serverMessage.git.pushFailed' },
  { test: /Failed to pull/i, key: 'serverMessage.git.pullFailed' },
  { test: /Failed to stash changes/i, key: 'gitView.stashes.toast.createFailed' },
  { test: /Failed to merge/i, key: 'serverMessage.git.mergeFailed' },
  { test: /Failed to remove remote/i, key: 'serverMessage.git.removeRemoteFailed' },
  { test: /Failed to get branches/i, key: 'serverMessage.git.branchesFailed' },
  { test: /Failed to get remotes/i, key: 'serverMessage.git.remotesFailed' },
  { test: /openviking_not_configured|OpenViking is not configured/i, key: 'settings.openviking.notConfigured.long' },
  { test: /pigeon_brain_not_configured/i, key: 'settings.pigeonBrain.notConfigured.title' },
];

export function localizeServerMessage(
  dictionary: ReturnType<typeof useI18nStore.getState>['dictionary'],
  message: string | null | undefined,
): string | null {
  if (!message) return null;
  for (const pattern of SERVER_MESSAGE_PATTERNS) {
    if (pattern.test.test(message)) {
      return formatMessage(dictionary, pattern.key);
    }
  }
  return message;
}
