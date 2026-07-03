import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ChevronRight, ChevronDown, File, Folder, Home, Loader2, RefreshCw } from "lucide-react";
import type { FileEntry } from "../types/connection";
import type { TransferTaskSnapshot } from "../types/transfer";
import { useSessionStore } from "../stores/sessionStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useTransferStore } from "../stores/transferStore";
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from "vscode-icons-js";
import { getDockApi, syncRenamedPathInEditors } from "../layout/dockApi";
import { RemotePathPicker } from "./RemotePathPicker";

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  sessionId: string | null;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  reloadKey: number;
  onContextMenu: (entry: FileEntry, event: React.MouseEvent<HTMLDivElement>) => void;
  mutation: TreeMutation | null;
}

const VSCODE_ICONS_BASE_URL =
  "https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons";

function VscodeIcon({
  iconName,
  alt,
  fallback,
}: {
  iconName?: string;
  alt: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  if (failed || !iconName) return <>{fallback}</>;

  return (
    <img
      src={`${VSCODE_ICONS_BASE_URL}/${iconName}`}
      alt={alt}
      className="h-4 w-4 shrink-0"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

function parentDir(path: string) {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function joinRemotePath(dir: string, name: string) {
  if (dir === "/") return `/${name}`;
  return `${dir.replace(/\/$/, "")}/${name}`;
}

function joinLocalPath(dir: string, name: string) {
  const base = dir.replace(/\/$/, "");
  return `${base}/${name}`;
}

function fileName(path: string) {
  const normalized = path.replace(/\/$/, "");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

type FolderTransferPrompt =
  | { kind: "download"; entry: FileEntry; localPath: string }
  | {
      kind: "upload";
      localPath: string;
      remotePath: string;
      name: string;
      targetDir: string;
    };

type TreeMutation =
  | { id: number; type: "rename"; oldPath: string; newPath: string; newName: string }
  | { id: number; type: "delete"; targetPath: string }
  | { id: number; type: "add"; parentPath: string; entry: FileEntry };

function TreeNode({
  entry,
  depth,
  sessionId,
  onSelect,
  selectedPath,
  reloadKey,
  onContextMenu,
  mutation,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadChildren = useCallback(async () => {
    if (!sessionId || !entry.isDir) return;
    setLoading(true);
    setError(null);
    try {
      const items = await invoke<FileEntry[]>("sftp_list_dir", {
        sessionId,
        path: entry.path,
      });
      setChildren(items);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
      setChildren([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId, entry.path, entry.isDir]);

  useEffect(() => {
    if (!expanded || !entry.isDir) return;
    void loadChildren();
  }, [reloadKey, expanded, entry.isDir, loadChildren]);

  useEffect(() => {
    if (!mutation) return;
    setChildren((prev) => {
      if (mutation.type === "rename") {
        let changed = false;
        const next = prev.map((item) => {
          if (item.path === mutation.oldPath || item.path.startsWith(`${mutation.oldPath}/`)) {
            changed = true;
            const mappedPath =
              item.path === mutation.oldPath
                ? mutation.newPath
                : `${mutation.newPath}${item.path.slice(mutation.oldPath.length)}`;
            return {
              ...item,
              path: mappedPath,
              name: item.path === mutation.oldPath ? mutation.newName : fileName(mappedPath),
            };
          }
          return item;
        });
        if (!changed) return prev;
        next.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return next;
      }

      if (mutation.type === "add") {
        if (entry.path !== mutation.parentPath) return prev;
        const exists = prev.some((item) => item.path === mutation.entry.path);
        const next = exists
          ? prev.map((item) => (item.path === mutation.entry.path ? mutation.entry : item))
          : [...prev, mutation.entry];
        next.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        return next;
      }

      const filtered = prev.filter(
        (item) => item.path !== mutation.targetPath && !item.path.startsWith(`${mutation.targetPath}/`),
      );
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [mutation]);

  const toggle = async () => {
    if (!entry.isDir) {
      onSelect(entry.path);
      return;
    }
    if (!expanded) {
      if (!loaded) {
        await loadChildren();
      }
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  };

  const isSelected = selectedPath === entry.path;

  return (
    <div>
      <div
        className={`flex items-center gap-1 px-2 py-1 cursor-pointer text-sm hover:bg-zinc-800 rounded ${
          isSelected ? "bg-zinc-800 text-blue-300" : ""
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={toggle}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(entry, event);
        }}
      >
        {entry.isDir ? (
          expanded ? (
            <ChevronDown size={14} className="text-zinc-500 shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-zinc-500 shrink-0" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {entry.isDir ? (
          <VscodeIcon
            iconName={expanded ? getIconForOpenFolder(entry.name) : getIconForFolder(entry.name)}
            alt={entry.name}
            fallback={<Folder size={14} className="text-amber-400 shrink-0" />}
          />
        ) : (
          <VscodeIcon
            iconName={getIconForFile(entry.name)}
            alt={entry.name}
            fallback={<File size={14} className="text-zinc-400 shrink-0" />}
          />
        )}
        <span className="whitespace-nowrap" title={entry.path}>
          {entry.name}
        </span>
        {loading && <Loader2 size={12} className="animate-spin ml-auto" />}
      </div>
      {error && (
        <p
          className="text-xs text-red-400 px-2 py-1"
          style={{ paddingLeft: `${depth * 12 + 24}px` }}
        >
          {error}
        </p>
      )}
      {expanded &&
        children.map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            sessionId={sessionId}
            onSelect={onSelect}
            selectedPath={selectedPath}
            reloadKey={reloadKey}
            mutation={mutation}
            onContextMenu={onContextMenu}
          />
        ))}
    </div>
  );
}

interface RemoteFileTreeProps {
  onFileSelect: (path: string) => void;
  connectionId?: string | null;
  sessionId?: string | null;
  homePath?: string | null;
}

export function RemoteFileTree({
  onFileSelect,
  connectionId: boundConnectionId,
  sessionId: boundSessionId,
  homePath: boundHomePath,
}: RemoteFileTreeProps) {
  const activeConnectionId = useSessionStore((s) => s.connectionId);
  const activeSessionId = useSessionStore((s) => s.sessionId);
  const activeHomePath = useSessionStore((s) => s.homePath);
  const { selectedFile, sessions, connectBackground } = useSessionStore();
  const connectionId = boundConnectionId ?? activeConnectionId;
  const sessionForConnection = sessions.find((s) => s.connectionId === connectionId);
  const sessionId = boundSessionId ?? sessionForConnection?.sessionId ?? activeSessionId;
  const homePath = boundHomePath ?? sessionForConnection?.homePath ?? activeHomePath;
  const browseGenerationRef = useRef(0);
  const connections = useConnectionStore((s) => s.connections);
  const fetchConnections = useConnectionStore((s) => s.fetchConnections);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [mutation, setMutation] = useState<TreeMutation | null>(null);
  const mutationSeqRef = useRef(0);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [infoTarget, setInfoTarget] = useState<FileEntry | null>(null);
  const [remoteCopyTarget, setRemoteCopyTarget] = useState<FileEntry | null>(null);
  const [remoteCopyDestConnectionId, setRemoteCopyDestConnectionId] = useState("");
  const [remoteCopyDestSessionId, setRemoteCopyDestSessionId] = useState("");
  const [remoteCopyDestHomePath, setRemoteCopyDestHomePath] = useState("/");
  const [remoteCopyDestDir, setRemoteCopyDestDir] = useState("");
  const [remoteCopyDestConnecting, setRemoteCopyDestConnecting] = useState(false);
  const [remoteCopyCompress, setRemoteCopyCompress] = useState(false);
  const [folderTransferPrompt, setFolderTransferPrompt] = useState<FolderTransferPrompt | null>(
    null,
  );
  const [folderTransferCompress, setFolderTransferCompress] = useState(false);
  const startTransfer = useTransferStore((s) => s.startTransfer);
  const syncFromSnapshot = useTransferStore((s) => s.syncFromSnapshot);
  const finishSuccess = useTransferStore((s) => s.finishSuccess);
  const finishFailed = useTransferStore((s) => s.finishFailed);
  const finishCancelled = useTransferStore((s) => s.finishCancelled);

  useEffect(() => {
    if (connections.length === 0) {
      void fetchConnections();
    }
  }, [connections.length, fetchConnections]);

  useEffect(() => {
    browseGenerationRef.current += 1;
    setEntries([]);
    setError(null);
    setLoading(false);
    if (!connectionId || !homePath) {
      setCurrentPath(null);
      return;
    }
    const saved = useWorkspaceStore.getState().getFileTreePath(connectionId);
    setCurrentPath(saved ?? homePath);
  }, [connectionId, homePath, sessionId]);

  useEffect(() => {
    if (!connectionId || !currentPath) return;
    const savedFor = connectionId;
    const savedPath = currentPath;
    useWorkspaceStore.getState().setFileTreePath(savedFor, savedPath);
    return () => {
      useWorkspaceStore.getState().setFileTreePath(savedFor, savedPath);
    };
  }, [connectionId, currentPath]);

  useEffect(() => {
    if (!sessionId || !currentPath) {
      setEntries([]);
      setError(null);
      setLoading(false);
      return;
    }

    const generation = browseGenerationRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);

    invoke<FileEntry[]>("sftp_list_dir", { sessionId, path: currentPath })
      .then((items) => {
        if (cancelled || generation !== browseGenerationRef.current) return;
        setEntries(items);
      })
      .catch((e) => {
        if (cancelled || generation !== browseGenerationRef.current) return;
        setError(String(e));
        setEntries([]);
      })
      .finally(() => {
        if (cancelled || generation !== browseGenerationRef.current) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, currentPath, reloadKey]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  const refreshTree = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const pollTransfer = useCallback(async (taskId: string): Promise<TransferTaskSnapshot> => {
    while (true) {
      const snapshot = await invoke<TransferTaskSnapshot>("transfer_query", { taskId });
      syncFromSnapshot(taskId, snapshot);
      if (snapshot.status !== "running") {
        return snapshot;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    }
  }, [syncFromSnapshot]);

  const executeDownload = useCallback(
    async (entry: FileEntry, targetPath: string, compress: boolean) => {
      if (!sessionId || !connectionId) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const task = await invoke<TransferTaskSnapshot>("transfer_start_download", {
          sessionId,
          remotePath: entry.path,
          localPath: targetPath,
          compress: entry.isDir ? compress : false,
        });
        startTransfer({
          id: task.taskId,
          direction: "download",
          connectionId,
          sessionId,
          remotePath: entry.path,
          localPath: targetPath,
          fileName: entry.name,
          totalBytes: task.totalBytes ?? undefined,
        });
        const snapshot = await pollTransfer(task.taskId);
        if (snapshot.status === "success") {
          finishSuccess(task.taskId);
          setNotice(`已下载到: ${targetPath}`);
        } else if (snapshot.status === "cancelled") {
          finishCancelled(task.taskId);
          setNotice("下载已取消");
        } else {
          finishFailed(task.taskId, snapshot.error ?? "下载失败");
          setError(snapshot.error ?? "下载失败");
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [
      connectionId,
      finishCancelled,
      finishFailed,
      finishSuccess,
      pollTransfer,
      sessionId,
      startTransfer,
    ],
  );

  const handleDownload = useCallback(
    async (entry: FileEntry) => {
      if (!sessionId || !connectionId) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        let targetPath: string | null;
        if (entry.isDir) {
          const parentDir = await open({
            title: "选择下载保存目录",
            directory: true,
            multiple: false,
          });
          if (!parentDir || Array.isArray(parentDir)) {
            setNotice("已取消下载");
            return;
          }
          targetPath = joinLocalPath(parentDir, entry.name);
          setFolderTransferCompress(false);
          setFolderTransferPrompt({ kind: "download", entry, localPath: targetPath });
          return;
        }
        targetPath = await save({
          defaultPath: entry.name,
          title: "选择下载保存位置",
        });
        if (!targetPath) {
          setNotice("已取消下载");
          return;
        }
        await executeDownload(entry, targetPath, false);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [connectionId, executeDownload, sessionId],
  );

  const executeUpload = useCallback(
    async (
      localPath: string,
      remotePath: string,
      name: string,
      targetDir: string,
      pickDirectory: boolean,
      compress: boolean,
    ) => {
      if (!sessionId || !connectionId) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const task = await invoke<TransferTaskSnapshot>("transfer_start_upload", {
          sessionId,
          localPath,
          remotePath,
          compress: pickDirectory ? compress : false,
        });
        startTransfer({
          id: task.taskId,
          direction: "upload",
          connectionId,
          sessionId,
          remotePath,
          localPath,
          fileName: name,
          totalBytes: task.totalBytes ?? undefined,
        });
        const snapshot = await pollTransfer(task.taskId);
        if (snapshot.status === "success") {
          finishSuccess(task.taskId);
          setNotice(`已上传: ${name}`);
        } else if (snapshot.status === "cancelled") {
          finishCancelled(task.taskId);
          setNotice("上传已取消");
          return;
        } else {
          finishFailed(task.taskId, snapshot.error ?? "上传失败");
          setError(snapshot.error ?? "上传失败");
          return;
        }
        const newEntry: FileEntry = {
          name,
          path: remotePath,
          isDir: pickDirectory,
          size: pickDirectory ? 0 : (snapshot.totalBytes ?? 0),
        };
        if (currentPath === targetDir) {
          setEntries((prev) => {
            const exists = prev.some((item) => item.path === remotePath);
            const next = exists
              ? prev.map((item) => (item.path === remotePath ? newEntry : item))
              : [...prev, newEntry];
            next.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
            return next;
          });
        } else {
          mutationSeqRef.current += 1;
          setMutation({
            id: mutationSeqRef.current,
            type: "add",
            parentPath: targetDir,
            entry: newEntry,
          });
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [
      connectionId,
      currentPath,
      finishCancelled,
      finishFailed,
      finishSuccess,
      pollTransfer,
      sessionId,
      startTransfer,
    ],
  );

  const startUpload = useCallback(
    async (targetDir: string, pickDirectory = false) => {
      if (!sessionId || !connectionId) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const selected = await open({
          title: pickDirectory ? "选择要上传的文件夹" : "选择要上传的文件",
          multiple: false,
          directory: pickDirectory,
        });
        if (!selected || Array.isArray(selected)) {
          setNotice("已取消上传");
          return;
        }
        const localPath = selected;
        const name = fileName(localPath);
        const remotePath = joinRemotePath(targetDir, name);
        if (pickDirectory) {
          setFolderTransferCompress(false);
          setFolderTransferPrompt({
            kind: "upload",
            localPath,
            remotePath,
            name,
            targetDir,
          });
          return;
        }
        await executeUpload(localPath, remotePath, name, targetDir, false, false);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [connectionId, executeUpload, sessionId],
  );

  const openRenameDialog = useCallback((entry: FileEntry) => {
    setRenameTarget(entry);
    setRenameValue(fileName(entry.path));
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!sessionId) return;
    if (!renameTarget) return;
    const currentName = fileName(renameTarget.path);
    const nextName = renameValue.trim();
    if (!nextName || nextName === currentName) {
      setRenameTarget(null);
      return;
    }
    const nextPath = joinRemotePath(parentDir(renameTarget.path), nextName);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke("sftp_rename_path", {
        sessionId,
        path: renameTarget.path,
        newPath: nextPath,
      });
      setNotice(`已重命名为: ${nextName}`);
      const targetParent = parentDir(renameTarget.path);
      if (currentPath === targetParent) {
        setEntries((prev) => {
          const next = prev.map((item) =>
            item.path === renameTarget.path
              ? {
                  ...item,
                  name: nextName,
                  path: nextPath,
                }
              : item,
          );
          next.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
          return next;
        });
      }
      if (currentPath === renameTarget.path) {
        setCurrentPath(nextPath);
      }
      if (selectedFile === renameTarget.path) {
        useSessionStore.getState().setSelectedFile(nextPath);
      }
      const dockApi = getDockApi();
      if (dockApi) {
        syncRenamedPathInEditors(dockApi, renameTarget.path, nextPath);
      }
      mutationSeqRef.current += 1;
      setMutation({
        id: mutationSeqRef.current,
        type: "rename",
        oldPath: renameTarget.path,
        newPath: nextPath,
        newName: nextName,
      });
      setRenameTarget(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [currentPath, renameTarget, renameValue, selectedFile, sessionId]);

  const openDeleteDialog = useCallback((entry: FileEntry) => {
    setDeleteTarget(entry);
  }, []);

  const openInfoDialog = useCallback((entry: FileEntry) => {
    setInfoTarget(entry);
  }, []);

  const destConnections = useMemo(
    () => connections.filter((item) => item.id !== connectionId),
    [connections, connectionId],
  );

  const connectedConnectionIds = useMemo(
    () => new Set(sessions.map((item) => item.connectionId)),
    [sessions],
  );

  const connectionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of connections) {
      map.set(item.id, `${item.name} (${item.host})`);
    }
    return map;
  }, [connections]);

  const ensureDestSession = useCallback(
    async (destConnId: string) => {
      const existing = sessions.find((item) => item.connectionId === destConnId);
      if (existing) return existing;
      return connectBackground(destConnId);
    },
    [connectBackground, sessions],
  );

  useEffect(() => {
    if (!remoteCopyTarget || !remoteCopyDestConnectionId) {
      setRemoteCopyDestSessionId("");
      setRemoteCopyDestHomePath("/");
      return;
    }
    let cancelled = false;
    setRemoteCopyDestConnecting(true);
    void ensureDestSession(remoteCopyDestConnectionId)
      .then((session) => {
        if (cancelled) return;
        setRemoteCopyDestSessionId(session.sessionId);
        setRemoteCopyDestHomePath(session.homePath);
        setRemoteCopyDestDir((prev) => (prev.trim() ? prev : session.homePath));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setRemoteCopyDestConnecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [remoteCopyTarget, remoteCopyDestConnectionId, ensureDestSession]);

  const openRemoteCopyDialog = useCallback(
    (entry: FileEntry) => {
      const first = destConnections[0];
      if (!first) {
        setError("请先在连接列表中添加另一台服务器");
        return;
      }
      setRemoteCopyTarget(entry);
      setRemoteCopyDestConnectionId(first.id);
      setRemoteCopyDestDir("");
      setRemoteCopyDestSessionId("");
      setRemoteCopyDestHomePath("/");
      setRemoteCopyCompress(false);
    },
    [destConnections],
  );

  const handleFolderTransferConfirm = useCallback(async () => {
    if (!folderTransferPrompt) return;
    const compress = folderTransferCompress;
    const prompt = folderTransferPrompt;
    setFolderTransferPrompt(null);
    if (prompt.kind === "download") {
      await executeDownload(prompt.entry, prompt.localPath, compress);
      return;
    }
    await executeUpload(
      prompt.localPath,
      prompt.remotePath,
      prompt.name,
      prompt.targetDir,
      true,
      compress,
    );
  }, [executeDownload, executeUpload, folderTransferCompress, folderTransferPrompt]);

  const handleRemoteCopySubmit = useCallback(async () => {
    if (!sessionId || !connectionId || !remoteCopyTarget) return;
    const destDir = remoteCopyDestDir.trim();
    if (!remoteCopyDestConnectionId) {
      setError("请选择目标远程连接");
      return;
    }
    if (!destDir) {
      setError("请输入目标远程目录");
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    const destPath = joinRemotePath(destDir, remoteCopyTarget.name);
    try {
      let destSession = sessions.find((item) => item.connectionId === remoteCopyDestConnectionId);
      if (!destSession) {
        destSession = await connectBackground(remoteCopyDestConnectionId);
      }
      const task = await invoke<TransferTaskSnapshot>("transfer_start_remote_copy", {
        sourceSessionId: sessionId,
        destConnectionId: remoteCopyDestConnectionId,
        sourcePath: remoteCopyTarget.path,
        destPath,
        compress: remoteCopyTarget.isDir ? remoteCopyCompress : false,
      });
      startTransfer({
        id: task.taskId,
        direction: "remote-copy",
        connectionId,
        sessionId,
        remotePath: remoteCopyTarget.path,
        destConnectionId: remoteCopyDestConnectionId,
        destSessionId: task.destSessionId ?? destSession.sessionId,
        destRemotePath: destPath,
        fileName: remoteCopyTarget.name,
        totalBytes: task.totalBytes ?? undefined,
      });
      setRemoteCopyTarget(null);
      const snapshot = await pollTransfer(task.taskId);
      if (snapshot.status === "success") {
        finishSuccess(task.taskId);
        setNotice(`已复制到远程: ${destPath}`);
      } else if (snapshot.status === "cancelled") {
        finishCancelled(task.taskId);
        setNotice("远程复制已取消");
      } else {
        finishFailed(task.taskId, snapshot.error ?? "远程复制失败");
        setError(snapshot.error ?? "远程复制失败");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [
    connectionId,
    connectBackground,
    finishCancelled,
    finishFailed,
    finishSuccess,
    pollTransfer,
    remoteCopyDestConnectionId,
    remoteCopyDestDir,
    remoteCopyCompress,
    remoteCopyTarget,
    sessions,
    sessionId,
    startTransfer,
  ]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!sessionId) return;
    if (!deleteTarget) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke("sftp_remove_path", {
        sessionId,
        path: deleteTarget.path,
        isDir: deleteTarget.isDir,
      });
      setNotice(`已删除: ${deleteTarget.name}`);
      const targetParent = parentDir(deleteTarget.path);
      if (currentPath === targetParent) {
        setEntries((prev) => prev.filter((item) => item.path !== deleteTarget.path));
      }
      if (selectedFile === deleteTarget.path) {
        useSessionStore.getState().setSelectedFile(null);
      }
      mutationSeqRef.current += 1;
      setMutation({
        id: mutationSeqRef.current,
        type: "delete",
        targetPath: deleteTarget.path,
      });
      setDeleteTarget(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [currentPath, deleteTarget, selectedFile, sessionId]);

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const targetDir = menu.entry.isDir ? menu.entry.path : parentDir(menu.entry.path);
    const remoteCopyItem = {
      label: "传输到另一 SSH…",
      disabled: destConnections.length === 0,
      action: () => openRemoteCopyDialog(menu.entry),
    };
    const dirItems = [
      {
        label: "上传文件到此目录",
        action: () => void startUpload(targetDir, false),
      },
      {
        label: "上传文件夹到此目录",
        action: () => void startUpload(targetDir, true),
      },
      {
        label: "下载目录",
        action: () => void handleDownload(menu.entry),
      },
      remoteCopyItem,
      {
        label: "重命名目录",
        action: () => openRenameDialog(menu.entry),
      },
      {
        label: "删除目录",
        action: () => openDeleteDialog(menu.entry),
      },
      {
        label: "文件信息",
        action: () => openInfoDialog(menu.entry),
      },
    ];
    const fileItems = [
      {
        label: "下载文件",
        action: () => void handleDownload(menu.entry),
      },
      remoteCopyItem,
      {
        label: "上传文件到所在目录",
        action: () => void startUpload(targetDir, false),
      },
      {
        label: "上传文件夹到所在目录",
        action: () => void startUpload(targetDir, true),
      },
      {
        label: "重命名文件",
        action: () => openRenameDialog(menu.entry),
      },
      {
        label: "删除文件",
        action: () => openDeleteDialog(menu.entry),
      },
      {
        label: "文件信息",
        action: () => openInfoDialog(menu.entry),
      },
    ];
    return menu.entry.isDir ? dirItems : fileItems;
  }, [
    handleDownload,
    menu,
    openDeleteDialog,
    openInfoDialog,
    openRemoteCopyDialog,
    openRenameDialog,
    destConnections.length,
    startUpload,
  ]);

  if (!sessionId || !homePath || !currentPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-zinc-500">
        请先连接服务器
      </div>
    );
  }

  const isAtHome = currentPath === homePath;
  const isAtRoot = currentPath === "/";

  return (
    <div className="flex flex-col h-full bg-zinc-950 border-r border-zinc-800">
      <div className="px-3 py-2 border-b border-zinc-800 shrink-0">
        <div className="text-sm font-medium text-zinc-300 mb-1">远程文件</div>
        <div
          className="text-xs text-zinc-500 font-mono truncate"
          title={currentPath}
        >
          {currentPath}
        </div>
        <div className="flex gap-2 mt-2">
          <button
            type="button"
            onClick={() => setCurrentPath(homePath)}
            disabled={isAtHome}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
              isAtHome
                ? "bg-zinc-800 text-zinc-400"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            <Home size={12} />
            主目录
          </button>
          <button
            type="button"
            onClick={() => setCurrentPath("/")}
            disabled={isAtRoot}
            className={`rounded px-2 py-0.5 text-xs ${
              isAtRoot
                ? "bg-zinc-800 text-zinc-400"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            / 系统根
          </button>
          <button
            type="button"
            onClick={refreshTree}
            disabled={loading || busy}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
              loading || busy
                ? "bg-zinc-800 text-zinc-400"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            }`}
            title="刷新当前目录"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            刷新
          </button>
        </div>
        {(busy || notice) && (
          <div className="mt-2 text-xs">
            {busy && <span className="text-blue-300">处理中...</span>}
            {!busy && notice && <span className="text-emerald-300">{notice}</span>}
          </div>
        )}
      </div>
      <div className="remote-file-tree-scroll flex-1 overflow-auto py-1">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-zinc-500">
            <Loader2 size={16} className="animate-spin" />
            加载中…
          </div>
        )}
        {error && !loading && (
          <p className="px-3 py-2 text-xs text-red-400">{error}</p>
        )}
        {!loading &&
          !error &&
          entries.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-500">目录为空</p>
          )}
        {!loading &&
          entries.map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              sessionId={sessionId}
              onSelect={onFileSelect}
              selectedPath={selectedFile}
              reloadKey={reloadKey}
              mutation={mutation}
              onContextMenu={(target, event) => {
                const itemHeight = 34;
                const itemCount = target.isDir ? 7 : 7;
                const menuHeight = itemHeight * itemCount + 8;
                const menuWidth = 220;
                let x = event.clientX;
                let y = event.clientY;
                if (x + menuWidth > window.innerWidth) {
                  x = Math.max(8, x - menuWidth);
                }
                if (y + menuHeight > window.innerHeight) {
                  y = Math.max(8, y - menuHeight);
                }
                setMenu({
                  entry: target,
                  x,
                  y,
                });
              }}
            />
          ))}
      </div>
      {menu && (
        <div
          className="fixed z-[200] min-w-44 max-h-[min(70vh,360px)] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`block w-full px-3 py-1.5 text-left text-sm text-zinc-200 ${
                "disabled" in item && item.disabled
                  ? "cursor-not-allowed opacity-40"
                  : "hover:bg-zinc-800"
              }`}
              onClick={() => {
                setMenu(null);
                item.action();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {renameTarget && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/40"
          onClick={() => setRenameTarget(null)}
        >
          <div
            className="w-[360px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm font-medium text-zinc-100">
              重命名{renameTarget.isDir ? "目录" : "文件"}
            </div>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRenameSubmit();
                }
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                onClick={() => setRenameTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
                onClick={() => void handleRenameSubmit()}
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[230] flex items-center justify-center bg-black/40"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            className="w-[380px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-medium text-zinc-100">
              确认删除{deleteTarget.isDir ? "目录" : "文件"}
            </div>
            <div className="mb-4 text-sm text-zinc-300 break-all">
              {deleteTarget.name}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-500"
                onClick={() => void handleDeleteConfirm()}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
      {infoTarget && (
        <div
          className="fixed inset-0 z-[240] flex items-center justify-center bg-black/40"
          onClick={() => setInfoTarget(null)}
        >
          <div
            className="w-[480px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm font-medium text-zinc-100">文件信息</div>
            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-zinc-400">名称</span>
                <span className="text-zinc-100 break-all">{infoTarget.name}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-zinc-400">路径</span>
                <span className="text-zinc-100 break-all">{infoTarget.path}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-zinc-400">类型</span>
                <span className="text-zinc-100">{infoTarget.isDir ? "目录" : "文件"}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-zinc-400">大小</span>
                <span className="text-zinc-100">
                  {infoTarget.isDir ? "--" : `${infoTarget.size ?? 0} bytes`}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <span className="w-16 shrink-0 text-zinc-400">修改时间</span>
                <span className="text-zinc-100">
                  {infoTarget.modified
                    ? new Date(infoTarget.modified * 1000).toLocaleString()
                    : "--"}
                </span>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
                onClick={() => setInfoTarget(null)}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
      {folderTransferPrompt && (
        <div
          className="fixed inset-0 z-[245] flex items-center justify-center bg-black/40"
          onClick={() => setFolderTransferPrompt(null)}
        >
          <div
            className="w-[420px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 text-sm font-medium text-zinc-100">
              {folderTransferPrompt.kind === "download" ? "下载文件夹" : "上传文件夹"}
            </div>
            <div className="mb-4 text-xs text-zinc-400 break-all">
              {folderTransferPrompt.kind === "download"
                ? folderTransferPrompt.entry.path
                : folderTransferPrompt.localPath}
            </div>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={folderTransferCompress}
                onChange={(e) => setFolderTransferCompress(e.target.checked)}
                className="rounded border-zinc-600"
              />
              压缩后传输 (tar.gz)
            </label>
            <p className="mt-2 text-[11px] text-zinc-500">
              先打包为 tar.gz 再传输，适合大量小文件；远程需安装 tar 命令。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                onClick={() => setFolderTransferPrompt(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
                onClick={() => void handleFolderTransferConfirm()}
              >
                开始传输
              </button>
            </div>
          </div>
        </div>
      )}
      {remoteCopyTarget && (
        <div
          className="fixed inset-0 z-[250] flex items-center justify-center bg-black/40"
          onClick={() => setRemoteCopyTarget(null)}
        >
          <div
            className="w-[560px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-sm font-medium text-zinc-100">
              传输到另一 SSH{remoteCopyTarget.isDir ? "（目录）" : "（文件）"}
            </div>
            <div className="mb-3 text-xs text-zinc-400 break-all">
              源: {remoteCopyTarget.path}
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-zinc-400">目标连接</label>
                <select
                  value={remoteCopyDestConnectionId}
                  onChange={(e) => {
                    setRemoteCopyDestConnectionId(e.target.value);
                    setRemoteCopyDestDir("");
                    setRemoteCopyDestSessionId("");
                  }}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                >
                  {destConnections.map((item) => (
                    <option key={item.id} value={item.id}>
                      {connectionLabelById.get(item.id) ?? item.id}
                      {connectedConnectionIds.has(item.id) ? "" : " · 未连接"}
                    </option>
                  ))}
                </select>
                {remoteCopyDestConnecting && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500">
                    <Loader2 size={12} className="animate-spin" />
                    正在连接目标服务器…
                  </div>
                )}
              </div>
              <RemotePathPicker
                sessionId={remoteCopyDestSessionId}
                homePath={remoteCopyDestHomePath}
                value={remoteCopyDestDir}
                onChange={setRemoteCopyDestDir}
                disabled={busy || remoteCopyDestConnecting || !remoteCopyDestSessionId}
              />
              <div className="text-[11px] text-zinc-500 break-all">
                将复制为: {joinRemotePath(remoteCopyDestDir.trim() || "/", remoteCopyTarget.name)}
              </div>
              {remoteCopyTarget.isDir && (
                <label className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={remoteCopyCompress}
                    onChange={(e) => setRemoteCopyCompress(e.target.checked)}
                    className="rounded border-zinc-600"
                  />
                  压缩后传输 (tar.gz)
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                onClick={() => setRemoteCopyTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40"
                disabled={busy || remoteCopyDestConnecting || !remoteCopyDestSessionId}
                onClick={() => void handleRemoteCopySubmit()}
              >
                开始传输
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
