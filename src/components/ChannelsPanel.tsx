// ─── Channels Panel ─────────────────────────────────────────────
// UI for managing messaging channels.
// Dynamically discovers available channel types from the backend and
// builds add-channel forms from their metadata.

import { useEffect, useState, useCallback, useRef } from "react";
import { ChannelConfig, ChannelMessage } from "../lib/types";

interface ChannelLiveStatus {
  id: string;
  type: string;
  name: string;
  config: Record<string, unknown>;
  status: "connected" | "disconnected" | "error";
  errorMessage: string | null;
}

interface ChannelFieldMeta {
  key: string;
  label: string;
  type: string; // "text" | "password"
  placeholder?: string;
  hint?: string;
  required?: boolean;
  isList?: boolean;
}

interface ChannelTypeMeta {
  type: string;
  label: string;
  color: string; // tailwind color name, e.g. "blue", "purple"
  description: string;
  fields: ChannelFieldMeta[];
}

function getAPI() {
  const w = window as unknown as { electronAPI?: Record<string, unknown> };
  return w.electronAPI ?? null;
}

function openFullDiskAccessSettings() {
  const api = getAPI();
  const exec = api?.exec as
    | ((cmd: string, cwd?: string, timeout?: number) => Promise<unknown>)
    | undefined;
  if (exec) {
    exec(
      'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"',
    );
  }
}

