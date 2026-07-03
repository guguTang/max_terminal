import type { IDockviewPanelProps } from "dockview";
import { RemoteFileTree } from "../components/RemoteFileTree";
import { FileEditor } from "../components/FileEditor";
import { Terminal } from "../components/Terminal";
import { useSessionStore } from "../stores/sessionStore";
import { LOCAL_SESSION_ID, useLocalConsoleStore } from "../stores/localConsoleStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { getDockApi, openFileInEditor } from "./dockApi";

function FilesPanel(props: IDockviewPanelProps<{ connectionId?: string }>) {
  const activeConnectionId = useSessionStore((s) => s.connectionId);
  const sessions = useSessionStore((s) => s.sessions);
  // 切换时面板 params 可能仍是旧连接，优先跟随当前激活连接
  const connectionId = activeConnectionId ?? props.params?.connectionId;
  const session = sessions.find((s) => s.connectionId === connectionId);

  const handleFileSelect = (path: string) => {
    const api = getDockApi();
    if (!api) return;
    openFileInEditor(api, path);
  };

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <RemoteFileTree
        key={connectionId ?? "disconnected"}
        connectionId={connectionId}
        sessionId={session?.sessionId ?? null}
        homePath={session?.homePath ?? null}
        onFileSelect={handleFileSelect}
      />
    </div>
  );
}

function EditorWelcomePanel() {
  return (
    <div className="flex h-full items-center justify-center bg-zinc-900 text-sm text-zinc-500">
      在左侧文件树中点击文件以打开
    </div>
  );
}

function EditorPanel(props: IDockviewPanelProps<{ filePath: string }>) {
  const filePath = props.params?.filePath;
  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-900 text-sm text-zinc-500">
        未指定文件
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <FileEditor filePath={filePath} />
    </div>
  );
}

function TerminalPanel(
  props: IDockviewPanelProps<{
    terminalId?: string;
    connectionId?: string;
    workspaceKind?: "local";
    initialCwd?: string;
    initialEnv?: Record<string, string>;
  }>,
) {
  const terminalId = props.params?.terminalId ?? "main";
  const consoleActive = useLocalConsoleStore((s) => s.ready);
  const isLocal =
    props.params?.workspaceKind === "local" ||
    (consoleActive && !props.params?.connectionId);

  const activeConnectionId = useSessionStore((s) => s.connectionId);
  const sessions = useSessionStore((s) => s.sessions);

  const localMeta = useTerminalMetaStore((s) =>
    s.metaByKey[`${LOCAL_SESSION_ID}:${terminalId}`],
  );

  if (isLocal) {
    const restoreCwd = props.params?.initialCwd ?? localMeta?.cwd;
    const restoreEnv = props.params?.initialEnv ?? localMeta?.env;

    return (
      <div className="h-full min-h-0 overflow-hidden">
        <Terminal
          kind="local"
          terminalId={terminalId}
          initialCwd={restoreCwd}
          initialEnv={restoreEnv}
          trustInitialCwd={Boolean(restoreCwd)}
        />
      </div>
    );
  }

  // SSH：各连接独立快照；切换时 params 可能滞后，优先当前激活连接
  const panelConnectionId = activeConnectionId ?? props.params?.connectionId ?? undefined;
  const sessionEntry = panelConnectionId
    ? sessions.find((item) => item.connectionId === panelConnectionId)
    : undefined;
  const homePath = sessionEntry?.homePath;
  const snapshotRuntime = panelConnectionId
    ? useWorkspaceStore.getState().getSnapshot(panelConnectionId)?.terminalRuntimeById?.[
        terminalId
      ]
    : undefined;
  const savedCwd = props.params?.initialCwd ?? snapshotRuntime?.cwd;
  const restoreCwd =
    savedCwd && savedCwd !== homePath ? savedCwd : props.params?.initialCwd;
  const restoreEnv = props.params?.initialEnv ?? snapshotRuntime?.env;

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <Terminal
        kind="ssh"
        terminalId={terminalId}
        sshSessionId={sessionEntry?.sessionId}
        connectionHomePath={homePath}
        initialCwd={restoreCwd}
        initialEnv={restoreEnv}
        trustInitialCwd={Boolean(restoreCwd)}
      />
    </div>
  );
}

export const dockComponents = {
  files: FilesPanel,
  editorWelcome: EditorWelcomePanel,
  editor: EditorPanel,
  terminal: TerminalPanel,
};
