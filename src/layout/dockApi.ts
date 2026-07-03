import type { DockviewApi } from "dockview";
import { invoke } from "@tauri-apps/api/core";
import { LOCAL_SESSION_ID, LOCAL_WORKSPACE_ID } from "../stores/localConsoleStore";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { useTerminalTitleStore } from "../stores/terminalTitleStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { TerminalMeta, FileEntry } from "../types/connection";

function isValidCwdPath(path?: string) {
  if (!path) return false;
  const trimmed = path.trim();
  if (
    !trimmed ||
    trimmed.includes("$") ||
    trimmed.includes('"') ||
    trimmed.includes("`") ||
    /\s/.test(trimmed)
  ) {
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

/** 从快照 dockJson + terminalRuntimeById 汇总应存在的终端 id */
function collectTerminalIdsFromSnapshot(connectionId: string): string[] {
  const snapshot = useWorkspaceStore.getState().getSnapshot(connectionId);
  if (!snapshot) return [DEFAULT_TERMINAL_ID];

  const ids = new Set<string>(Object.keys(snapshot.terminalRuntimeById ?? {}));
  const dockJson = snapshot.dockJson as {
    panels?: Record<string, { id?: string; params?: { terminalId?: string } }>;
  } | null;
  if (dockJson?.panels) {
    for (const panel of Object.values(dockJson.panels)) {
      const panelId = panel?.id ?? "";
      if (!panelId.startsWith("terminal")) continue;
      ids.add(panel.params?.terminalId ?? DEFAULT_TERMINAL_ID);
    }
  }
  return ids.size > 0 ? [...ids] : [DEFAULT_TERMINAL_ID];
}

function hydrateTerminalMetaFromSnapshot(connectionId: string, sessionId: string) {
  const runtime =
    useWorkspaceStore.getState().getSnapshot(connectionId)?.terminalRuntimeById ?? {};
  const metaStore = useTerminalMetaStore.getState();
  for (const [terminalId, meta] of Object.entries(runtime)) {
    if (!meta.cwd && Object.keys(meta.env ?? {}).length === 0) continue;
    metaStore.patchMeta(sessionId, terminalId, meta);
  }
}

/** 按快照补齐缺失的终端标签（恢复失败或仅保存了 runtime 时） */
function ensureTerminalPanelsFromSnapshot(api: DockviewApi, connectionId: string) {
  const terminalIds = collectTerminalIdsFromSnapshot(connectionId);
  const layoutIds = new Set(terminalIdsInLayout(api));
  const homePath = homePathForConnection(connectionId);

  for (const terminalId of terminalIds) {
    if (layoutIds.has(terminalId)) continue;
    const existingTerminal = api.panels.find((p) => p.id.startsWith("terminal"));
    const runtimeParams = terminalRuntimeParamsForConnection(
      connectionId,
      terminalId,
      homePath,
    );
    api.addPanel({
      id: terminalPanelId(terminalId),
      component: "terminal",
      title: resolveTerminalTitle(terminalId),
      params: terminalParams(terminalId, runtimeParams),
      position: existingTerminal
        ? { referencePanel: existingTerminal.id, direction: "within" }
        : api.getPanel(FILES_PANEL.id)
          ? { referencePanel: FILES_PANEL.id, direction: "below" }
          : undefined,
    });
    layoutIds.add(terminalId);
  }
  syncTerminalTitlesForConnection(api, connectionId);
}

function homePathForConnection(connectionId: string) {
  return (
    useSessionStore.getState().sessions.find((item) => item.connectionId === connectionId)
      ?.homePath ?? null
  );
}

/** 从快照取终端 cwd/env；与 home 相同时不传 initialCwd，避免多余 cd */
function terminalRuntimeParamsForConnection(
  connectionId: string,
  terminalId: string,
  homePath?: string | null,
) {
  const runtime =
    useWorkspaceStore.getState().getSnapshot(connectionId)?.terminalRuntimeById?.[terminalId];
  if (!runtime) return {};
  const params: { initialCwd?: string; initialEnv?: Record<string, string> } = {};
  if (
    runtime.cwd &&
    isValidCwdPath(runtime.cwd) &&
    (!homePath || runtime.cwd !== homePath)
  ) {
    params.initialCwd = runtime.cwd;
  }
  if (runtime.env && Object.keys(runtime.env).length > 0) {
    params.initialEnv = runtime.env;
  }
  return params;
}

function injectTerminalRuntimeIntoDockJson(dockJson: unknown, connectionId: string) {
  if (!dockJson || typeof dockJson !== "object") return dockJson;

  const json = dockJson as {
    panels?: Record<string, { id?: string; params?: Record<string, unknown> }>;
  };
  if (!json.panels) return dockJson;

  const homePath = homePathForConnection(connectionId);
  const panels = { ...json.panels };
  for (const [key, panel] of Object.entries(panels)) {
    const panelId = panel?.id ?? key;
    if (!panelId.startsWith("terminal")) continue;
    const terminalId =
      (panel.params?.terminalId as string | undefined) ?? DEFAULT_TERMINAL_ID;
    const runtimeParams = terminalRuntimeParamsForConnection(
      connectionId,
      terminalId,
      homePath,
    );
    if (!runtimeParams.initialCwd && !runtimeParams.initialEnv) continue;
    panels[key] = {
      ...panel,
      params: {
        ...(panel.params ?? {}),
        connectionId,
        ...runtimeParams,
      },
    };
  }
  return { ...json, panels };
}

/** 用前端跟踪的 cwd 刷新快照（query 失败时的兜底） */
export function refreshTerminalRuntimeFromMetaStore(
  connectionId: string,
  sessionId: string,
  terminalIds: string[],
) {
  const existing =
    useWorkspaceStore.getState().getSnapshot(connectionId)?.terminalRuntimeById ?? {};
  const runtimeById: Record<string, TerminalMeta> = { ...existing };
  const metaStore = useTerminalMetaStore.getState();

  const ids = terminalIds.length > 0 ? terminalIds : [DEFAULT_TERMINAL_ID];
  for (const terminalId of ids) {
    const live = metaStore.getMeta(sessionId, terminalId);
    if (!live?.cwd) continue;
    runtimeById[terminalId] = {
      cwd: live.cwd,
      env: live.env ?? runtimeById[terminalId]?.env ?? {},
    };
  }

  if (Object.keys(runtimeById).length > 0) {
    useWorkspaceStore.getState().setTerminalRuntimeById(connectionId, runtimeById);
  }
}

export function refreshActiveTerminalRuntimeFromMetaStore(api: DockviewApi) {
  const { connectionId, sessionId } = useSessionStore.getState();
  if (!connectionId || !sessionId) return;
  refreshTerminalRuntimeFromMetaStore(connectionId, sessionId, terminalIdsInLayout(api));
}

/** 退出前同步保存各连接的工作目录与布局快照 */
export async function captureWorkspaceBeforeClose() {
  const api = getDockApi();
  const { sessions, connectionId, sessionId } = useSessionStore.getState();

  if (api) {
    for (const session of sessions) {
      const terminalIds =
        session.connectionId === connectionId
          ? terminalIdsInLayout(api)
          : collectTerminalIdsFromSnapshot(session.connectionId);
      const existing =
        useWorkspaceStore.getState().getSnapshot(session.connectionId)?.terminalRuntimeById ?? {};
      const runtimeById = await captureRuntimeForTerminals(
        session.sessionId,
        terminalIds,
        existing,
      );
      if (Object.keys(runtimeById).length > 0) {
        useWorkspaceStore.getState().setTerminalRuntimeById(session.connectionId, runtimeById);
      }
    }

    if (connectionId && sessionId) {
      captureConnectionWorkspace(api, connectionId);
    }
    return;
  }

  for (const session of sessions) {
    const terminalIds = collectTerminalIdsFromSnapshot(session.connectionId);
    const existing =
      useWorkspaceStore.getState().getSnapshot(session.connectionId)?.terminalRuntimeById ?? {};
    const runtimeById = await captureRuntimeForTerminals(
      session.sessionId,
      terminalIds,
      existing,
    );
    if (Object.keys(runtimeById).length > 0) {
      useWorkspaceStore.getState().setTerminalRuntimeById(session.connectionId, runtimeById);
    }
  }
}

function applyTerminalRuntimeFromSnapshot(api: DockviewApi, connectionId: string) {
  const homePath = homePathForConnection(connectionId);
  for (const panel of api.panels) {
    if (!panel.id.startsWith("terminal")) continue;
    const terminalId =
      ((panel.params as { terminalId?: string } | undefined)?.terminalId ?? DEFAULT_TERMINAL_ID);
    const runtimeParams = terminalRuntimeParamsForConnection(
      connectionId,
      terminalId,
      homePath,
    );
    if (!runtimeParams.initialCwd && !runtimeParams.initialEnv) continue;
    panel.api.updateParameters({
      ...(panel.params ?? {}),
      ...runtimeParams,
    });
  }
}

/** 切换连接前捕获当前工作区（须在更新 sessionStore.connectionId 之前调用） */
export async function captureConnectionWorkspaceSnapshot(
  connectionId: string,
  sessionId: string,
) {
  const api = getDockApi();
  if (!api) return;
  setWorkspaceSwitching(true);
  await captureTerminalRuntimeForConnection(api, connectionId, sessionId);
  captureConnectionWorkspace(api, connectionId);
}

async function captureRuntimeForTerminals(
  sessionId: string,
  terminalIds: string[],
  existing: Record<string, TerminalMeta>,
  options?: { queryCwd?: boolean },
) {
  const runtimeById: Record<string, TerminalMeta> = { ...existing };
  const metaStore = useTerminalMetaStore.getState();
  const ids = terminalIds.length > 0 ? terminalIds : [DEFAULT_TERMINAL_ID];
  const queryCwd = options?.queryCwd ?? false;

  for (const terminalId of ids) {
    let cwd: string | undefined;
    let env = runtimeById[terminalId]?.env ?? {};

    if (queryCwd) {
      try {
        const queried = await invoke<string>("terminal_query_cwd", {
          sessionId,
          terminalId,
        });
        if (isValidCwdPath(queried)) {
          cwd = queried;
        }
      } catch {
        // PTY 可能尚未创建
      }
    }

    if (!cwd) {
      const live = metaStore.getMeta(sessionId, terminalId);
      if (live?.cwd && isValidCwdPath(live.cwd)) {
        cwd = live.cwd;
        env = { ...env, ...live.env };
      }
    }

    if (!cwd) {
      try {
        const meta = await invoke<TerminalMeta>("terminal_get_meta", {
          sessionId,
          terminalId,
        });
        if (isValidCwdPath(meta.cwd)) {
          cwd = meta.cwd;
          env = meta.env;
        }
      } catch {
        const cached = runtimeById[terminalId];
        if (cached?.cwd && isValidCwdPath(cached.cwd)) {
          cwd = cached.cwd;
        }
      }
    }

    if (!cwd) continue;

    runtimeById[terminalId] = { cwd, env };
  }

  return runtimeById;
}

export async function captureTerminalRuntimeForConnection(
  api: DockviewApi,
  connectionId: string,
  sessionId: string,
  options?: { queryCwd?: boolean },
) {
  const terminalIds = terminalIdsInLayout(api);
  const existing =
    useWorkspaceStore.getState().getSnapshot(connectionId)?.terminalRuntimeById ?? {};
  const runtimeById = await captureRuntimeForTerminals(
    sessionId,
    terminalIds,
    existing,
    options,
  );
  const metaStore = useTerminalMetaStore.getState();

  for (const [terminalId, meta] of Object.entries(runtimeById)) {
    metaStore.patchMeta(sessionId, terminalId, meta);
  }

  useWorkspaceStore.getState().setTerminalRuntimeById(connectionId, runtimeById);
}

function panelParams(extra?: Record<string, unknown>) {
  const connectionId = useSessionStore.getState().connectionId;
  return {
    ...(connectionId ? { connectionId } : {}),
    ...extra,
  };
}

function terminalParams(terminalId: string, extra?: Record<string, unknown>) {
  return {
    terminalId,
    ...panelParams(extra),
  };
}

function stampConnectionIdOnPanels(api: DockviewApi, connectionId: string) {
  for (const panel of api.panels) {
    panel.api.updateParameters({
      ...(panel.params ?? {}),
      connectionId,
    });
  }
}

const KNOWN_PANEL_COMPONENTS = new Set(["files", "editorWelcome", "editor", "terminal"]);

/** 移除 dockview 中无面板的空 group（切换时 fromJSON 常会残留，表现为顶部空白区域） */
function pruneEmptyDockGroups(api: DockviewApi) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const group of [...api.groups]) {
      if (group.panels.length === 0) {
        api.removeGroup(group);
        changed = true;
      }
    }
  }
}

