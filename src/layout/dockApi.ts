import type { DockviewApi } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalTitleStore } from "../stores/terminalTitleStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { TerminalMeta } from "../types/connection";
import type { FileEntry } from "../types/connection";

function isValidCwdPath(path?: string) {
  if (!path) return false;
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("$") || trimmed.includes('"') || trimmed.includes("`")) {
    return false;
  }
  return trimmed.startsWith("/") || trimmed.startsWith("~");
}

/** v9: 完全移除 dock 内 connections 组件 */
export const LAYOUT_STORAGE_KEY = "max-terminal-dockview-layout-v9";

const FILES_WIDTH_RATIO = 0.17;
const TERMINAL_HEIGHT_RATIO = 0.32;

const FILES_PANEL = {
  id: "files",
  component: "files",
  title: "远程文件",
  minimumWidth: 180,
  initialWidth: 220,
} as const;

const TERMINAL_PANEL = {
  id: "terminal",
  component: "terminal",
  title: "SSH 终端",
  minimumHeight: 120,
  initialHeight: 280,
} as const;
const DEFAULT_TERMINAL_ID = "main";

function defaultTerminalTitle(terminalId: string, sourceTerminalId?: string) {
  if (terminalId === DEFAULT_TERMINAL_ID) return "SSH 终端";
  const suffix = terminalId.replace("term-", "");
  return sourceTerminalId ? `SSH 终端 ${suffix} (副本)` : `SSH 终端 ${suffix}`;
}

function resolveTerminalTitle(terminalId: string, sourceTerminalId?: string) {
  const connectionId = useSessionStore.getState().connectionId;
  if (!connectionId) return defaultTerminalTitle(terminalId, sourceTerminalId);
  return (
    useTerminalTitleStore.getState().getTitle(connectionId, terminalId) ??
    defaultTerminalTitle(terminalId, sourceTerminalId)
  );
}

function syncTerminalTitlesForConnection(api: DockviewApi, connectionId: string) {
  const titleStore = useTerminalTitleStore.getState();
  for (const panel of api.panels) {
    if (!panel.id.startsWith("terminal")) continue;
    const terminalId =
      ((panel.params as { terminalId?: string } | undefined)?.terminalId ?? DEFAULT_TERMINAL_ID);
    const title =
      titleStore.getTitle(connectionId, terminalId) ?? defaultTerminalTitle(terminalId);
    panel.api.setTitle(title);
  }
}

function terminalIdsInLayout(api: DockviewApi) {
  return api.panels
    .filter((panel) => panel.id.startsWith("terminal"))
    .map(
      (panel) =>
        (panel.params as { terminalId?: string } | undefined)?.terminalId ?? DEFAULT_TERMINAL_ID,
    );
}

function applyTerminalRuntimeFromSnapshot(api: DockviewApi, connectionId: string) {
  const snapshot = useWorkspaceStore.getState().getSnapshot(connectionId);
  if (!snapshot) return;
  const runtimeById = snapshot.terminalRuntimeById ?? {};
  for (const panel of api.panels) {
    if (!panel.id.startsWith("terminal")) continue;
    const terminalId =
      ((panel.params as { terminalId?: string } | undefined)?.terminalId ?? DEFAULT_TERMINAL_ID);
    const runtime = runtimeById[terminalId];
    if (!runtime) continue;
    panel.api.updateParameters({
      ...(panel.params ?? {}),
      initialCwd: runtime.cwd,
      initialEnv: runtime.env,
    });
  }
}

export async function captureTerminalRuntimeForConnection(
  api: DockviewApi,
  connectionId: string,
  sessionId: string,
) {
  const runtimeById: Record<string, TerminalMeta> = {};
  const terminalIds = terminalIdsInLayout(api);
  for (const terminalId of terminalIds) {
    try {
      const meta = await invoke<TerminalMeta>("terminal_get_meta", {
        sessionId,
        terminalId,
      });
      runtimeById[terminalId] = meta;
      useTerminalMetaStore.getState().patchMeta(sessionId, terminalId, meta);
    } catch {
      const cached = useTerminalMetaStore.getState().getMeta(sessionId, terminalId);
      if (cached) {
        runtimeById[terminalId] = cached;
      }
    }
  }
  useWorkspaceStore.getState().setTerminalRuntimeById(connectionId, runtimeById);
}

