import { useEffect, useState } from "react";

type UpdateState =
  | { status: "idle" }
  | { status: "available"; version: string }
  | { status: "downloading"; percent: number }
  | { status: "ready"; version: string }
  | { status: "error"; message: string };

function getAPI() {
  const w = window as unknown as {
    electronAPI?: { updater?: Record<string, unknown>; isElectron?: boolean };
  };
  return w.electronAPI?.isElectron ? w.electronAPI : null;
}

export default function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const api = getAPI();
    if (!api?.updater) return;

    const updater = api.updater as {
      onUpdateAvailable: (
        cb: (info: { version: string }) => void,
      ) => () => void;
      onDownloadProgress: (cb: (p: { percent: number }) => void) => () => void;
      onUpdateDownloaded: (
        cb: (info: { version: string }) => void,
      ) => () => void;
      onError: (cb: (msg: string) => void) => () => void;
    };

    const unsubs = [
      updater.onUpdateAvailable((info) => {
        setState({ status: "available", version: info.version });
        setDismissed(false);
      }),
      updater.onDownloadProgress((p) => {
        setState({ status: "downloading", percent: Math.round(p.percent) });
      }),
      updater.onUpdateDownloaded((info) => {
        setState({ status: "ready", version: info.version });
        setDismissed(false);
      }),
      updater.onError((message) => {
        setState((prev) =>
          prev.status === "idle" ? prev : { status: "error", message },
        );
      }),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, []);

  if (dismissed || state.status === "idle") return null;

  const api = getAPI();
  const updater = api?.updater as
    | {
        download: () => Promise<unknown>;
        install: () => Promise<void>;
      }
    | undefined;

  return (
    <div className="px-3 py-2 border-b border-indigo-500/30 bg-indigo-950/60 text-[10px] font-pixel">
      {state.status === "available" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-indigo-300">v{state.version} available</span>
          <div className="flex gap-1">
            <button
              onClick={() => {
                setState({ status: "downloading", percent: 0 });
                updater?.download();
              }}
              className="px-2 py-0.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-[7px]"
            >
              Update
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="px-1.5 py-0.5 text-red-400 hover:text-red-200 text-[7px]"
            >
              X
            </button>
          </div>
        </div>
      )}

      {state.status === "downloading" && (
        <div className="flex items-center gap-2">
          <span className="text-indigo-300">Downloading...</span>
          <div className="flex-1 h-1 bg-slate-700 rounded overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all"
              style={{ width: `${state.percent}%` }}
            />
          </div>
          <span className="text-slate-400">{state.percent}%</span>
        </div>
      )}

      {state.status === "ready" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-green-300">
            v{state.version} ready to install
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => updater?.install()}
              className="px-2 py-0.5 bg-green-600 hover:bg-green-500 text-white rounded text-[9px]"
            >
              Restart Now
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="px-1.5 py-0.5 text-red-400 hover:text-red-200 text-[9px]"
            >
              X
            </button>
          </div>
        </div>
      )}

      {state.status === "error" && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-red-400 truncate">
            Update failed: {state.message}
          </span>
          <button
            onClick={() => setDismissed(true)}
            className="px-1.5 py-0.5 text-red-400 hover:text-red-200 text-[9px] shrink-0"
          >
            X
          </button>
        </div>
      )}
    </div>
  );
}
