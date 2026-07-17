import { useEffect, useState } from "react";
import {
  Box,
  Clock,
  Code2,
  Container,
  FolderGit2,
  GitBranch,
  Layers,
  Package,
  Server,
} from "lucide-react";
import { shortenCwd, useTerminalContext, venvDisplayName } from "../hooks/useTerminalContext";

interface TerminalContextBarProps {
  sessionId: string;
  terminalId: string;
  kind: "ssh" | "local";
  homePath?: string | null;
  /** 终端组件实时跟踪的 cwd，优先于 store 快照 */
  liveCwd?: string;
}

interface ChipProps {
  icon: React.ReactNode;
  label: string;
  title?: string;
  className?: string;
  onClick?: () => void;
}

function Chip({ icon, label, title, className = "", onClick }: ChipProps) {
  return (
    <button
      type="button"
      title={title ?? label}
      onClick={onClick}
      className={`inline-flex max-w-[220px] shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${onClick ? "cursor-pointer hover:bg-zinc-800" : "cursor-default"} ${className}`}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function ClockChip() {
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTime(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Chip
      icon={<Clock size={12} />}
      label={time}
      className="text-zinc-500"
    />
  );
}

export function TerminalContextBar({
  sessionId,
  terminalId,
  kind,
  homePath,
  liveCwd,
}: TerminalContextBarProps) {
  const { cwd, condaEnv, virtualEnv, pyenvFromEnv, nodeVersion, docker, remote, git } =
    useTerminalContext(sessionId, terminalId, true, liveCwd, kind);

  const copyCwd = async () => {
    if (!cwd) return;
    try {
      await navigator.clipboard.writeText(cwd);
    } catch {
      // ignore
    }
  };

  const pyenvVersion = pyenvFromEnv ?? remote.pyenv?.version;

  const hasChips =
    Boolean(cwd) ||
    Boolean(git) ||
    Boolean(remote.svn) ||
    Boolean(remote.k8s) ||
    Boolean(docker) ||
    Boolean(condaEnv) ||
    Boolean(virtualEnv) ||
    Boolean(pyenvVersion) ||
    Boolean(nodeVersion);

  if (!hasChips && kind === "ssh") {
    return (
      <div className="flex h-7 shrink-0 items-center border-b border-zinc-800/80 bg-zinc-950/90 px-2">
        <span className="text-[11px] text-zinc-600">加载上下文…</span>
      </div>
    );
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/90 px-2">
      {cwd ? (
        <Chip
          icon={<FolderGit2 size={12} />}
          label={shortenCwd(cwd, homePath)}
          title={cwd}
          className="text-zinc-300"
          onClick={copyCwd}
        />
      ) : null}

      {git?.branch ? (
        <Chip
          icon={<GitBranch size={12} />}
          label={
            git.dirtyCount > 0
              ? `${git.branch} ●${git.dirtyCount}`
              : git.branch
          }
          title={`Git 分支 ${git.branch}${git.dirtyCount > 0 ? `，${git.dirtyCount} 个未提交变更` : ""}`}
          className={git.dirtyCount > 0 ? "text-amber-400/90" : "text-emerald-400/90"}
        />
      ) : null}

      {remote.svn?.branch ? (
        <Chip
          icon={<GitBranch size={12} />}
          label={
            remote.svn.dirtyCount > 0
              ? `${remote.svn.branch} ●${remote.svn.dirtyCount}`
              : remote.svn.branch
          }
          className={remote.svn.dirtyCount > 0 ? "text-amber-400/90" : "text-orange-400/90"}
        />
      ) : null}

      {condaEnv ? (
        <Chip
          icon={<Package size={12} />}
          label={`conda: ${condaEnv}`}
          title={`Conda 环境 ${condaEnv}`}
          className="text-sky-400/90"
        />
      ) : null}

      {virtualEnv ? (
        <Chip
          icon={<Code2 size={12} />}
          label={`venv: ${venvDisplayName(virtualEnv)}`}
          title={`Python 虚拟环境 ${virtualEnv}`}
          className="text-teal-400/90"
        />
      ) : null}

      {pyenvVersion ? (
        <Chip
          icon={<Code2 size={12} />}
          label={`py: ${pyenvVersion}`}
          title={`pyenv ${pyenvVersion}`}
          className="text-yellow-400/80"
        />
      ) : null}

      {nodeVersion ? (
        <Chip
          icon={<Box size={12} />}
          label={`node: ${nodeVersion}`}
          title={`Node ${nodeVersion}`}
          className="text-lime-400/80"
        />
      ) : null}

      {remote.k8s ? (
        <Chip
          icon={<Layers size={12} />}
          label={`k8s: ${remote.k8s.context}`}
          title={`Kubernetes context ${remote.k8s.context}`}
          className="text-violet-400/90"
        />
      ) : null}

      {docker ? (
        <Chip
          icon={<Container size={12} />}
          label={`docker: ${docker.name}`}
          title={
            docker.id
              ? `容器内 ${docker.name} (${docker.id})`
              : `容器内 ${docker.name}`
          }
          className="text-cyan-400/90"
        />
      ) : null}

      {kind === "ssh" ? (
        <Chip
          icon={<Server size={12} />}
          label="ssh"
          className="text-zinc-600"
        />
      ) : null}

      <div className="ml-auto shrink-0">
        <ClockChip />
      </div>
    </div>
  );
}
