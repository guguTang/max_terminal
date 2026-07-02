import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { Save, Loader2, FileWarning, Image as ImageIcon, Music2 } from "lucide-react";
import { isTextFile, languageForPath } from "../types/connection";
import { useSessionStore } from "../stores/sessionStore";

interface FileEditorProps {
  filePath: string;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".m4a",
  ".aac",
  ".flac",
]);

function extension(path: string) {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? path.slice(idx).toLowerCase() : "";
}

function detectPreviewType(path: string): "text" | "image" | "audio" | "unsupported" {
  const ext = extension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (isTextFile(path)) return "text";
  return "unsupported";
}

function mimeTypeFor(path: string) {
  const ext = extension(path);
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  return map[ext] ?? "application/octet-stream";
}

function base64ToBlobUrl(base64: string, mimeType: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

export function FileEditor({ filePath }: FileEditorProps) {
  const { sessionId } = useSessionStore();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewType = detectPreviewType(filePath);
  const isDirty = content !== savedContent;
  const canSaveText = previewType === "text";

  useEffect(() => {
    if (!filePath || !sessionId) {
      setContent("");
      setSavedContent("");
      setPreviewUrl(null);
      setError(null);
      return;
    }

    if (previewType === "unsupported") {
      setError("不支持预览此类型的文件");
      setContent("");
      setSavedContent("");
      setPreviewUrl(null);
      return;
    }

    const load = async () => {
      setLoading(true);
      setError(null);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
      }
      try {
        if (previewType === "text") {
          const text = await invoke<string>("sftp_read_file", {
            sessionId,
            path: filePath,
          });
          setContent(text);
          setSavedContent(text);
        } else {
          const base64 = await invoke<string>("sftp_read_file_base64", {
            sessionId,
            path: filePath,
          });
          const url = base64ToBlobUrl(base64, mimeTypeFor(filePath));
          setPreviewUrl(url);
          setContent("");
          setSavedContent("");
        }
      } catch (e) {
        setError(String(e));
        setContent("");
        setSavedContent("");
        setPreviewUrl(null);
      } finally {
        setLoading(false);
      }
    };
    load();
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, sessionId, previewType]);

  const handleSave = async () => {
    if (!filePath || !sessionId || previewType !== "text") return;
    setSaving(true);
    try {
      await invoke("sftp_write_file", {
        sessionId,
        path: filePath,
        content,
      });
      setSavedContent(content);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!filePath) {
    return null;
  }

  return (
    <div className="flex flex-col h-full bg-zinc-900">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-950">
        <span className="text-xs text-zinc-400 truncate flex-1 font-mono">
          {filePath}
        </span>
        {isDirty && (
          <span className="text-xs text-amber-400 shrink-0">未保存</span>
        )}
        <button
          onClick={handleSave}
          disabled={!canSaveText || !isDirty || saving || !!error}
          className="flex items-center gap-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 px-2 py-1 text-xs"
        >
          {saving ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Save size={12} />
          )}
          保存
        </button>
      </div>

      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/80 z-10">
            <Loader2 size={24} className="animate-spin text-blue-400" />
          </div>
        )}
        {error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-400">
            <FileWarning size={32} className="text-amber-400" />
            <p className="text-sm">{error}</p>
          </div>
        ) : previewType === "image" && previewUrl ? (
          <div className="relative h-full w-full overflow-auto bg-zinc-900">
            <div className="absolute inset-0 flex items-center justify-center p-1">
              <img
                src={previewUrl}
                alt={filePath}
                className="block h-auto w-auto max-h-full max-w-full object-contain select-none"
              />
            </div>
          </div>
        ) : previewType === "audio" && previewUrl ? (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900">
            <div className="w-full max-w-xl rounded-lg border border-zinc-700 bg-zinc-950 p-4">
              <div className="mb-3 flex items-center gap-2 text-zinc-300">
                <Music2 size={16} />
                <span className="truncate text-sm">{filePath}</span>
              </div>
              <audio controls className="w-full" src={previewUrl} />
            </div>
          </div>
        ) : previewType === "image" ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-zinc-400">
            <ImageIcon size={32} className="text-zinc-500" />
            <p className="text-sm">图片加载中…</p>
          </div>
        ) : (
          <Editor
            height="100%"
            language={languageForPath(filePath)}
            value={content}
            onChange={(v) => setContent(v ?? "")}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              wordWrap: "on",
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
