import { beforeEach, describe, expect, test } from 'bun:test';

import { useFeatureFlagsStore } from './useFeatureFlagsStore';

const resetStore = () => {
  useFeatureFlagsStore.setState({
    planModeEnabled: false,
    hostPlanModeEnabled: false,
    planModeSwitchOn: false,
    composerRestoreAgentBySession: {},
  });
};

describe('useFeatureFlagsStore plan mode gate', () => {
  beforeEach(resetStore);

  test('the host capability alone opens the gate', () => {
    useFeatureFlagsStore.getState().setPlanModeEnabled(true);

    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
    expect(useFeatureFlagsStore.getState().planModeSwitchOn).toBe(false);
  });

  test('the user switch alone opens the gate', () => {
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(true);

    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
    expect(useFeatureFlagsStore.getState().hostPlanModeEnabled).toBe(false);
  });

  test('turning the switch off leaves a host-enabled gate open', () => {
    useFeatureFlagsStore.getState().setPlanModeEnabled(true);
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(true);
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(false);

    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
    expect(useFeatureFlagsStore.getState().planModeSwitchOn).toBe(false);
  });

  test('a host that turns the capability off does not close the user switch', () => {
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(true);
    useFeatureFlagsStore.getState().setPlanModeEnabled(true);
    useFeatureFlagsStore.getState().setPlanModeEnabled(false);

    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(true);
    expect(useFeatureFlagsStore.getState().planModeSwitchOn).toBe(true);
  });

  test('the gate closes only when both are off', () => {
    useFeatureFlagsStore.getState().setPlanModeEnabled(true);
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(true);
    useFeatureFlagsStore.getState().setPlanModeEnabled(false);
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(false);

    expect(useFeatureFlagsStore.getState().planModeEnabled).toBe(false);
  });

  test('setting the same value twice keeps the state object identical', () => {
    useFeatureFlagsStore.getState().setPlanModeSwitchOn(true);
    const first = useFeatureFlagsStore.getState();

    first.setPlanModeSwitchOn(true);

    expect(useFeatureFlagsStore.getState()).toBe(first);
  });
});

describe('useFeatureFlagsStore composer restore memory', () => {
  beforeEach(resetStore);

  test('remembers the agent per session', () => {
    const { rememberComposerRestoreAgent } = useFeatureFlagsStore.getState();

    rememberComposerRestoreAgent('session-a', '工作');
    rememberComposerRestoreAgent('session-b', 'build');

    expect(useFeatureFlagsStore.getState().composerRestoreAgentBySession).toEqual({
      'session-a': '工作',
      'session-b': 'build',
    });
  });

  test('overwrites and clears an entry', () => {
    const { rememberComposerRestoreAgent } = useFeatureFlagsStore.getState();

    rememberComposerRestoreAgent('session-a', 'build');
    rememberComposerRestoreAgent('session-a', '工作');
    expect(useFeatureFlagsStore.getState().composerRestoreAgentBySession['session-a']).toBe('工作');

    rememberComposerRestoreAgent('session-a', null);
    expect(useFeatureFlagsStore.getState().composerRestoreAgentBySession).toEqual({});
  });

  test('a repeated write keeps the state object identical', () => {
    useFeatureFlagsStore.getState().rememberComposerRestoreAgent('session-a', 'build');
    const first = useFeatureFlagsStore.getState();

    first.rememberComposerRestoreAgent('session-a', 'build');

    expect(useFeatureFlagsStore.getState()).toBe(first);
  });
});