function isHealthyConnectedLayout(api: DockviewApi) {
  pruneEmptyDockGroups(api);
  const panels = api.panels;
  const ids = panels.map((panel) => panel.id);
  if (ids.length !== new Set(ids).size) return false;
  if (ids.filter((id) => id === FILES_PANEL.id).length !== 1) return false;
  if (!ids.some((id) => id.startsWith("terminal"))) return false;
  if (ids.filter((id) => id === EDITOR_WELCOME_PANEL.id).length > 1) return false;
  if (panels.some((panel) => !KNOWN_PANEL_COMPONENTS.has(panel.api.component as string))) {
    return false;
  }
  if (api.groups.some((group) => group.panels.length === 0)) return false;
  if (api.groups.length > panels.length) return false;
  const unknown = ids.filter(
    (id) =>
      id !== FILES_PANEL.id &&
      id !== EDITOR_WELCOME_PANEL.id &&
      !id.startsWith("editor:") &&
      !id.startsWith("terminal"),
  );
  return unknown.length === 0 && ids.length <= 24;
}

export function notifyDockLayoutResize() {
  window.setTimeout(() => window.dispatchEvent(new Event("resize")), 50);
  window.setTimeout(() => window.dispatchEvent(new Event("resize")), 200);
  window.setTimeout(() => window.dispatchEvent(new Event("resize")), 450);
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
  pruneEmptyDockGroups(api);
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
    params: panelParams(),
    initialWidth: filesWidth,
    ...(terminalPanel
      ? { position: { referencePanel: terminalPanel.id, direction: "right" as const } }
      : {}),
  });

  if (editorPaths.length === 0) {
    api.addPanel({
      ...EDITOR_WELCOME_PANEL,
      params: panelParams(),
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
      params: terminalParams(
        DEFAULT_TERMINAL_ID,
        terminalRuntimeParamsForConnection(
          currentConnectionId,
          DEFAULT_TERMINAL_ID,
          useSessionStore.getState().homePath,
        ),
      ),
      initialHeight: terminalHeight,
      position: { referencePanel: FILES_PANEL.id, direction: "below" },
    });
  }

  syncTerminalTitlesForConnection(api, currentConnectionId);

  dockTerminalFullWidth(api, terminalHeight);
  pruneEmptyDockGroups(api);
  files.api.setActive();
}

