/**
 * The workbench's two entries: 代码 (code) and 工作 (work).
 *
 * The entry decides *which kind of work the user is in* — a directory, not a mode.
 * The deployment registers its partitions under `<home>/workspaces/<name>`, so the
 * path a session's project lives at already carries the answer: this module only
 * reads it. That keeps the entry the same switch that already picks the partition's
 * default agent (`project.defaultAgent` → `resolveProjectDefaultAgent`) and the same
 * one that isolates memory (`peerId`), instead of inventing a fourth place where
 * "is this office work?" is answered.
 *
 * Deliberately *not* the composer's three positions. 施工/计划/聊天 is "how to
 * deliver" (`lib/composerModes.ts`) and stays orthogonal to this: switching entry
 * never touches the agent, and switching the composer never touches the list.
 *
 * `code` is the catch-all, so nothing needs classifying: the home directory
 * itself, managed chats, and any project registered outside the workspaces tree
 * all stay where the user was already looking.
 */

import type { IconName } from '@/components/icon/icons';
import { normalizePath } from '@/lib/pathNormalization';

export type WorkspaceEntry = 'code' | 'work';

/** Left to right, as the user reads the switch. */
export const ENTRY_ORDER: readonly WorkspaceEntry[] = ['code', 'work'];

/**
 * Declared one icon per binding, as a `const X: IconName`: the sprite generator
 * only collects names it finds in that shape (or inside a `: Record<…IconName…> = {`
 * literal), and an icon it misses renders as an empty `<use>` — no error, no build
 * failure. `satisfies` then checks the pair covers both entries without widening.
 *
 * Code is `terminal-box`, not bare `<>`: angle brackets alone read as punctuation
 * next to the entry name, while a terminal-in-a-box still says "coding" at 20px.
 */
const CODE_ICON: IconName = 'terminal-box';
const WORK_ICON: IconName = 'briefcase';
export const ENTRY_ICONS = {
  code: CODE_ICON,
  work: WORK_ICON,
} satisfies Record<WorkspaceEntry, IconName>;

/** `as const` keeps these literal, so a mistyped key fails `t()` at compile time. */
export const ENTRY_LABEL_KEY = {
  code: 'header.workspaceEntry.code',
  work: 'header.workspaceEntry.work',
} as const satisfies Record<WorkspaceEntry, string>;

/** The only shape this module needs from a project — a path to read the rule off. */
type ProjectPath = { path: string };

type EntryDraftProject = ProjectPath & {
  id: string;
  addedAt?: number | null;
  lastOpenedAt?: number | null;
};

/**
 * Where a new session started from this entry lands. `selectedProjectId` alone is
 * not enough: the draft target reads the override, and without it a project whose
 * stored path needed normalising would open a draft in a directory the sidebar is
 * not listing.
 */
export type EntryDraftTarget = {
  selectedProjectId: string;
  directoryOverride: string;
};

const WORKSPACES_SEGMENT = 'workspaces';
const WORK_SEGMENT = 'work';

/**
 * The work partition is the `work` leaf of a `workspaces` directory. Matching a
 * segment pair (rather than a prefix string) means one rule covers the container
 * path, the host bind-mount path and a development checkout alike, and covers
 * every 专项 and worktree nested below them.
 *
 * Case-sensitive on purpose: the partition roots are lowercase on the server, and
 * folding case here would silently capture a `Work` directory someone named for
 * something else entirely.
 */
const hasWorkPartitionSegment = (normalized: string): boolean => {
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (segments[index] === WORKSPACES_SEGMENT && segments[index + 1] === WORK_SEGMENT) return true;
  }
  return false;
};

export const resolveWorkspaceEntry = (value: string | null | undefined): WorkspaceEntry => {
  const normalized = normalizePath(value);
  if (!normalized) return 'code';
  return hasWorkPartitionSegment(normalized) ? 'work' : 'code';
};

