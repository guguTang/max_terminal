import React from "react";
import type { IDockviewPanelHeaderProps } from "dockview";
import { useSessionStore } from "../stores/sessionStore";
import { useTerminalTitleStore } from "../stores/terminalTitleStore";

type EditableDockTabProps = IDockviewPanelHeaderProps &
  React.HtmlHTMLAttributes<HTMLDivElement> & {
    hideClose?: boolean;
    closeActionOverride?: () => void;
  };

function usePanelTitle(api: IDockviewPanelHeaderProps["api"]) {
  const [title, setTitle] = React.useState(api.title ?? "");

  React.useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title);
    });
    if (title !== (api.title ?? "")) {
      setTitle(api.title ?? "");
    }
    return () => {
      disposable.dispose();
    };
  }, [api, title]);

  return title;
}

function isTerminalTab(props: IDockviewPanelHeaderProps) {
  return props.api.id.startsWith("terminal");
}

export function EditableDockTab(props: EditableDockTabProps) {
  const {
    api,
    containerApi: _containerApi,
    params: _params,
    hideClose,
    closeActionOverride,
    onPointerDown,
    onPointerUp,
    onPointerLeave,
    tabLocation: _tabLocation,
    ...rest
  } = props;
  const title = usePanelTitle(api);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const isMiddleMouseButton = React.useRef(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const terminalTab = isTerminalTab(props);

  React.useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const onClose = React.useCallback(
    (event: React.MouseEvent | React.PointerEvent) => {
      event.preventDefault();
      if (closeActionOverride) {
        closeActionOverride();
      } else {
        api.close();
      }
    },
    [api, closeActionOverride],
  );

  const onBtnPointerDown = React.useCallback((event: React.PointerEvent) => {
    event.preventDefault();
  }, []);

  const _onPointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      isMiddleMouseButton.current = event.button === 1;
      onPointerDown?.(event);
    },
    [onPointerDown],
  );

  const _onPointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (isMiddleMouseButton.current && event.button === 1 && !hideClose) {
        isMiddleMouseButton.current = false;
        onClose(event);
      }
      onPointerUp?.(event);
    },
    [hideClose, onClose, onPointerUp],
  );

  const _onPointerLeave = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      isMiddleMouseButton.current = false;
      onPointerLeave?.(event);
    },
    [onPointerLeave],
  );

  const startEdit = React.useCallback(
    (event: React.MouseEvent) => {
      if (!terminalTab) return;
      event.stopPropagation();
      setDraft(title);
      setEditing(true);
    },
    [terminalTab, title],
  );

  const commitEdit = React.useCallback(() => {
    if (!editing) return;
    const next = draft.trim();
    if (next) {
      api.setTitle(next);
      if (terminalTab) {
        const connectionId = useSessionStore.getState().connectionId;
        const terminalId = String((props.params as { terminalId?: string } | undefined)?.terminalId ?? "main");
        if (connectionId) {
          useTerminalTitleStore.getState().setTitle(connectionId, terminalId, next);
        }
      }
    }
    setEditing(false);
  }, [api, draft, editing, props.params, terminalTab]);

  const cancelEdit = React.useCallback(() => {
    setDraft(title);
    setEditing(false);
  }, [title]);

  return (
    <div
      data-testid="dockview-dv-default-tab"
      {...rest}
      onPointerDown={_onPointerDown}
      onPointerUp={_onPointerUp}
      onPointerLeave={_onPointerLeave}
      className="dv-default-tab"
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitEdit}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitEdit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          className="h-5 min-w-16 max-w-40 rounded border border-zinc-600 bg-zinc-900 px-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
        />
      ) : (
        <span
          className={`dv-default-tab-content ${terminalTab ? "cursor-text" : ""}`}
          onDoubleClick={startEdit}
          title={terminalTab ? "双击修改终端名称" : undefined}
        >
          {title}
        </span>
      )}
      {!hideClose && (
        <div className="dv-default-tab-action" onPointerDown={onBtnPointerDown} onClick={onClose}>
          <span aria-hidden>×</span>
        </div>
      )}
    </div>
  );
}
