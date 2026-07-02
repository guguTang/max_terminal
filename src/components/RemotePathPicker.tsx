import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronUp, Folder, Home, Loader2 } from "lucide-react";
import type { FileEntry } from "../types/connection";

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

function pathParentAndPrefix(path: string) {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return { parent: "/", prefix: "" };
  }
  if (trimmed.endsWith("/")) {
    const parent = trimmed.replace(/\/+$/, "") || "/";
    return { parent, prefix: "" };
  }
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {
    return { parent: "/", prefix: trimmed.slice(1) };
  }
  return { parent: trimmed.slice(0, idx) || "/", prefix: trimmed.slice(idx + 1) };
}

interface RemotePathPickerProps {
  sessionId: string;
  homePath: string;
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}

export function RemotePathPicker({
  sessionId,
  homePath,
  value,
  onChange,
  disabled = false,
}: RemotePathPickerProps) {
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(homePath);
  const [browseEntries, setBrowseEntries] = useState<FileEntry[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  const browseDirs = useMemo(
    () => browseEntries.filter((item) => item.isDir).sort((a, b) => a.name.localeCompare(b.name)),
    [browseEntries],
  );

  const loadBrowseDir = useCallback(
    async (path: string) => {
      if (!sessionId) return;
      setBrowseLoading(true);
      setBrowseError(null);
      try {
        const items = await invoke<FileEntry[]>("sftp_list_dir", { sessionId, path });
        setBrowseEntries(items);
      } catch (e) {
        setBrowseError(String(e));
        setBrowseEntries([]);
      } finally {
        setBrowseLoading(false);
      }
    },
    [sessionId],
  );

  const loadSuggestions = useCallback(
    async (inputValue: string) => {
      if (!sessionId) return;
      const { parent, prefix } = pathParentAndPrefix(inputValue);
      setSuggestionsLoading(true);
      try {
        const items = await invoke<FileEntry[]>("sftp_list_dir", { sessionId, path: parent });
        const dirs = items
          .filter((item) => item.isDir)
          .map((item) => joinRemotePath(parent, item.name))
          .filter((path) => !prefix || path.split("/").pop()?.startsWith(prefix))
          .sort((a, b) => a.localeCompare(b));
        setSuggestions(dirs.slice(0, 12));
        setActiveSuggestion(0);
      } catch {
        setSuggestions([]);
      } finally {
        setSuggestionsLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!browseOpen) return;
    void loadBrowseDir(browsePath);
  }, [browseOpen, browsePath, loadBrowseDir]);

  useEffect(() => {
    setBrowsePath(value.trim() || homePath);
  }, [sessionId, homePath]);

  useEffect(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    if (!suggestionsOpen || disabled) return;
    debounceRef.current = window.setTimeout(() => {
      void loadSuggestions(value);
    }, 180);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [disabled, loadSuggestions, suggestionsOpen, value]);

  const applySuggestion = useCallback(
    (path: string) => {
      onChange(path);
      setSuggestionsOpen(false);
      inputRef.current?.focus();
    },
    [onChange],
  );

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestionsOpen || suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion((prev) => Math.max(prev - 1, 0));
    } else if (event.key === "Tab" || event.key === "Enter") {
      if (suggestions[activeSuggestion]) {
        event.preventDefault();
        applySuggestion(suggestions[activeSuggestion]);
      }
    } else if (event.key === "Escape") {
      setSuggestionsOpen(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="block text-xs text-zinc-400">目标远程目录</label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            const next = !browseOpen;
            setBrowseOpen(next);
            if (next) {
              setBrowsePath(value.trim() || homePath);
            }
          }}
          className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
        >
          {browseOpen ? "收起浏览" : "浏览目录"}
        </button>
      </div>

      <div className="relative">
        <input
          ref={inputRef}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            setSuggestionsOpen(true);
          }}
          onFocus={() => setSuggestionsOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setSuggestionsOpen(false), 120);
          }}
          onKeyDown={handleInputKeyDown}
          placeholder="/path/to/destination"
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 disabled:opacity-50"
        />
        {suggestionsOpen && (suggestions.length > 0 || suggestionsLoading) && (
          <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-10 max-h-44 overflow-auto rounded-md border border-zinc-700 bg-zinc-950 py-1 shadow-xl">
            {suggestionsLoading && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-zinc-500">
                <Loader2 size={12} className="animate-spin" />
                加载补全…
              </div>
            )}
            {!suggestionsLoading &&
              suggestions.map((path, index) => (
                <button
                  key={path}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    index === activeSuggestion
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-300 hover:bg-zinc-800"
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySuggestion(path)}
                >
                  <Folder size={12} className="shrink-0 text-amber-400" />
                  <span className="truncate font-mono">{path}</span>
                </button>
              ))}
          </div>
        )}
      </div>

      {browseOpen && (
        <div className="rounded-md border border-zinc-700 bg-zinc-950">
          <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-2 py-1.5">
            <button
              type="button"
              disabled={disabled || browseLoading}
              onClick={() => setBrowsePath(homePath)}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              <Home size={12} />
              主目录
            </button>
            <button
              type="button"
              disabled={disabled || browseLoading}
              onClick={() => setBrowsePath("/")}
              className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              / 根目录
            </button>
            <button
              type="button"
              disabled={disabled || browseLoading || browsePath === "/"}
              onClick={() => setBrowsePath(parentDir(browsePath))}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            >
              <ChevronUp size={12} />
              上级
            </button>
          </div>
          <div
            className="border-b border-zinc-800 px-3 py-1.5 text-[11px] font-mono text-zinc-500 truncate"
            title={browsePath}
          >
            {browsePath}
          </div>
          <div className="max-h-40 overflow-auto py-1">
            {browseLoading && (
              <div className="flex items-center justify-center gap-2 py-4 text-xs text-zinc-500">
                <Loader2 size={14} className="animate-spin" />
                加载目录…
              </div>
            )}
            {browseError && !browseLoading && (
              <div className="px-3 py-2 text-xs text-red-400 break-all">{browseError}</div>
            )}
            {!browseLoading && !browseError && browseDirs.length === 0 && (
              <div className="px-3 py-2 text-xs text-zinc-500">当前目录下没有子目录</div>
            )}
            {!browseLoading &&
              !browseError &&
              browseDirs.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  disabled={disabled}
                  onClick={() => setBrowsePath(entry.path)}
                  onDoubleClick={() => {
                    onChange(entry.path);
                    setBrowseOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
                >
                  <Folder size={14} className="shrink-0 text-amber-400" />
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
          </div>
          <div className="border-t border-zinc-800 px-2 py-1.5">
            <button
              type="button"
              disabled={disabled || browseLoading}
              onClick={() => {
                onChange(browsePath);
                setBrowseOpen(false);
              }}
              className="w-full rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
            >
              选择当前目录
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
