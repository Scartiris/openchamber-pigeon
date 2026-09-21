/**
 * How an agent's OpenCode id is shown to the user.
 *
 * Ids stay stable in config/API (`build`); only the label is localized so the
 * picker can say 构建 without renaming the built-in agent on disk.
 */
export const agentBuiltinLabelKey = (agentName: string): `agents.builtin.${string}` =>
  `agents.builtin.${agentName}` as `agents.builtin.${string}`;

export const formatAgentDisplayName = (
  agentName: string,
  localizedLabel: string,
): string => {
  if (localizedLabel && localizedLabel !== agentBuiltinLabelKey(agentName)) {
    return localizedLabel;
  }
  return agentName.charAt(0).toUpperCase() + agentName.slice(1);
};
