import type {
  BuiltInContextMenuItem,
  ContextMenuItemConfig,
  GetTabContextMenuItemsParams,
  IDockviewPanel,
} from "dockview";
import { duplicateConsoleTerminal, duplicateTerminal } from "./dockApi";

export const DEFAULT_TERMINAL_ID = "main";

export function isTerminalPanel(panel: Pick<IDockviewPanel, "id">) {
  return panel.id.startsWith("terminal");
}

export function isLocalTerminalPanel(panel: IDockviewPanel) {
  return (
    isTerminalPanel(panel) &&
    (panel.params as { workspaceKind?: string } | undefined)?.workspaceKind === "local"
  );
}

export function getTerminalIdFromPanel(panel: IDockviewPanel) {
  return (
    (panel.params as { terminalId?: string } | undefined)?.terminalId ??
    DEFAULT_TERMINAL_ID
  );
}

export function getTerminalTabContextMenuItems({
  panel,
  api,
}: GetTabContextMenuItemsParams) {
  if (!isTerminalPanel(panel)) {
    return ["close", "separator", "closeOthers", "closeAll"] satisfies BuiltInContextMenuItem[];
  }

  const terminalId = getTerminalIdFromPanel(panel);

  return [
    {
      label: "复制终端",
      action: () => {
        void duplicateTerminal(api, terminalId);
      },
    },
    "separator",
    "close",
    "closeOthers",
    "closeAll",
  ] satisfies (BuiltInContextMenuItem | ContextMenuItemConfig)[];
}

export function getConsoleTerminalTabContextMenuItems({
  panel,
  api,
}: GetTabContextMenuItemsParams) {
  if (!isTerminalPanel(panel)) {
    return ["close", "separator", "closeOthers", "closeAll"] satisfies BuiltInContextMenuItem[];
  }

  const terminalId = getTerminalIdFromPanel(panel);

  return [
    {
      label: "复制终端",
      action: () => {
        void duplicateConsoleTerminal(api, terminalId);
      },
    },
    "separator",
    "close",
    "closeOthers",
    "closeAll",
  ] satisfies (BuiltInContextMenuItem | ContextMenuItemConfig)[];
}