export function captureConnectionWorkspace(api: DockviewApi, connectionId: string) {
  pruneEmptyDockGroups(api);
  useWorkspaceStore.getState().capture(api, connectionId);
}

export function captureConnectionWorkspaceForced(api: DockviewApi, connectionId: string) {
  pruneEmptyDockGroups(api);
  useWorkspaceStore.getState().captureForced(api, connectionId);
}

export function restoreConnectionWorkspace(api: DockviewApi, connectionId: string) {
  const snapshot = useWorkspaceStore.getState().getSnapshot(connectionId);
  const sessionId = useSessionStore
    .getState()
    .sessions.find((item) => item.connectionId === connectionId)?.sessionId;
  if (sessionId) {
    hydrateTerminalMetaFromSnapshot(connectionId, sessionId);
  }

  const finishRestore = () => {
    ensureTerminalPanelsFromSnapshot(api, connectionId);
    applyTerminalRuntimeFromSnapshot(api, connectionId);
    useSessionStore.getState().setSelectedFile(snapshot?.selectedFile ?? null);
    dockTerminalFullWidthAfterConnect(api);
    pruneEmptyDockGroups(api);
    notifyDockLayoutResize();
    captureConnectionWorkspaceForced(api, connectionId);
  };

  if (snapshot?.dockJson) {
    try {
      const dockJson = injectTerminalRuntimeIntoDockJson(snapshot.dockJson, connectionId);
      api.clear();
      api.fromJSON(dockJson as Parameters<DockviewApi["fromJSON"]>[0]);
      stampConnectionIdOnPanels(api, connectionId);
      pruneEmptyDockGroups(api);
      if (!isHealthyConnectedLayout(api)) {
        throw new Error("unhealthy workspace layout after restore");
      }
      syncTerminalTitlesForConnection(api, connectionId);
      finishRestore();
      if (!isHealthyConnectedLayout(api)) {
        throw new Error("unhealthy workspace layout after dock terminal");
      }
      return;
    } catch {
      // 保留 dockJson 快照，回退到默认连接布局并补齐终端标签
    }
  }

  api.clear();
  showConnectedWorkspace(api, { preserveEditors: false, resetTerminals: true });
  stampConnectionIdOnPanels(api, connectionId);
  pruneEmptyDockGroups(api);
  syncTerminalTitlesForConnection(api, connectionId);
  finishRestore();
}

