/**
 * The workbench entry switch: 代码 / 工作.
 *
 * An entry is a *partition of work*, not a mode. It decides which projects the
 * sidebar lists and where a new draft lands; the rule itself is one pure function
 * (`lib/workspaceEntry.ts`), so the switch has no opinion about paths and never
 * touches the agent — the directory already picks that through `project.defaultAgent`.
 * The composer's three positions stay orthogonal: they say how a reply is delivered,
 * this says which kind of work the list is showing.
 *
 * The press also moves the right-hand pane, and that side effect lives *here* rather
 * than in whichever layout hosts the button, because it belongs to the interaction:
 * a full-page surface left open over a list that no longer contains it, or a chat
 * still showing the other partition, both read as "the switch half-worked".
 *
 * It is mounted in the titlebar overlay, not in the sidebar, so it stays reachable
 * with the sidebar collapsed — which is also why the newest session is resolved from
 * the global store instead of the sidebar's computed list (that one does not exist
 * while the sidebar is closed).
 */

import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';

import { SegmentedSlider } from '@/components/ui/segmented-slider';
import { useWorkspaceEntry } from '@/hooks/useWorkspaceEntry';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { resolveProjectForDirectory } from '@/lib/projectResolution';
import {
  ENTRY_ICONS,
  ENTRY_LABEL_KEY,
  ENTRY_ORDER,
  resolveEntryDraftTarget,
  resolveWorkspaceEntry,
  type WorkspaceEntry,
} from '@/lib/workspaceEntry';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * The entry a session belongs to, decided by the project that owns it — the same
 * rule the list uses, so the pane can never land on a session the list beside it
 * will not show. A directory no registered project owns is hidden from the sidebar
 * as well, and answers `null` here for that reason.
 */
const entryOwningSession = (session: Session): WorkspaceEntry | null => {
  const projects = useProjectsStore.getState().projects;
  const owner = resolveProjectForDirectory(projects, resolveGlobalSessionDirectory(session));
  return owner ? resolveWorkspaceEntry(owner.path) : null;
};

const isRootSession = (session: Session): boolean =>
  // SAFETY: OpenCode attaches parentID to hierarchical session records, although
  // the SDK's base Session type does not declare it.
  !(session as Session & { parentID?: string | null }).parentID;

const mostRecentlyUpdated = (sessions: readonly Session[]): Session | null => sessions.reduce<Session | null>(
  (best, session) => (best === null || session.time.updated > best.time.updated ? session : best),
  null,
);

export const WorkspaceEntrySwitch = React.memo(function WorkspaceEntrySwitch() {
  const { t } = useI18n();
  const entry = useWorkspaceEntry();
  const setWorkspaceEntry = useSessionDisplayStore((state) => state.setWorkspaceEntry);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  const handleSelect = React.useCallback((next: WorkspaceEntry) => {
    if (next === entry) return;
    setWorkspaceEntry(next);
    // `closeMainSurfaces` first: it unmounts the very views whose session lists
    // are about to stop containing what they are showing.
    useUIStore.getState().closeMainSurfaces();

    const candidate = mostRecentlyUpdated(
      useGlobalSessionsStore.getState().activeSessions.filter(
        (session) => isRootSession(session) && entryOwningSession(session) === next,
      ),
    );
    if (candidate) {
      // `setCurrentSession` also closes an open draft and moves the active project
      // to the session's owner, so the header, the drawer and the URL agree.
      setCurrentSession(candidate.id, resolveGlobalSessionDirectory(candidate));
      return;
    }

    // An entry with no session yet still has to be enterable: land on a draft in
    // its most recently used project, or — when it owns no project at all — keep
    // the caller's own behaviour by opening a plain draft.
    const target = resolveEntryDraftTarget(useProjectsStore.getState().projects, next);
    openNewSessionDraft(target ?? {});
  }, [entry, openNewSessionDraft, setCurrentSession, setWorkspaceEntry]);

  // VS Code has one workspace and no project registry, so the sidebar lists
  // everything it has whatever the entry says — the bypass the list itself takes.
  // Two stops that cannot change the list would only ever close the surface the
  // press lands on, so the switch is not rendered there at all.
  if (isVSCode) return null;

  return (
    // `data-workspace-entry` is what the mount test and a grep of the shipped bundle
    // read: the entry the workbench is actually showing, not one a component was
    // handed. The wrapper also keeps the control clickable over frameless chrome,
    // which drags everything beneath it.
    <span
      className="app-region-no-drag inline-flex shrink-0"
      data-workspace-entry={entry}
    >
      <SegmentedSlider
        ariaLabel={t('header.workspaceEntry.label')}
        value={entry}
        onChange={handleSelect}
        options={ENTRY_ORDER.map((candidate) => ({
          value: candidate,
          icon: ENTRY_ICONS[candidate],
          // Visible name on the stop: a bare glyph does not say 代码 / 工作.
          // `title` still carries the longer "what choosing this does" hint.
          text: t(ENTRY_LABEL_KEY[candidate]),
          label: `${t(ENTRY_LABEL_KEY[candidate])} — ${t('header.workspaceEntry.hint')}`,
        }))}
        // Larger than the footer's icon-only buttons on purpose: this is a
        // partition of the workbench, not a quiet toolbar toggle. Stops are a
        // fixed equal width so the thumb (which copies `stopClassName`) stays
        // aligned when locale text lengths differ. Sized with icon+text in
        // mind — two stops ≈ 156px, plus the sidebar toggle beside it.
        stopClassName="h-8 w-[76px] gap-1 px-2"
        className="h-9"
        iconClassName="h-5 w-5"
      />
    </span>
  );
});
