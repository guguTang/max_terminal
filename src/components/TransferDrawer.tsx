import { X } from "lucide-react";
import { TransferManagerPanel } from "./TransferManagerPanel";

interface TransferDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function TransferDrawer({ open, onClose }: TransferDrawerProps) {
  return (
    <div
      className={`h-full border-l border-zinc-800 bg-zinc-950 transition-all duration-200 overflow-hidden ${
        open ? "w-[22rem]" : "w-0"
      }`}
    >
      <div className="h-full w-[22rem] flex flex-col">
        <div className="h-10 px-3 border-b border-zinc-800 flex items-center justify-between shrink-0">
          <span className="text-sm font-medium text-zinc-200">传输管理</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            title="关闭传输管理"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          <TransferManagerPanel />
        </div>
      </div>
    </div>
  );
}