function terminalParams(terminalId: string, extra?: Record<string, unknown>) {
  const connectionId = useSessionStore.getState().connectionId;
  return {
    terminalId,
    ...(connectionId ? { connectionId } : {}),
    ...extra,
  };
}

function stampTerminalConnectionId(api: DockviewApi, connectionId: string) {
  for (const panel of api.panels) {
    if (!panel.id.startsWith("terminal")) continue;
    panel.api.updateParameters({
      ...(panel.params ?? {}),
      connectionId,
    });
  }
}

const EDITOR_WELCOME_PANEL = {
  id: "editor-welcome",
  component: "editorWelcome",
  title: "编辑器",
  minimumWidth: 280,
} as const;

/**
 * 未连接默认布局：
 * ┌───────────────────────────────┐
 * │         SSH 终端（全宽）       │
 * └───────────────────────────────┘
 *
 * 连接后（showConnectedWorkspace）：
 * ┌──────────┬──────────┐
 * │ 文件树   │ 编辑器   │
 * ├──────────┴──────────┤
 * │     SSH 终端（全宽） │
 * └─────────────────────┘
 */
export function createDefaultLayout(api: DockviewApi) {
  api.clear();
  const { terminalHeight } = getInitialPanelSizes(api);

  api.addPanel({
    ...TERMINAL_PANEL,
    title: resolveTerminalTitle(DEFAULT_TERMINAL_ID),
    params: terminalParams(DEFAULT_TERMINAL_ID),
    initialHeight: terminalHeight,
  });

  dockTerminalFullWidth(api, terminalHeight);
}

/** 将终端组移到底部并横跨整个布局宽度 */
function dockTerminalFullWidth(api: DockviewApi, terminalHeight?: number) {
  const terminalPanel =
    api.panels.find((p) => p.id.startsWith("terminal")) ??
    api.getPanel(TERMINAL_PANEL.id);
  if (!terminalPanel) return;

  terminalPanel.group.api.moveTo({ position: "bottom", skipSetActive: true });

  if (terminalHeight) {
    terminalPanel.group.api.setSize({ height: terminalHeight });
  }
}

/** 连接后按正确顺序搭建工作区，使终端横跨文件树+编辑器 */
export function showConnectedWorkspace(
  api: DockviewApi,
  options?: { preserveEditors?: boolean; resetTerminals?: boolean },
) {
  const currentConnectionId = useSessionStore.getState().connectionId;
  if (!useSessionStore.getState().connected || !currentConnectionId) return;
  const { filesWidth, terminalHeight } = getInitialPanelSizes(api);

  const editorPaths =
    options?.preserveEditors === false
      ? []
      : api.panels
          .filter((p) => p.id.startsWith("editor:"))
          .map((p) => (p.params as { filePath: string }).filePath);

  for (const panel of [...api.panels]) {
    if (panel.id === FILES_PANEL.id || panel.id === EDITOR_WELCOME_PANEL.id || panel.id.startsWith("editor:")) {
      panel.api.close();
    }
    if (options?.resetTerminals && panel.id.startsWith("terminal")) {
      panel.api.close();
    }
  }

  const terminalPanel =
    api.panels.find((p) => p.id.startsWith("terminal")) ?? api.getPanel(TERMINAL_PANEL.id);

  const files = api.addPanel({
    ...FILES_PANEL,
    initialWidth: filesWidth,
    ...(terminalPanel
      ? { position: { referencePanel: terminalPanel.id, direction: "right" as const } }
      : {}),
  });

  if (editorPaths.length === 0) {
    api.addPanel({
      ...EDITOR_WELCOME_PANEL,
      position: { referencePanel: FILES_PANEL.id, direction: "right" },
    });
  } else {
    for (const filePath of editorPaths) {
      openFileInEditor(api, filePath, { skipWorkspaceEnsure: true });
    }
  }

  if (!api.panels.some((p) => p.id.startsWith("terminal"))) {
    api.addPanel({
      ...TERMINAL_PANEL,
      title: resolveTerminalTitle(DEFAULT_TERMINAL_ID),
      params: terminalParams(DEFAULT_TERMINAL_ID),
      initialHeight: terminalHeight,
      position: { referencePanel: FILES_PANEL.id, direction: "below" },
    });
  }

  syncTerminalTitlesForConnection(api, currentConnectionId);

  dockTerminalFullWidth(api, terminalHeight);
  files.api.setActive();
}

