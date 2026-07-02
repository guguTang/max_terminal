import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TerminalOutputEvent } from "../types/connection";
import { useTerminalOutputStore } from "../stores/terminalOutputStore";

/** 全局缓冲所有 SSH 终端输出，切换连接时面板卸载后仍能保留内容 */
export function TerminalOutputBridge() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void listen<TerminalOutputEvent>("terminal-output", (event) => {
      const { sessionId, terminalId, data } = event.payload;
      useTerminalOutputStore.getState().append(sessionId, terminalId, data);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  return null;
}
