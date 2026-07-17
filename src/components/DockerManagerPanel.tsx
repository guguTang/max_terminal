import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalMetaStore } from "../stores/terminalMetaStore";
import { addNewTerminal, getDockApi } from "../layout/dockApi";

export interface DockerContainerInfo {
  id: string;
  names: string;
  image: string;
  status: string;
  state: string;
  ports?: string;
  created?: string;
}

export interface DockerImageInfo {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created?: string;
}

type TabKind = "containers" | "images";

function shortId(id: string) {
  return id.length > 12 ? id.slice(0, 12) : id;
}

function containerDisplayName(container: DockerContainerInfo) {
  const name = container.names.trim();
  return name || shortId(container.id);
}

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function stateDotClass(state: string) {
  if (state === "running") return "bg-emerald-400";
  if (state === "exited" || state === "dead") return "bg-zinc-500";
  if (state === "paused") return "bg-amber-400";
  return "bg-blue-400";
}

function buildEnterCommand(containerRef: string) {
  const q = shellSingleQuote(containerRef);
  // Single `docker exec -it` so the PTY stays attached. Avoid `2>/dev/null ||`
  // compound commands (easy to fail silently / drop -t). After exit, print a
  // standalone leave marker line for the context bar to clear MX_DOCKER_*.
  return (
    `docker exec -it ${q} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'; ` +
    `printf '%s\\n' '__MX_DOCKER_LEAVE__'`
  );
}

export function DockerManagerPanel() {
  const sessionId = useSessionStore((s) => s.sessionId);
  const connectionId = useSessionStore((s) => s.connectionId);
  const [tab, setTab] = useState<TabKind>("containers");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [containers, setContainers] = useState<DockerContainerInfo[]>([]);
  const [images, setImages] = useState<DockerImageInfo[]>([]);
  const [enteringId, setEnteringId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setError("请先连接 SSH");
      setContainers([]);
      setImages([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (tab === "containers") {
        const list = await invoke<DockerContainerInfo[]>("docker_list_containers", {
          sessionId,
        });
        setContainers(list);
      } else {
        const list = await invoke<DockerImageInfo[]>("docker_list_images", { sessionId });
        setImages(list);
      }
    } catch (e) {
      setError(String(e));
      if (tab === "containers") setContainers([]);
      else setImages([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId, tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleEnter = useCallback(
    async (container: DockerContainerInfo) => {
      if (!sessionId || !connectionId) {
        setError("请先连接 SSH");
        return;
      }
      const api = getDockApi();
      if (!api) {
        setError("工作区尚未就绪");
        return;
      }
      if (container.state !== "running") {
        setError("只能进入运行中的容器");
        return;
      }

      setEnteringId(container.id);
      setError(null);
      try {
        const displayName = containerDisplayName(container);
        // Prefer first name when docker returns comma-separated aliases.
        const containerRef = displayName.split(",")[0]?.trim() || shortId(container.id);
        const title = `docker:${containerRef}`;
        const terminalId = addNewTerminal(api, undefined, undefined, {
          initialCommand: buildEnterCommand(containerRef),
          title,
        });
        useTerminalMetaStore.getState().patchMeta(sessionId, terminalId, {
          env: {
            MX_DOCKER_CONTAINER: containerRef,
            MX_DOCKER_ID: shortId(container.id),
          },
        });
      } catch (e) {
        setError(String(e));
      } finally {
        setEnteringId(null);
      }
    },
    [connectionId, sessionId],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5 shrink-0">
        <button
          type="button"
          onClick={() => setTab("containers")}
          className={`rounded-md px-2.5 py-1 text-xs ${
            tab === "containers"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
        >
          容器
        </button>
        <button
          type="button"
          onClick={() => setTab("images")}
          className={`rounded-md px-2.5 py-1 text-xs ${
            tab === "images"
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
          }`}
        >
          镜像
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading || !sessionId}
          className="ml-auto rounded-md p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 disabled:opacity-40"
          title="刷新"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {error && (
        <p className="shrink-0 border-b border-zinc-900 px-3 py-2 text-xs text-red-400 break-words">
          {error}
        </p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-500">
            <Loader2 size={16} className="animate-spin" />
            加载中…
          </div>
        )}

        {!loading && tab === "containers" && containers.length === 0 && !error && (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">暂无容器</p>
        )}

        {!loading &&
          tab === "containers" &&
          containers.map((item) => {
            const running = item.state === "running";
            const busy = enteringId === item.id;
            const name = containerDisplayName(item);
            const statusLine = `${shortId(item.id)} · ${item.status}`;
            return (
              <div
                key={item.id}
                className="flex items-start gap-2 border-b border-zinc-900 px-3 py-2 hover:bg-zinc-900/60"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${stateDotClass(item.state)}`}
                  title={item.state}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-100" title={name}>
                    {name}
                  </div>
                  <div className="truncate text-[11px] text-zinc-500" title={item.image}>
                    {item.image}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-zinc-600" title={statusLine}>
                    {statusLine}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!running || busy}
                  onClick={() => void handleEnter(item)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  title={running ? "进入容器 (bash/sh)" : "容器未运行"}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  进入
                </button>
              </div>
            );
          })}

        {!loading && tab === "images" && images.length === 0 && !error && (
          <p className="px-3 py-6 text-center text-xs text-zinc-500">暂无镜像</p>
        )}

        {!loading &&
          tab === "images" &&
          images.map((item) => {
            const repoTag = `${item.repository}:${item.tag}`;
            const metaLine = [shortId(item.id), item.size, item.created]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={`${item.id}-${item.repository}-${item.tag}`}
                className="border-b border-zinc-900 px-3 py-2 hover:bg-zinc-900/60"
              >
                <div className="truncate text-sm text-zinc-100" title={repoTag}>
                  {repoTag}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-zinc-500" title={metaLine}>
                  {metaLine}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