export function captureConnectionWorkspace(api: DockviewApi, connectionId: string) {
  useWorkspaceStore.getState().capture(api, connectionId);
}

export function restoreConnectionWorkspace(api: DockviewApi, connectionId: string) {
  const snapshot = useWorkspaceStore.getState().getSnapshot(connectionId);
  if (snapshot?.dockJson) {
    api.fromJSON(snapshot.dockJson as Parameters<DockviewApi["fromJSON"]>[0]);
    stampTerminalConnectionId(api, connectionId);
    syncTerminalTitlesForConnection(api, connectionId);
    applyTerminalRuntimeFromSnapshot(api, connectionId);
    useSessionStore.getState().setSelectedFile(snapshot.selectedFile);
    dockTerminalFullWidthAfterConnect(api);
    return;
  }

  showConnectedWorkspace(api, { preserveEditors: false, resetTerminals: true });
  stampTerminalConnectionId(api, connectionId);
}

export async function switchConnectionWorkspace(
  api: DockviewApi,
  fromConnectionId: string | null,
  toConnectionId: string,
) {
  setWorkspaceSwitching(true);
  try {
    if (fromConnectionId && fromConnectionId !== toConnectionId) {
      const fromSession = useSessionStore
        .getState()
        .sessions.find((item) => item.connectionId === fromConnectionId);
      if (fromSession) {
        await captureTerminalRuntimeForConnection(
          api,
          fromConnectionId,
          fromSession.sessionId,
        );
      }
      captureConnectionWorkspace(api, fromConnectionId);
    }
    restoreConnectionWorkspace(api, toConnectionId);
  } finally {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.setTimeout(() => setWorkspaceSwitching(false), 400);
      });
    });
  }
}

/** 断开后隐藏远程文件与编辑器，终端回到底部全宽 */
export function hideConnectedWorkspace(api: DockviewApi) {
  for (const panel of [...api.panels]) {
    if (
      panel.id === FILES_PANEL.id ||
      panel.id === EDITOR_WELCOME_PANEL.id ||
      panel.id.startsWith("editor:")
    ) {
      panel.api.close();
    }
  }

  dockTerminalFullWidth(api, getInitialPanelSizes(api).terminalHeight);
}

export function syncWorkspaceWithSession(api: DockviewApi) {
  const { connected, connectionId } = useSessionStore.getState();
  if (connected && connectionId) {
    restoreConnectionWorkspace(api, connectionId);
  } else {
    hideConnectedWorkspace(api);
  }
}

/** 连接后二次校正终端位置（等待 dockview 完成布局） */
export function dockTerminalFullWidthAfterConnect(api: DockviewApi) {
  const { terminalHeight } = getInitialPanelSizes(api);
  dockTerminalFullWidth(api, terminalHeight);
}

let workspaceSwitching = false;
let dockApi: DockviewApi | null = null;

export function isWorkspaceSwitching() {
  return workspaceSwitching;
}

export function setWorkspaceSwitching(value: boolean) {
  workspaceSwitching = value;
}

export function setDockApi(api: DockviewApi | null) {
  dockApi = api;
}

export function getDockApi() {
  return dockApi;
}

export function editorPanelId(filePath: string) {
  return `editor:${encodeURIComponent(filePath)}`;
}

function terminalPanelId(terminalId: string) {
  return terminalId === DEFAULT_TERMINAL_ID ? "terminal" : `terminal:${terminalId}`;
}

function nextTerminalId(api: DockviewApi) {
  const used = new Set<string>();
  for (const panel of api.panels) {
    if (!panel.id.startsWith("terminal")) continue;
    const id = (panel.params as { terminalId?: string } | undefined)?.terminalId;
    used.add(id ?? DEFAULT_TERMINAL_ID);
  }
  let i = 2;
  while (used.has(`term-${i}`)) i += 1;
  return `term-${i}`;
}

function getActiveTerminalId(api: DockviewApi) {
  const active = api.activePanel;
  if (!active || !active.id.startsWith("terminal")) return DEFAULT_TERMINAL_ID;
  return (
    ((active.params as { terminalId?: string } | undefined)?.terminalId ??
      DEFAULT_TERMINAL_ID)
  );
}

