import { useMemo } from 'react';

import { resolveWorkspaceEntry, type WorkspaceEntry } from '@/lib/workspaceEntry';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Which entry the workbench is showing: 代码 or 工作.
 *
 * Until the user presses the switch, the answer is wherever the session on screen
 * already lives — `null` in the store means "never chosen", and honouring it keeps a
 * reload from showing the code list while a 公文 chat is open. After the first press
 * the choice is the user's and nothing overrides it: the session that follows is
 * picked *by* the entry, so deriving it back from the session would turn a single
 * deep link into a silent partition change.
 */
export const useWorkspaceEntry = (): WorkspaceEntry => {
  const chosen = useSessionDisplayStore((state) => state.workspaceEntry);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);

  return useMemo(
    () => chosen ?? resolveWorkspaceEntry(currentSessionDirectory),
    [chosen, currentSessionDirectory],
  );
};
