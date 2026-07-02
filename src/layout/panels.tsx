import type { IDockviewPanelProps } from "dockview";
import { RemoteFileTree } from "../components/RemoteFileTree";
import { FileEditor } from "../components/FileEditor";
import { Terminal } from "../components/Terminal";
import { useSessionStore } from "../stores/sessionStore";
import { getDockApi, openFileInEditor } from "./dockApi";

function FilesPanel() {
  const connectionId = useSessionStore((s) => s.connectionId);

  const handleFileSelect = (path: string) => {
    const api = getDockApi();
    if (!api) return;
    openFileInEditor(api, path);
  };

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <RemoteFileTree key={connectionId ?? "disconnected"} onFileSelect={handleFileSelect} />
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
    initialCwd?: string;
    initialEnv?: Record<string, string>;
  }>,
) {
  const terminalId = props.params?.terminalId ?? "main";
  const activeSessionId = useSessionStore((s) => s.sessionId);
  const sshSessionId = activeSessionId ?? undefined;

  return (
    <div className="h-full min-h-0 overflow-hidden">
      <Terminal
        terminalId={terminalId}
        sshSessionId={sshSessionId}
        initialCwd={props.params?.initialCwd}
        initialEnv={props.params?.initialEnv}
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
