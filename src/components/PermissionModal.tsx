import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { PermissionRequest } from "../lib/terminal";

interface PermissionModalProps {
  request: PermissionRequest;
  onRespond: (allow: boolean) => void;
}

export default function PermissionModal({
  request,
  onRespond,
}: PermissionModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Focus the modal on mount so keyboard shortcuts work
  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  // Keyboard shortcuts: Enter=Allow, Escape=Deny
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onRespond(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onRespond(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="bg-slate-900 border border-amber-600/60 rounded-lg w-[420px] max-w-[90vw] shadow-2xl shadow-amber-900/20 animate-slide-up outline-none"
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-amber-700/40 bg-amber-950/30 rounded-t-lg">
          <span className="text-amber-400 text-base">🔒</span>
          <div className="flex-1">
            <h2 className="text-[12px] font-pixel text-amber-200">
              Permission Requested
            </h2>
            {request.agentName && (
              <p className="text-[10px] text-amber-400/60 mt-0.5">
                by {request.agentName}
              </p>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-3">
          {/* Tool name */}
          <div>
            <p className="text-[10px] font-pixel text-slate-500 mb-0.5">Tool</p>
            <p className="text-[12px] font-mono text-amber-300 font-bold">
              {request.tool}
            </p>
            <p className="text-[10px] text-amber-100/80 leading-relaxed">
              {request.description}
            </p>
          </div>

          {/* Input parameters */}
          {request.input && Object.keys(request.input).length > 0 && (
            <div>
              <p className="text-[10px] font-pixel text-slate-500 mb-0.5">
                Input
              </p>
              <pre className="text-[9px] text-amber-200/50 font-mono bg-black/30 rounded px-2.5 py-2 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                {JSON.stringify(request.input, null, 2).slice(0, 800)}
              </pre>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-slate-700/50 bg-slate-950/50 rounded-b-lg">
          <p className="text-[9px] text-slate-600 font-mono">
            Enter to allow · Esc to deny
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => onRespond(false)}
              className="btn-pixel text-[10px] bg-red-700 hover:bg-red-600 text-white px-4 py-1 transition-colors"
            >
              ✕ Deny
            </button>
            <button
              onClick={() => onRespond(true)}
              className="btn-pixel text-[10px] bg-emerald-700 hover:bg-emerald-600 text-white px-4 py-1 transition-colors"
            >
              ✓ Allow
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
