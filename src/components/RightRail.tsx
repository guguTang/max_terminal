import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Container,
  FolderSync,
} from "lucide-react";

export type RightPanelKind = "transfer" | "docker" | null;

interface RightRailProps {
  active: RightPanelKind;
  onSelect: (panel: "transfer" | "docker") => void;
  onCollapse: () => void;
}

export function RightRail({ active, onSelect, onCollapse }: RightRailProps) {
  const anyOpen = active !== null;

  return (
    <div className="h-full w-10 border-l border-zinc-800 bg-zinc-950 flex flex-col items-center py-2 gap-2 shrink-0">
      <button
        type="button"
        onClick={() => onSelect("transfer")}
        className={`rounded-md p-2 transition-colors ${
          active === "transfer"
            ? "bg-blue-600 text-white"
            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        }`}
        title="传输管理"
      >
        <FolderSync size={16} />
      </button>
      <button
        type="button"
        onClick={() => onSelect("docker")}
        className={`rounded-md p-2 transition-colors ${
          active === "docker"
            ? "bg-blue-600 text-white"
            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        }`}
        title="Docker 管理"
      >
        <Container size={16} />
      </button>
      <button
        type="button"
        onClick={() => {
          if (anyOpen) onCollapse();
          else onSelect("transfer");
        }}
        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 mt-auto"
        title={anyOpen ? "收起右侧面板" : "展开传输面板"}
      >
        {anyOpen ? <ArrowRightToLine size={14} /> : <ArrowLeftToLine size={14} />}
      </button>
    </div>
  );
}