export function addNewTerminal(
  api: DockviewApi,
  sourceTerminalId?: string,
  cloneMeta?: TerminalMeta,
) {
  const terminalId = nextTerminalId(api);
  const existingTerminal =
    api.panels.find((p) => p.id.startsWith("terminal")) ?? api.getPanel("terminal");

  const panel = api.addPanel({
    id: terminalPanelId(terminalId),
    component: "terminal",
    title: resolveTerminalTitle(terminalId, sourceTerminalId),
    params: terminalParams(terminalId, {
      initialCwd: cloneMeta?.cwd,
      initialEnv: cloneMeta?.env,
    }),
    position: existingTerminal
      ? { referencePanel: existingTerminal.id, direction: "within" }
      : api.getPanel(FILES_PANEL.id)
        ? { referencePanel: FILES_PANEL.id, direction: "below" }
        : undefined,
  });
  panel.api.setActive();

  const connectionId = useSessionStore.getState().connectionId;
  if (connectionId) {
    captureConnectionWorkspace(api, connectionId);
  }
}

export async function duplicateTerminal(
  api: DockviewApi,
  sourceTerminalId?: string,
) {
  const sessionId = useSessionStore.getState().sessionId;
  if (!sessionId) return;

  const source = sourceTerminalId ?? getActiveTerminalId(api);
  const cached = useTerminalMetaStore.getState().getMeta(sessionId, source);
  let cwd = cached?.cwd;
  let env = cached?.env ?? {};
  let storedMetaCwd: string | undefined;

  try {
    const queried = await invoke<string>("terminal_query_cwd", {
      sessionId,
      terminalId: source,
    });
    if (isValidCwdPath(queried)) {
      cwd = queried;
      useTerminalMetaStore.getState().setCwd(sessionId, source, queried);
    }
  } catch {
    // ignore, fallback below
  }

  try {
    const storedMeta = await invoke<TerminalMeta>("terminal_get_meta", {
      sessionId,
      terminalId: source,
    });
    env = { ...storedMeta.env, ...env };
    storedMetaCwd = storedMeta.cwd;
    if (!isValidCwdPath(cwd) && isValidCwdPath(storedMeta.cwd)) {
      cwd = storedMeta.cwd;
    }
  } catch {
    // ignore, fallback below
  }

  const homePath = useSessionStore.getState().homePath;
  const candidates = [cwd, storedMetaCwd, homePath]
    .filter((p): p is string => isValidCwdPath(p ?? undefined))
    .filter((p, i, arr) => arr.indexOf(p) === i);

  let resolvedCwd: string | undefined;
  for (const candidate of candidates) {
    try {
      await invoke<FileEntry[]>("sftp_list_dir", {
        sessionId,
        path: candidate,
      });
      resolvedCwd = candidate;
      break;
    } catch {
      // try next candidate
    }
  }

  if (!resolvedCwd) return;

  addNewTerminal(api, source, { cwd: resolvedCwd, env });
}