function getDb() {
  const api = getAPI();
  return (api?.db ?? null) as {
    channelConfigSave: (config: Record<string, unknown>) => Promise<unknown>;
    channelConfigList: () => Promise<ChannelConfig[]>;
    channelConfigDelete: (id: string) => Promise<unknown>;
    channelMessageList: (
      channelId: string,
      limit: number,
    ) => Promise<ChannelMessage[]>;
    channelTypes: () => Promise<ChannelTypeMeta[]>;
    channelRegister: (
      config: Record<string, unknown>,
    ) => Promise<{ ok: boolean }>;
    channelRemove: (id: string) => Promise<{ ok: boolean; error?: string }>;
    channelConnect: (id: string) => Promise<{ ok: boolean; error?: string }>;
    channelDisconnect: (id: string) => Promise<{ ok: boolean; error?: string }>;
    channelSend: (
      channelId: string,
      conversationId: string,
      content: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    channelUpdate: (data: {
      id: string;
      name: string;
      config: Record<string, unknown>;
    }) => Promise<{ ok: boolean; error?: string }>;
    channelListLive: () => Promise<ChannelLiveStatus[]>;
    channelLoadAll: () => Promise<{ ok: boolean; count: number }>;
    onChannelInbound: (cb: (msg: ChannelMessage) => void) => () => void;
  } | null;
}

// Tailwind color maps for dynamic styling
const colorMap: Record<
  string,
  { bg: string; hover: string; text: string; typeBadge: string }
> = {
  blue: {
    bg: "bg-blue-800",
    hover: "hover:bg-blue-700",
    text: "text-blue-100",
    typeBadge: "text-blue-400",
  },
  purple: {
    bg: "bg-purple-800",
    hover: "hover:bg-purple-700",
    text: "text-purple-100",
    typeBadge: "text-purple-400",
  },
  green: {
    bg: "bg-green-800",
    hover: "hover:bg-green-700",
    text: "text-green-100",
    typeBadge: "text-green-400",
  },
  amber: {
    bg: "bg-amber-800",
    hover: "hover:bg-amber-700",
    text: "text-amber-100",
    typeBadge: "text-amber-400",
  },
  red: {
    bg: "bg-red-800",
    hover: "hover:bg-red-700",
    text: "text-red-100",
    typeBadge: "text-red-400",
  },
  slate: {
    bg: "bg-slate-800",
    hover: "hover:bg-slate-700",
    text: "text-slate-100",
    typeBadge: "text-slate-400",
  },
  cyan: {
    bg: "bg-cyan-800",
    hover: "hover:bg-cyan-700",
    text: "text-cyan-100",
    typeBadge: "text-cyan-400",
  },
  pink: {
    bg: "bg-pink-800",
    hover: "hover:bg-pink-700",
    text: "text-pink-100",
    typeBadge: "text-pink-400",
  },
};
const defaultColors = colorMap.slate;
function getColors(color: string) {
  return colorMap[color] || defaultColors;
}

type View = "list" | "add" | "edit" | "messages";

export default function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelLiveStatus[]>([]);
  const [channelTypes, setChannelTypes] = useState<ChannelTypeMeta[]>([]);
  const [view, setView] = useState<View>("list");
  const [addingType, setAddingType] = useState<ChannelTypeMeta | null>(null);
  const [selectedChannel, setSelectedChannel] =
    useState<ChannelLiveStatus | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    const db = getDb();
    if (!db) return;
    try {
      await db.channelLoadAll();
      const live = await db.channelListLive();
      setChannels(live || []);
    } catch {
      const api = getAPI();
      const dbInner = api?.db as {
        channelConfigList: () => Promise<ChannelConfig[]>;
      };
      if (dbInner) {
        const configs = await dbInner.channelConfigList();
        setChannels(
          configs.map((c) => ({
            id: c.id,
            type: c.type,
            name: c.name,
            config: (c as unknown as { config?: Record<string, unknown> }).config || {},
            status: c.status || "disconnected",
            errorMessage: null,
          })),
        );
      }
    }
  }, []);

  // Load available channel types on mount
  useEffect(() => {
    const db = getDb();
    if (!db) return;
    db.channelTypes()
      .then((types) => setChannelTypes(types || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // Listen for inbound messages to refresh when viewing
  useEffect(() => {
    const db = getDb();
    if (!db) return;
    const unsub = db.onChannelInbound(() => {
      if (selectedChannel) {
        db.channelMessageList(selectedChannel.id, 100).then(setMessages);
      }
    });
    return unsub;
  }, [selectedChannel]);

  const handleConnect = useCallback(
    async (id: string) => {
      const db = getDb();
      if (!db) return;
      setLoading(true);
      setError(null);
      try {
        const result = await db.channelConnect(id);
        if (!result.ok) setError(result.error || "Failed to connect");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to connect");
      }
      await loadChannels();
      setLoading(false);
    },
    [loadChannels],
  );

  const handleDisconnect = useCallback(
    async (id: string) => {
      const db = getDb();
      if (!db) return;
      setLoading(true);
      try {
        await db.channelDisconnect(id);
      } catch {
        /* ignore */
      }
      await loadChannels();
      setLoading(false);
    },
    [loadChannels],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      const db = getDb();
      if (!db) return;
      await db.channelRemove(id);
      await loadChannels();
      if (selectedChannel?.id === id) {
        setSelectedChannel(null);
        setView("list");
      }
    },
    [loadChannels, selectedChannel],
  );

  const handleViewMessages = useCallback(async (ch: ChannelLiveStatus) => {
    const db = getDb();
    if (!db) return;
    setSelectedChannel(ch);
    const msgs = await db.channelMessageList(ch.id, 100);
    setMessages(msgs || []);
    setView("messages");
  }, []);

  const handleStartAdd = useCallback((typeMeta: ChannelTypeMeta) => {
    setAddingType(typeMeta);
    setView("add");
    setError(null);
  }, []);

  const handleStartEdit = useCallback(
    (ch: ChannelLiveStatus) => {
      setSelectedChannel(ch);
      setAddingType(channelTypes.find((t) => t.type === ch.type) || null);
      setView("edit");
      setError(null);
    },
    [channelTypes],
  );

  return (
    <div className="p-4 text-slate-200 flex flex-col gap-4 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        {view !== "list" && (
          <button
            onClick={() => {
              setView("list");
              setAddingType(null);
              setError(null);
            }}
            className="text-slate-400 hover:text-white text-xs mr-2"
          >
            &larr; Back
          </button>
        )}
        <h3 className="text-sm font-pixel text-white flex-1">
          {view === "list" && "Channels"}
          {view === "add" && `Add ${addingType?.label || "Channel"}`}
          {view === "edit" && `Edit ${selectedChannel?.name || "Channel"}`}
          {view === "messages" && (selectedChannel?.name || "Messages")}
        </h3>
      </div>

      {error && (
        <div className="bg-red-900/60 border border-red-700/50 rounded px-3 py-2 text-xs text-red-200">
          <p>{error}</p>
          {(error.includes("Full Disk Access") ||
            error.includes("authorization denied")) && (
            <button
              onClick={() => openFullDiskAccessSettings()}
              className="btn-pixel text-[10px] bg-amber-700 hover:bg-amber-600 text-white mt-2 px-2 py-1"
            >
              Open System Settings
            </button>
          )}
        </div>
      )}

      {/* ── Channel List ──────────────────────────────────────────── */}
      {view === "list" && (
        <>
          {channels.length === 0 ? (
            <div className="text-center text-slate-500 text-xs py-8">
              No channels configured yet.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {channels.map((ch) => {
                const typeMeta = channelTypes.find((t) => t.type === ch.type);
                return (
                  <ChannelCard
                    key={ch.id}
                    channel={ch}
                    typeMeta={typeMeta}
                    loading={loading}
                    onConnect={() => handleConnect(ch.id)}
                    onDisconnect={() => handleDisconnect(ch.id)}
                    onDelete={() => handleDelete(ch.id)}
                    onEdit={() => handleStartEdit(ch)}
                    onViewMessages={() => handleViewMessages(ch)}
                  />
                );
              })}
            </div>
          )}

          {channelTypes.length > 0 && (
            <div className="border-t border-slate-700 pt-3 mt-auto">
              <p className="text-[10px] text-slate-500 font-pixel mb-2">
                Add Channel
              </p>
              <div className="flex gap-2 flex-wrap">
                {channelTypes.map((typeMeta) => {
                  const c = getColors(typeMeta.color);
                  return (
                    <button
                      key={typeMeta.type}
                      onClick={() => handleStartAdd(typeMeta)}
                      className={`flex-1 min-w-[80px] btn-pixel text-[10px] ${c.bg} ${c.hover} ${c.text} py-1.5`}
                    >
                      {typeMeta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Add Channel (dynamic form) ────────────────────────────── */}
      {view === "add" && addingType && (
        <AddChannelForm
          typeMeta={addingType}
          onAdded={() => {
            loadChannels();
            setView("list");
            setAddingType(null);
          }}
          onError={setError}
        />
      )}

      {/* ── Edit Channel ──────────────────────────────────────────── */}
      {view === "edit" && selectedChannel && addingType && (
        <EditChannelForm
          channel={selectedChannel}
          typeMeta={addingType}
          onSaved={() => {
            loadChannels();
            setView("list");
            setSelectedChannel(null);
            setAddingType(null);
          }}
          onError={setError}
        />
      )}

      {/* ── Message History ───────────────────────────────────────── */}
      {view === "messages" && selectedChannel && (
        <MessageHistory channel={selectedChannel} messages={messages} />
      )}
    </div>
  );
}

// ─── Channel Card ─────────────────────────────────────────────────

function ChannelCard({
  channel,
  typeMeta,
  loading,
  onConnect,
  onDisconnect,
  onDelete,
  onEdit,
  onViewMessages,
}: {
  channel: ChannelLiveStatus;
  typeMeta?: ChannelTypeMeta;
  loading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onViewMessages: () => void;
}) {
  const typeLabel = typeMeta?.label || channel.type;
  const c = getColors(typeMeta?.color || "slate");

  const statusDot =
    channel.status === "connected"
      ? "bg-green-400"
      : channel.status === "error"
        ? "bg-red-400"
        : "bg-slate-500";

  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2.5">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-2 h-2 rounded-full ${statusDot}`} />
        <span className="text-xs text-white font-medium flex-1 truncate">
          {channel.name}
        </span>
        <span className={`text-[10px] ${c.typeBadge}`}>{typeLabel}</span>
      </div>

      {channel.errorMessage && (
        <p className="text-[10px] text-red-400 mb-1.5 truncate">
          {channel.errorMessage}
        </p>
      )}

      <div className="flex gap-1.5">
        {channel.status !== "connected" ? (
          <button
            onClick={onConnect}
            disabled={loading}
            className="btn-pixel text-[10px] bg-green-800 hover:bg-green-700 text-green-100 px-2 py-0.5 disabled:opacity-50"
          >
            Connect
          </button>
        ) : (
          <button
            onClick={onDisconnect}
            disabled={loading}
            className="btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-0.5 disabled:opacity-50"
          >
            Disconnect
          </button>
        )}
        <button
          onClick={onEdit}
          className="btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-0.5"
        >
          Edit
        </button>
        <button
          onClick={onViewMessages}
          className="btn-pixel text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-200 px-2 py-0.5"
        >
          Messages
        </button>
        <button
          onClick={onDelete}
          className="btn-pixel text-[10px] bg-red-900/60 hover:bg-red-800 text-red-300 px-2 py-0.5 ml-auto"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ─── Dynamic Add Channel Form ─────────────────────────────────────

function AddChannelForm({
  typeMeta,
  onAdded,
  onError,
}: {
  typeMeta: ChannelTypeMeta;
  onAdded: () => void;
  onError: (err: string) => void;
}) {
  const [name, setName] = useState(typeMeta.label);
  const [systemInstructions, setSystemInstructions] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of typeMeta.fields) {
      init[f.key] = "";
    }
    return init;
  });
  const [saving, setSaving] = useState(false);

  const c = getColors(typeMeta.color);

  const setField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const requiredFieldsFilled = typeMeta.fields
    .filter((f) => f.required)
    .every((f) => fieldValues[f.key]?.trim());

  const handleSubmit = async () => {
    if (!name.trim()) return;
    const db = getDb();
    if (!db) {
      onError("Not running in Electron");
      return;
    }

    setSaving(true);
    try {
      const id = `${typeMeta.type}-${Date.now()}`;
      const config: Record<string, unknown> = {};

      for (const field of typeMeta.fields) {
        const raw = fieldValues[field.key]?.trim();
        if (!raw) continue;

        if (field.isList) {
          config[field.key] = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          config[field.key] = raw;
        }
      }

      if (systemInstructions.trim()) {
        config.systemInstructions = systemInstructions.trim();
      }

      await db.channelRegister({
        id,
        type: typeMeta.type,
        name: name.trim(),
        config,
      });
      onAdded();
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : "Failed to add channel");
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-3">
      {typeMeta.description && (
        <p className="text-[10px] text-slate-400">{typeMeta.description}</p>
      )}

      <label className="text-[10px] text-slate-400 font-pixel">
        Channel Name
        <input
          className="input-mono w-full mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={typeMeta.label}
        />
      </label>

      {typeMeta.fields.map((field) => (
        <label
          key={field.key}
          className="text-[10px] text-slate-400 font-pixel"
        >
          {field.label}
          {field.required && <span className="text-red-400 ml-0.5">*</span>}
          <input
            className="input-mono w-full mt-1"
            type={field.type === "password" ? "password" : "text"}
            value={fieldValues[field.key] || ""}
            onChange={(e) => setField(field.key, e.target.value)}
            placeholder={field.placeholder}
          />
          {field.hint && (
            <span className="text-[9px] text-slate-500 mt-0.5 block">
              {field.hint}
            </span>
          )}
        </label>
      ))}

      <label className="text-[10px] text-slate-400 font-pixel">
        System Instructions
        <textarea
          className="input-mono w-full mt-1 min-h-[60px] resize-y"
          value={systemInstructions}
          onChange={(e) => setSystemInstructions(e.target.value)}
          placeholder="e.g. You are a secretary. Only reply with text. always be concise."
          rows={3}
        />
        <span className="text-[9px] text-slate-500 mt-0.5 block">
          Custom instructions for the agent when handling messages on this
          channel
        </span>
      </label>

      <button
        onClick={handleSubmit}
        disabled={saving || !name.trim() || !requiredFieldsFilled}
        className={`btn-pixel text-[10px] ${c.bg} ${c.hover} text-white py-1.5 disabled:opacity-50`}
      >
        {saving ? "Adding..." : `Add ${typeMeta.label} Channel`}
      </button>
    </div>
  );
}

// ─── Edit Channel Form ────────────────────────────────────────────

function EditChannelForm({
  channel,
  typeMeta,
  onSaved,
  onError,
}: {
  channel: ChannelLiveStatus;
  typeMeta: ChannelTypeMeta;
  onSaved: () => void;
  onError: (err: string) => void;
}) {
  const cfg = channel.config || {};
  const [name, setName] = useState(channel.name);
  const [systemInstructions, setSystemInstructions] = useState(
    (cfg.systemInstructions as string) || "",
  );
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of typeMeta.fields) {
      const val = cfg[f.key];
      init[f.key] = Array.isArray(val) ? val.join(", ") : ((val as string) || "");
    }
    return init;
  });
  const [saving, setSaving] = useState(false);

  const c = getColors(typeMeta.color);

  const setField = (key: string, value: string) => {
    setFieldValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;
    const db = getDb();
    if (!db) {
      onError("Not running in Electron");
      return;
    }

    setSaving(true);
    try {
      const config: Record<string, unknown> = {};

      for (const field of typeMeta.fields) {
        const raw = fieldValues[field.key]?.trim();
        if (!raw) continue;

        if (field.isList) {
          config[field.key] = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        } else {
          config[field.key] = raw;
        }
      }

      if (systemInstructions.trim()) {
        config.systemInstructions = systemInstructions.trim();
      }

      const result = await db.channelUpdate({
        id: channel.id,
        name: name.trim(),
        config,
      });
      if (!result.ok) {
        onError(result.error || "Failed to update channel");
      } else {
        onSaved();
      }
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : "Failed to update channel");
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="text-[10px] text-slate-400 font-pixel">
        Channel Name
        <input
          className="input-mono w-full mt-1"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={typeMeta.label}
        />
      </label>

      {typeMeta.fields.map((field) => (
        <label
          key={field.key}
          className="text-[10px] text-slate-400 font-pixel"
        >
          {field.label}
          {field.required && <span className="text-red-400 ml-0.5">*</span>}
          <input
            className="input-mono w-full mt-1"
            type={field.type === "password" ? "password" : "text"}
            value={fieldValues[field.key] || ""}
            onChange={(e) => setField(field.key, e.target.value)}
            placeholder={field.placeholder}
          />
          {field.hint && (
            <span className="text-[9px] text-slate-500 mt-0.5 block">
              {field.hint}
            </span>
          )}
        </label>
      ))}

      <label className="text-[10px] text-slate-400 font-pixel">
        System Instructions
        <textarea
          className="input-mono w-full mt-1 min-h-[60px] resize-y"
          value={systemInstructions}
          onChange={(e) => setSystemInstructions(e.target.value)}
          placeholder="e.g. You are a secretary. Only reply with text, do not use tools."
          rows={3}
        />
        <span className="text-[9px] text-slate-500 mt-0.5 block">
          Custom instructions for the agent when handling messages on this
          channel
        </span>
      </label>

      <button
        onClick={handleSubmit}
        disabled={saving || !name.trim()}
        className={`btn-pixel text-[10px] ${c.bg} ${c.hover} text-white py-1.5 disabled:opacity-50`}
      >
        {saving ? "Saving..." : "Save Changes"}
      </button>
    </div>
  );
}

// ─── Message History ──────────────────────────────────────────────

function MessageHistory({
  channel,
  messages,
}: {
  channel: ChannelLiveStatus;
  messages: ChannelMessage[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="flex flex-col gap-1.5 flex-1 min-h-0">
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`w-2 h-2 rounded-full ${channel.status === "connected" ? "bg-green-400" : "bg-slate-500"}`}
        />
        <span className="text-[10px] text-slate-400">
          {channel.status} &middot; {messages.length} messages
        </span>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-1 min-h-0">
        {messages.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-8">
            No messages yet.
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={msg.id || i}
              className={`rounded px-2.5 py-1.5 text-xs max-w-[85%] ${
                msg.direction === "inbound"
                  ? "bg-slate-700/60 self-start text-slate-200"
                  : "bg-indigo-800/60 self-end text-indigo-100"
              }`}
            >
              {msg.sender && msg.direction === "inbound" && (
                <div className="text-[10px] text-slate-400 mb-0.5">
                  {msg.sender}
                </div>
              )}
              <div className="whitespace-pre-wrap break-words">
                {msg.content}
              </div>
              <div className="text-[9px] text-slate-500 mt-0.5 text-right">
                {new Date(msg.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
