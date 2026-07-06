import { Plus } from "lucide-react";
import type { IDockviewHeaderActionsProps } from "dockview";
import { addNewTerminal } from "../layout/dockApi";
import { useSessionStore } from "../stores/sessionStore";

function isTerminalGroup(panels: IDockviewHeaderActionsProps["panels"]) {
  return panels.some((panel) => panel.id.startsWith("terminal"));
}

export function TerminalGroupActions({
  containerApi,
  panels,
}: IDockviewHeaderActionsProps) {
  const connected = useSessionStore((s) => s.connected);

  if (!connected || !isTerminalGroup(panels)) {
    return null;
  }

  return (
    <button
      type="button"
      className="terminal-tab-add-btn"
      title="新建终端"
      onClick={() => addNewTerminal(containerApi)}
    >
      <Plus size={16} strokeWidth={2} />
    </button>
  );
}
