import { Plus } from "lucide-react";
import type { IDockviewHeaderActionsProps } from "dockview";
import { addConsoleTerminal } from "../layout/dockApi";
import { useLocalConsoleStore } from "../stores/localConsoleStore";

function isTerminalGroup(panels: IDockviewHeaderActionsProps["panels"]) {
  return panels.some((panel) => panel.id.startsWith("terminal"));
}

export function ConsoleTerminalGroupActions({
  containerApi,
  panels,
}: IDockviewHeaderActionsProps) {
  const ready = useLocalConsoleStore((s) => s.ready);

  if (!ready || !isTerminalGroup(panels)) {
    return null;
  }

  return (
    <button
      type="button"
      className="terminal-tab-add-btn"
      title="新建终端"
      onClick={() => addConsoleTerminal(containerApi)}
    >
      <Plus size={16} strokeWidth={2} />
    </button>
  );
}