/**
 * The projects this entry owns, in the order given. Callers pass the sidebar's own
 * sorted list, so the manual project order survives the partition filter.
 *
 * Projects, never sessions: ownership already resolves a session to the deepest
 * registered project, and a git worktree of a work project can live outside the
 * partition — filtering by project keeps that worktree with its parent, while
 * filtering raw session paths would split it into the code entry.
 */
export const selectProjectsForEntry = <P extends ProjectPath>(
  projects: readonly P[],
  entry: WorkspaceEntry,
): P[] => projects.filter((project) => resolveWorkspaceEntry(project.path) === entry);

/**
 * Managed chats are created under the home directory, which the rule classifies as
 * `code`, so under another entry they are not this entry's surface at all. The
 * sidebar asks the same question twice — the group it lists, and the Recent block
 * that carries the "new chat" affordance — and one answer is what stops those two
 * from disagreeing.
 */
export const entryShowsManagedChats = (entry: WorkspaceEntry): boolean => entry === 'code';

/**
 * The sessions an entry may list, classified by the directory each one lives in.
 *
 * This is *not* the same basis the sidebar uses — the sidebar partitions projects and
 * lets ownership carry the sessions — and the difference is deliberate, because
 * resolving an owner would be wrong here in the case the archive page exists for.
 * It lists sessions whose directory is not registered at all (an unregistered 专项
 * keeps its history), and on this deployment `/home/openchamber` is itself a
 * registered project, so the deepest owner of `…/workspaces/work/模板` is the *home*
 * project: owner-first would file that 工作 session under 代码. The raw path is the
 * one piece of evidence that cannot be swallowed by a parent registration.
 *
 * The known cost of choosing it: a git worktree of a 工作 project checked out outside
 * the partition stays listed by the sidebar (it inherits its parent project) while a
 * flat session list files it under 代码. The deployment has no worktrees today, and
 * the fix if that changes is to resolve the worktree's parent project here — not to
 * switch these surfaces to the sidebar's basis.
 */
export const selectSessionsForEntry = <S>(
  sessions: readonly S[],
  entry: WorkspaceEntry,
  directoryOf: (session: S) => string | null | undefined,
): S[] => sessions.filter((session) => resolveWorkspaceEntry(directoryOf(session)) === entry);

/**
 * Whether a session tab renders under this entry.
 *
 * Classification is by the owning project's path (same basis the switch uses to
 * jump), not the raw session directory — a work project's worktree stays with
 * 工作. The session on screen always renders: a deep link across partitions must
 * not orphan the header title behind an empty strip. VS Code has no project
 * partition, so every open tab stays visible there.
 */
export const entryRendersSessionTab = (
  ownerPath: string | null | undefined,
  entry: WorkspaceEntry,
  options: { isCurrent?: boolean; isVSCode?: boolean } = {},
): boolean => {
  if (options.isVSCode === true) return true;
  if (options.isCurrent === true) return true;
  if (!ownerPath) return false;
  return resolveWorkspaceEntry(ownerPath) === entry;
};

const recencyOf = (project: EntryDraftProject): number => project.lastOpenedAt ?? project.addedAt ?? 0;

/**
 * The project a new draft should open in: the most recently opened one this entry
 * owns, falling back to the most recently added, then to the first in the sidebar's
 * order. `null` means the entry has no project at all, and the caller should keep
 * its existing behaviour rather than invent a directory.
 */
export const resolveEntryDraftTarget = <P extends EntryDraftProject>(
  projects: readonly P[],
  entry: WorkspaceEntry,
): EntryDraftTarget | null => {
  const owned = selectProjectsForEntry(projects, entry);
  if (owned.length === 0) return null;

  let chosen = owned[0];
  let chosenAt = recencyOf(chosen);
  for (const candidate of owned.slice(1)) {
    const at = recencyOf(candidate);
    if (at > chosenAt) {
      chosen = candidate;
      chosenAt = at;
    }
  }

  return { selectedProjectId: chosen.id, directoryOverride: chosen.path };
};