let workspaceSwitchChain: Promise<void> = Promise.resolve();

async function performSwitchConnectionWorkspace(
  api: DockviewApi,
  fromConnectionId: string | null,
  toConnectionId: string,
) {
  setWorkspaceSwitching(true);
  try {
    if (fromConnectionId && fromConnectionId !== toConnectionId) {
      // activateSession 已捕获 cwd/meta；此处仅强制保存来源连接布局（勿 query_cwd，会向 PTY 注入换行）
      captureConnectionWorkspaceForced(api, fromConnectionId);
    }
    restoreConnectionWorkspace(api, toConnectionId);
    notifyDockLayoutResize();
  } finally {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.setTimeout(() => setWorkspaceSwitching(false), 800);
      });
    });
  }
}

export function switchConnectionWorkspace(
  api: DockviewApi,
  fromConnectionId: string | null,
  toConnectionId: string,
) {
  workspaceSwitchChain = workspaceSwitchChain
    .catch(() => {})
    .then(() => performSwitchConnectionWorkspace(api, fromConnectionId, toConnectionId));
  return workspaceSwitchChain;
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

/** Console 模式独立布局存储 */
export const CONSOLE_LAYOUT_STORAGE_KEY = "max-terminal-console-layout-v1";

const CONSOLE_TERMINAL_PANEL = {
  id: "terminal",
  component: "terminal",
  title: "本机终端",
  minimumHeight: 120,
  initialHeight: 280,
} as const;

function isValidLocalCwdPath(path?: string) {
  if (!path) return false;
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("$") || trimmed.includes('"') || trimmed.includes("`")) {
    return false;
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return true;
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

function defaultConsoleTerminalTitle(terminalId: string, sourceTerminalId?: string) {
  if (terminalId === DEFAULT_TERMINAL_ID) return "本机终端";
  const suffix = terminalId.replace("term-", "");
  return sourceTerminalId ? `本机终端 ${suffix} (副本)` : `本机终端 ${suffix}`;
}

function resolveConsoleTerminalTitle(terminalId: string, sourceTerminalId?: string) {
  return (
    useTerminalTitleStore.getState().getTitle(LOCAL_WORKSPACE_ID, terminalId) ??
    defaultConsoleTerminalTitle(terminalId, sourceTerminalId)
  );
}

function consoleTerminalParams(terminalId: string, extra?: Record<string, unknown>) {
  return {
    terminalId,
    workspaceKind: "local" as const,
    ...extra,
  };
}

function syncConsoleTerminalTitles(api: DockviewApi) {
  const titleStore = useTerminalTitleStore.getState();
  for (const panel of api.panels) {
    if (!panel.id.startsWith("terminal")) continue;
    const terminalId =
      ((panel.params as { terminalId?: string } | undefined)?.terminalId ?? DEFAULT_TERMINAL_ID);
    const title =
      titleStore.getTitle(LOCAL_WORKSPACE_ID, terminalId) ??
      defaultConsoleTerminalTitle(terminalId);
    panel.api.setTitle(title);
  }
}

function stampConsoleKindOnPanels(api: DockviewApi) {
  for (const panel of [...api.panels]) {
    if (!panel.id.startsWith("terminal")) {
      panel.api.close();
      continue;
    }
    const { connectionId: _drop, ...rest } = (panel.params ?? {}) as {
      connectionId?: string;
      [key: string]: unknown;
    };
    panel.api.updateParameters({
      ...rest,
      workspaceKind: "local",
    });
  }
}

function isHealthyConsoleLayout(api: DockviewApi) {
  pruneEmptyDockGroups(api);
  return api.panels.some((panel) => panel.id.startsWith("terminal"));
}

export function createConsoleDefaultLayout(api: DockviewApi) {
  api.clear();
  const { terminalHeight } = getInitialPanelSizes(api);

  api.addPanel({
    ...CONSOLE_TERMINAL_PANEL,
    title: resolveConsoleTerminalTitle(DEFAULT_TERMINAL_ID),
    params: consoleTerminalParams(DEFAULT_TERMINAL_ID),
    initialHeight: terminalHeight,
  });

  dockTerminalFullWidth(api, terminalHeight);
  pruneEmptyDockGroups(api);
}

export function loadConsoleSavedLayout(api: DockviewApi): boolean {
  const raw = localStorage.getItem(CONSOLE_LAYOUT_STORAGE_KEY);
  if (!raw) return false;
  try {
    api.clear();
    api.fromJSON(JSON.parse(raw));
    stampConsoleKindOnPanels(api);
    pruneEmptyDockGroups(api);
    if (!isHealthyConsoleLayout(api)) {
      throw new Error("unhealthy console layout");
    }
    syncConsoleTerminalTitles(api);
    const { terminalHeight } = getInitialPanelSizes(api);
    dockTerminalFullWidth(api, terminalHeight);
    pruneEmptyDockGroups(api);
    return true;
  } catch {
    localStorage.removeItem(CONSOLE_LAYOUT_STORAGE_KEY);
    return false;
  }
}

export function saveConsoleLayout(api: DockviewApi) {
  pruneEmptyDockGroups(api);
  if (!isHealthyConsoleLayout(api)) return;
  localStorage.setItem(CONSOLE_LAYOUT_STORAGE_KEY, JSON.stringify(api.toJSON()));
}

export function resetConsoleLayout(api: DockviewApi) {
  localStorage.removeItem(CONSOLE_LAYOUT_STORAGE_KEY);
  createConsoleDefaultLayout(api);
  saveConsoleLayout(api);
}

export function addConsoleTerminal(
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
    title: resolveConsoleTerminalTitle(terminalId, sourceTerminalId),
    params: consoleTerminalParams(terminalId, {
      initialCwd: cloneMeta?.cwd,
      initialEnv: cloneMeta?.env,
    }),
    position: existingTerminal
      ? { referencePanel: existingTerminal.id, direction: "within" }
      : undefined,
  });
  panel.api.setActive();
}

