import { useEffect, useState } from "react";
import MarkdownMessage from "../MarkdownMessage";

interface ElectronMusicAPI {
  music: { getReadme: () => Promise<string>; openFolder: () => Promise<void> };
  isElectron: boolean;
}

function getReadmeAPI(): (() => Promise<string>) | null {
  const w = window as unknown as { electronAPI?: ElectronMusicAPI };
  return w.electronAPI?.isElectron ? w.electronAPI.music.getReadme : null;
}

function getOpenFolderAPI(): (() => Promise<void>) | null {
  const w = window as unknown as { electronAPI?: ElectronMusicAPI };
  return w.electronAPI?.isElectron ? w.electronAPI.music.openFolder : null;
}

/** Strip everything from the `<details>` block onward (developer notes). */
function stripDevNotes(md: string): string {
  const idx = md.indexOf("<details>");
  return idx >= 0 ? md.slice(0, idx).trimEnd() : md;
}

export default function MusicInfoModal({
  onClose,
  userCount,
}: {
  onClose: () => void;
  userCount: number;
}) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    const api = getReadmeAPI();
    if (api) {
      api().then((md) => setContent(stripDevNotes(md)));
    }
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-600 rounded-lg w-[420px] max-h-[80vh] shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h2 className="text-sm font-pixel text-white uppercase tracking-wide">
            Music Player
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors cursor-pointer text-xs font-pixel uppercase"
          >
            Close
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-3 overflow-y-auto text-[12px] text-slate-300 font-pixel leading-relaxed">
          {content === null ? (
            <span className="text-slate-500">Loading...</span>
          ) : (
            <MarkdownMessage content={content} />
          )}

          {userCount > 0 && (
            <div className="bg-indigo-900/30 border border-indigo-700/40 rounded px-3 py-2 mt-3 text-[11px] text-indigo-300">
              You currently have {userCount} custom track
              {userCount === 1 ? "" : "s"} loaded.
            </div>
          )}
        </div>

        {/* Footer */}
        {getOpenFolderAPI() && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-700">
            <button
              onClick={() => getOpenFolderAPI()?.()}
              className="btn-pixel text-[9px] py-1.5 px-3 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded cursor-pointer font-pixel"
            >
              Open Folder
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