export function fileNameFromPath(path: string) {
  const parts = path.replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function getInitialPanelSizes(api: DockviewApi) {
  const rect =
    (api as unknown as { element?: HTMLElement }).element?.getBoundingClientRect() ?? null;
  const width = rect?.width || window.innerWidth || 1280;
  const height = rect?.height || window.innerHeight || 800;

  const filesWidth = Math.max(FILES_PANEL.minimumWidth, Math.round(width * FILES_WIDTH_RATIO));
  const terminalHeight = Math.max(
    TERMINAL_PANEL.minimumHeight,
    Math.round(height * TERMINAL_HEIGHT_RATIO),
  );

  return { filesWidth, terminalHeight };
}

export function loadSavedLayout(api: DockviewApi): boolean {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
  if (!raw) return false;
  try {
    api.fromJSON(JSON.parse(raw));
    return true;
  } catch {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    return false;
  }
}

export function saveLayout(api: DockviewApi) {
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
}

export function resetLayout(api: DockviewApi) {
  const openEditors = api.panels
    .filter((p) => p.id.startsWith("editor:"))
    .map((p) => ({
      filePath: (p.params as { filePath: string }).filePath,
    }));

  const wasConnected = useSessionStore.getState().connected;

  localStorage.removeItem(LAYOUT_STORAGE_KEY);
  createDefaultLayout(api);

  if (wasConnected) {
    showConnectedWorkspace(api);
    for (const { filePath } of openEditors) {
      openFileInEditor(api, filePath);
    }
  }

  saveLayout(api);
}

function ensureEditorArea(api: DockviewApi) {
  const editors = api.panels.filter((p) => p.id.startsWith("editor:"));
  if (editors.length > 0) {
    return editors[editors.length - 1];
  }

  const welcome = api.getPanel(EDITOR_WELCOME_PANEL.id);
  if (welcome) return welcome;

  const files = api.getPanel(FILES_PANEL.id);
  if (!files) return null;

  return api.addPanel({
    ...EDITOR_WELCOME_PANEL,
    position: { referencePanel: FILES_PANEL.id, direction: "right" },
  });
}

export function findEditorGroupReference(api: DockviewApi) {
  return ensureEditorArea(api);
}

export function openFileInEditor(
  api: DockviewApi,
  filePath: string,
  options?: { skipWorkspaceEnsure?: boolean },
) {
  if (!useSessionStore.getState().connected) return;

  const connectionId = useSessionStore.getState().connectionId;
  useSessionStore.getState().setSelectedFile(filePath);
  if (connectionId) {
    useWorkspaceStore.getState().setSelectedFile(connectionId, filePath);
  }

  const panelId = editorPanelId(filePath);
  const existing = api.getPanel(panelId);
  if (existing) {
    existing.api.setActive();
    return;
  }

  if (
    !options?.skipWorkspaceEnsure &&
    !api.getPanel(FILES_PANEL.id)
  ) {
    showConnectedWorkspace(api);
  }

  const reference = ensureEditorArea(api);
  if (!reference) return;

  if (reference.id === EDITOR_WELCOME_PANEL.id) {
    const panel = api.addPanel({
      id: panelId,
      component: "editor",
      title: fileNameFromPath(filePath),
      params: { filePath },
      position: { referencePanel: reference.id, direction: "within" },
    });
    reference.api.close();
    panel.api.setActive();
    return;
  }

  const panel = api.addPanel({
    id: panelId,
    component: "editor",
    title: fileNameFromPath(filePath),
    params: { filePath },
    position: { referencePanel: reference.id, direction: "within" },
  });
  panel.api.setActive();
}

export function syncRenamedPathInEditors(
  api: DockviewApi,
  oldPath: string,
  newPath: string,
) {
  const editorPanels = api.panels
    .filter((p) => p.id.startsWith("editor:"))
    .map((p) => ({
      id: p.id,
      filePath: (p.params as { filePath: string } | undefined)?.filePath,
      isActive: api.activePanel?.id === p.id,
    }))
    .filter((p): p is { id: string; filePath: string; isActive: boolean } => Boolean(p.filePath));

  const targets = editorPanels
    .filter((p) => p.filePath === oldPath || p.filePath.startsWith(`${oldPath}/`))
    .map((p) => ({
      ...p,
      nextPath:
        p.filePath === oldPath ? newPath : `${newPath}${p.filePath.slice(oldPath.length)}`,
    }));

  if (targets.length === 0) {
    if (useSessionStore.getState().selectedFile === oldPath) {
      useSessionStore.getState().setSelectedFile(newPath);
    }
    const connectionId = useSessionStore.getState().connectionId;
    if (connectionId && useWorkspaceStore.getState().getSnapshot(connectionId)?.selectedFile === oldPath) {
      useWorkspaceStore.getState().setSelectedFile(connectionId, newPath);
    }
    return;
  }

  for (const target of targets) {
    const panel = api.getPanel(target.id);
    if (panel) panel.api.close();
    openFileInEditor(api, target.nextPath, { skipWorkspaceEnsure: true });
    if (target.isActive) {
      const reopened = api.getPanel(editorPanelId(target.nextPath));
      reopened?.api.setActive();
    }
  }

  if (useSessionStore.getState().selectedFile === oldPath) {
    useSessionStore.getState().setSelectedFile(newPath);
  }
  const connectionId = useSessionStore.getState().connectionId;
  if (connectionId && useWorkspaceStore.getState().getSnapshot(connectionId)?.selectedFile === oldPath) {
    useWorkspaceStore.getState().setSelectedFile(connectionId, newPath);
  }
}
