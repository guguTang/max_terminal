import { ArrowLeftToLine, ArrowRightToLine, FolderSync } from "lucide-react";

interface TransferRailProps {
  open: boolean;
  onToggle: () => void;
}

export function TransferRail({ open, onToggle }: TransferRailProps) {
  return (
    <div className="h-full w-10 border-l border-zinc-800 bg-zinc-950 flex flex-col items-center py-2 gap-2 shrink-0">
      <button
        type="button"
        onClick={onToggle}
        className={`rounded-md p-2 transition-colors ${
          open
            ? "bg-blue-600 text-white"
            : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        }`}
        title="传输管理"
      >
        <FolderSync size={16} />
      </button>
      <button
        type="button"
        onClick={onToggle}
        className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        title={open ? "收起传输面板" : "展开传输面板"}
      >
        {open ? <ArrowRightToLine size={14} /> : <ArrowLeftToLine size={14} />}
      </button>
    </div>
  );
}