export async function duplicateConsoleTerminal(
  api: DockviewApi,
  sourceTerminalId?: string,
) {
  const source = sourceTerminalId ?? getActiveTerminalId(api);
  const cached = useTerminalMetaStore.getState().getMeta(LOCAL_SESSION_ID, source);
  let cwd = cached?.cwd;
  let env = cached?.env ?? {};

  try {
    const queried = await invoke<string>("terminal_query_cwd", {
      sessionId: LOCAL_SESSION_ID,
      terminalId: source,
    });
    if (isValidLocalCwdPath(queried)) {
      cwd = queried;
      useTerminalMetaStore.getState().setCwd(LOCAL_SESSION_ID, source, queried);
    }
  } catch {
    // ignore, fallback below
  }

  try {
    const storedMeta = await invoke<TerminalMeta>("terminal_get_meta", {
      sessionId: LOCAL_SESSION_ID,
      terminalId: source,
    });
    env = { ...storedMeta.env, ...env };
    if (!isValidLocalCwdPath(cwd) && isValidLocalCwdPath(storedMeta.cwd)) {
      cwd = storedMeta.cwd;
    }
  } catch {
    // ignore, fallback below
  }

  if (!isValidLocalCwdPath(cwd)) return;

  addConsoleTerminal(api, source, { cwd: cwd!, env });
}

