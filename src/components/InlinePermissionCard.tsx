import { useEffect, useRef } from "react";
import { PermissionRequest } from "../lib/terminal";

interface InlinePermissionCardProps {
  request: PermissionRequest;
  onRespond: (allow: boolean) => void;
}

export default function InlinePermissionCard({
  request,
  onRespond,
}: InlinePermissionCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.focus();
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onRespond(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onRespond(false);
    }
  }

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="mx-2 my-1.5 bg-amber-950/40 border border-amber-600/50 rounded-lg shadow-lg shadow-amber-900/10 animate-slide-up outline-none"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-700/30 bg-amber-950/30 rounded-t-lg">
        <span className="text-amber-400 text-sm">🔒</span>
        <div className="flex-1 min-w-0">
          <span className="text-[11px] font-pixel text-amber-200">
            Permission Requested
          </span>
          {request.agentName && (
            <span className="text-[9px] text-amber-400/60 ml-1.5">
              by {request.agentName}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-2 space-y-1.5">
        <div>
          <span className="text-[10px] font-pixel text-slate-500 mr-1.5">Tool</span>
          <span className="text-[11px] font-mono text-amber-300 font-bold">
            {request.tool}
          </span>
        </div>
        <p className="text-[10px] text-amber-100/70 leading-relaxed">
          {request.description}
        </p>
        {request.input && Object.keys(request.input).length > 0 && (
          <pre className="text-[9px] text-amber-200/40 font-mono bg-black/20 rounded px-2 py-1.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all">
            {JSON.stringify(request.input, null, 2).slice(0, 800)}
          </pre>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-amber-700/20 bg-amber-950/20 rounded-b-lg">
        <span className="text-[8px] text-slate-600 font-mono">
          Enter = allow · Esc = deny
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={() => onRespond(false)}
            className="btn-pixel text-[9px] bg-red-700 hover:bg-red-600 text-white px-3 py-0.5 transition-colors cursor-pointer"
          >
            Deny
          </button>
          <button
            onClick={() => onRespond(true)}
            className="btn-pixel text-[9px] bg-emerald-700 hover:bg-emerald-600 text-white px-3 py-0.5 transition-colors cursor-pointer"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
