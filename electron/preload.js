const { contextBridge, ipcRenderer } = require("electron");

// Extract homedir from additionalArguments (sandbox prevents os module access)
const homedirArg = process.argv.find((a) => a.startsWith("--homedir="));
const homedir = homedirArg ? homedirArg.slice("--homedir=".length) : "~";

// Expose a minimal API to the renderer process
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: process.platform,
  homedir,

  // Filesystem
  fs: {
    getWorkspace: () => ipcRenderer.invoke("fs:getWorkspace"),
    setWorkspace: (dir) => ipcRenderer.invoke("fs:setWorkspace", dir),
    pickWorkspace: () => ipcRenderer.invoke("fs:pickWorkspace"),
    writeFile: (path, content) =>
      ipcRenderer.invoke("fs:writeFile", path, content),
    readFile: (path) => ipcRenderer.invoke("fs:readFile", path),
    deleteFile: (path) => ipcRenderer.invoke("fs:deleteFile", path),
    listFiles: (dir) => ipcRenderer.invoke("fs:listFiles", dir),
    listAllFiles: () => ipcRenderer.invoke("fs:listAllFiles"),
    getAllFiles: () => ipcRenderer.invoke("fs:getAllFiles"),
    searchFiles: (keywords, maxResults) =>
      ipcRenderer.invoke("fs:searchFiles", keywords, maxResults),
  },

  // Interactive shell sessions
  shell: {
    spawn: (cwd) => ipcRenderer.invoke("shell:spawn", cwd),
    write: (id, data) => ipcRenderer.invoke("shell:write", id, data),
    kill: (id) => ipcRenderer.invoke("shell:kill", id),
    onStdout: (cb) => {
      const listener = (_event, id, data) => cb(id, data);
      ipcRenderer.on("shell:stdout", listener);
      return () => ipcRenderer.removeListener("shell:stdout", listener);
    },
    onStderr: (cb) => {
      const listener = (_event, id, data) => cb(id, data);
      ipcRenderer.on("shell:stderr", listener);
      return () => ipcRenderer.removeListener("shell:stderr", listener);
    },
    onExit: (cb) => {
      const listener = (_event, id, code) => cb(id, code);
      ipcRenderer.on("shell:exit", listener);
      return () => ipcRenderer.removeListener("shell:exit", listener);
    },
  },

  // One-shot command execution (for agent tools)
  exec: (command, cwd, timeoutMs) =>
    ipcRenderer.invoke("shell:exec", command, cwd, timeoutMs),

  // Set GitHub token so git/gh commands have GH_TOKEN in their environment
  setGithubToken: (token) => ipcRenderer.invoke("shell:setGithubToken", token),

  // Preview window
  preview: {
    open: (url) => ipcRenderer.invoke("preview:open", url),
    close: () => ipcRenderer.invoke("preview:close"),
    onOpened: (listener) => {
      ipcRenderer.on("preview:opened", listener);
      return () => ipcRenderer.removeListener("preview:opened", listener);
    },
  },

  // Claude Code integration (streaming)
  claudeCode: {
    start: (prompt, systemPrompt, cwd, timeoutMs) =>
      ipcRenderer.invoke(
        "claude-code:start",
        prompt,
        systemPrompt,
        cwd,
        timeoutMs,
      ),
    startAdvanced: (options) =>
      ipcRenderer.invoke("claude-code:startAdvanced", options),
    abort: (reqId) => ipcRenderer.invoke("claude-code:abort", reqId),
    sendInput: (reqId, text) =>
      ipcRenderer.invoke("claude-code:sendInput", reqId, text),
    resolvePermission: (permId, allow) =>
      ipcRenderer.invoke("claude-code:resolvePermission", permId, allow),
    onPermissionRequest: (cb) => {
      const listener = (_event, reqId, request) => cb(reqId, request);
      ipcRenderer.on("claude-code:permission-request", listener);
      return () =>
        ipcRenderer.removeListener("claude-code:permission-request", listener);
    },
    onChunk: (cb) => {
      const listener = (_event, reqId, data) => cb(reqId, data);
      ipcRenderer.on("claude-code:chunk", listener);
      return () => ipcRenderer.removeListener("claude-code:chunk", listener);
    },
    onEvent: (cb) => {
      const listener = (_event, reqId, data) => cb(reqId, data);
      ipcRenderer.on("claude-code:event", listener);
      return () => ipcRenderer.removeListener("claude-code:event", listener);
    },
    onStderr: (cb) => {
      const listener = (_event, reqId, data) => cb(reqId, data);
      ipcRenderer.on("claude-code:stderr", listener);
      return () => ipcRenderer.removeListener("claude-code:stderr", listener);
    },
    onDone: (cb) => {
      const listener = (_event, reqId, code, error) => cb(reqId, code, error);
      ipcRenderer.on("claude-code:done", listener);
      return () => ipcRenderer.removeListener("claude-code:done", listener);
    },
    onHeartbeat: (cb) => {
      const listener = (_event, reqId) => cb(reqId);
      ipcRenderer.on("claude-code:heartbeat", listener);
      return () =>
        ipcRenderer.removeListener("claude-code:heartbeat", listener);
    },
    version: () => ipcRenderer.invoke("claude-code:version"),
    authStatus: () => ipcRenderer.invoke("claude-code:authStatus"),
    listAgents: (cwd) => ipcRenderer.invoke("claude-code:listAgents", cwd),
    readAgentFiles: (cwd) =>
      ipcRenderer.invoke("claude-code:readAgentFiles", cwd),
    writeAgentFile: (filePath, content) =>
      ipcRenderer.invoke("claude-code:writeAgentFile", filePath, content),
    deleteAgentFile: (filePath) =>
      ipcRenderer.invoke("claude-code:deleteAgentFile", filePath),
    onAgentsChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("claude-code:agents-changed", listener);
      return () =>
        ipcRenderer.removeListener("claude-code:agents-changed", listener);
    },
    watchProjectAgents: (projectDir) =>
      ipcRenderer.send("claude-code:watchProjectAgents", projectDir),
  },

  // Database / persistence
  db: {
    // App settings
    settingGet: (key) => ipcRenderer.invoke("db:setting:get", key),
    settingSet: (key, value) =>
      ipcRenderer.invoke("db:setting:set", key, value),
    settingDelete: (key) => ipcRenderer.invoke("db:setting:delete", key),
    settingList: () => ipcRenderer.invoke("db:setting:list"),

    // Memory
    memorySet: (scope, key, value) =>
      ipcRenderer.invoke("db:memory:set", scope, key, value),
    memoryGet: (scope, key) => ipcRenderer.invoke("db:memory:get", scope, key),
    memorySearch: (scope, query) =>
      ipcRenderer.invoke("db:memory:search", scope, query),
    memoryList: (scope) => ipcRenderer.invoke("db:memory:list", scope),
    memoryDelete: (scope, key) =>
      ipcRenderer.invoke("db:memory:delete", scope, key),

    // Cost records
    costAddRecord: (record) => ipcRenderer.invoke("db:cost:addRecord", record),
    costGetAll: () => ipcRenderer.invoke("db:cost:getAll"),
    costGetByAgent: (agentId) =>
      ipcRenderer.invoke("db:cost:getByAgent", agentId),
    costGetSince: (sinceMs) => ipcRenderer.invoke("db:cost:getSince", sinceMs),
    costClear: () => ipcRenderer.invoke("db:cost:clear"),
    costGetCumulative: (sessionKey) =>
      ipcRenderer.invoke("db:cost:getCumulative", sessionKey),
    costSetCumulative: (sessionKey, cost, inputTokens, outputTokens) =>
      ipcRenderer.invoke(
        "db:cost:setCumulative",
        sessionKey,
        cost,
        inputTokens,
        outputTokens,
      ),
    costDeleteCumulative: (sessionKey) =>
      ipcRenderer.invoke("db:cost:deleteCumulative", sessionKey),
    costGetBudgets: () => ipcRenderer.invoke("db:cost:getBudgets"),
    costSetBudget: (agentId, dailyLimitUsd, totalLimitUsd) =>
      ipcRenderer.invoke(
        "db:cost:setBudget",
        agentId,
        dailyLimitUsd,
        totalLimitUsd,
      ),
    costRecordDelta: (
      sessionKey,
      record,
      cumulativeCost,
      cumulativeInputTokens,
      cumulativeOutputTokens,
    ) =>
      ipcRenderer.invoke(
        "db:cost:recordDelta",
        sessionKey,
        record,
        cumulativeCost,
        cumulativeInputTokens,
        cumulativeOutputTokens,
      ),

    // Triggers
    triggerCreate: (trigger) =>
      ipcRenderer.invoke("db:trigger:create", trigger),
    triggerList: () => ipcRenderer.invoke("db:trigger:list"),
    triggerUpdate: (id, updates) =>
      ipcRenderer.invoke("db:trigger:update", id, updates),
    triggerDelete: (id) => ipcRenderer.invoke("db:trigger:delete", id),

    // Channel configs
    channelConfigSave: (config) =>
      ipcRenderer.invoke("db:channel:configSave", config),
    channelConfigList: () => ipcRenderer.invoke("db:channel:configList"),
    channelConfigDelete: (id) =>
      ipcRenderer.invoke("db:channel:configDelete", id),

    // Channel messages
    channelMessageSave: (msg) =>
      ipcRenderer.invoke("db:channel:messageSave", msg),
    channelMessageList: (channelId, limit) =>
      ipcRenderer.invoke("db:channel:messageList", channelId, limit),

    // Skill auth (DB layer)
    skillAuthGet: (runtime) => ipcRenderer.invoke("db:skill:authGet", runtime),
    skillAuthSave: (runtime, credentials, config, status) =>
      ipcRenderer.invoke(
        "db:skill:authSave",
        runtime,
        credentials,
        config,
        status,
      ),
    skillAuthDelete: (runtime) =>
      ipcRenderer.invoke("db:skill:authDelete", runtime),

    // Custom skills
    customSkillCreate: (skill) =>
      ipcRenderer.invoke("db:customSkill:create", skill),
    customSkillList: () => ipcRenderer.invoke("db:customSkill:list"),
    customSkillGet: (id) => ipcRenderer.invoke("db:customSkill:get", id),
    customSkillUpdate: (id, updates) =>
      ipcRenderer.invoke("db:customSkill:update", id, updates),
    customSkillDelete: (id) => ipcRenderer.invoke("db:customSkill:delete", id),

    // Skill runtime auth (triggers OAuth flow in main process)
    skillRuntimeAuth: (runtime) =>
      ipcRenderer.invoke("skill-runtime:authenticate", runtime),
    skillRuntimeDisconnect: (runtime) =>
      ipcRenderer.invoke("skill-runtime:disconnect", runtime),
    skillRuntimeStatus: (runtime) =>
      ipcRenderer.invoke("skill-runtime:status", runtime),

    // Channel manager (lifecycle + messaging)
    channelTypes: () => ipcRenderer.invoke("channel:types"),
    channelRegister: (config) => ipcRenderer.invoke("channel:register", config),
    channelRemove: (id) => ipcRenderer.invoke("channel:remove", id),
    channelUpdate: (data) => ipcRenderer.invoke("channel:update", data),
    channelConnect: (id) => ipcRenderer.invoke("channel:connect", id),
    channelDisconnect: (id) => ipcRenderer.invoke("channel:disconnect", id),
    channelSend: (channelId, conversationId, content) =>
      ipcRenderer.invoke("channel:send", channelId, conversationId, content),
    channelListLive: () => ipcRenderer.invoke("channel:list"),
    channelLoadAll: () => ipcRenderer.invoke("channel:loadAll"),

    // Channel events
    onChannelInbound: (cb) => {
      const listener = (_event, msg) => cb(msg);
      ipcRenderer.on("channel:inbound", listener);
      return () => ipcRenderer.removeListener("channel:inbound", listener);
    },

    // Trigger events
    onTriggerFire: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("trigger:fire", listener);
      return () => ipcRenderer.removeListener("trigger:fire", listener);
    },

    // Trigger test
    triggerTest: (triggerId) => ipcRenderer.invoke("trigger:test", triggerId),
  },

  // Session persistence
  sessions: {
    save: (session) => ipcRenderer.invoke("session:save", session),
    load: (agentId, sessionId) =>
      ipcRenderer.invoke("session:load", agentId, sessionId),
    list: (agentId) => ipcRenderer.invoke("session:list", agentId),
    delete: (agentId, sessionId) =>
      ipcRenderer.invoke("session:delete", agentId, sessionId),
    search: (agentId, query) =>
      ipcRenderer.invoke("session:search", agentId, query),
  },

  // Music
  music: {
    listTracks: () => ipcRenderer.invoke("music:listTracks"),
  },

  // Permissions
  permissions: {
    check: (dirPath) => ipcRenderer.invoke("permissions:check", dirPath),
    repair: (dirPath) => ipcRenderer.invoke("permissions:repair", dirPath),
    ensureDir: (dirPath) =>
      ipcRenderer.invoke("permissions:ensureDir", dirPath),
  },

  // Claude Code settings & permissions config
  claudeSettings: {
    read: (scope) => ipcRenderer.invoke("claude-settings:read", scope),
    write: (scope, settings) =>
      ipcRenderer.invoke("claude-settings:write", scope, settings),
    readClaudeMd: () => ipcRenderer.invoke("claude-settings:readClaudeMd"),
    writeClaudeMd: (content) =>
      ipcRenderer.invoke("claude-settings:writeClaudeMd", content),
  },

  // File watching
  watcher: {
    watchWorkspace: (dir) => ipcRenderer.send("fs:watchWorkspace", dir),
    unwatchWorkspace: () => ipcRenderer.send("fs:unwatchWorkspace"),
    onFileChanged: (cb) => {
      const listener = (_event, data) => cb(data);
      ipcRenderer.on("fs:fileChanged", listener);
      return () => ipcRenderer.removeListener("fs:fileChanged", listener);
    },
    onFileTreeChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("fs:fileTreeChanged", listener);
      return () => ipcRenderer.removeListener("fs:fileTreeChanged", listener);
    },
  },

  // Git operations
  git: {
    isRepo: (cwd) => ipcRenderer.invoke("git:isRepo", cwd),
    status: (cwd) => ipcRenderer.invoke("git:status", cwd),
    statusDetailed: (cwd) => ipcRenderer.invoke("git:statusDetailed", cwd),
    diff: (cwd, ref, filepath) =>
      ipcRenderer.invoke("git:diff", cwd, ref, filepath),
    diffStaged: (cwd, filepath) =>
      ipcRenderer.invoke("git:diffStaged", cwd, filepath),
    diffStat: (cwd) => ipcRenderer.invoke("git:diffStat", cwd),
    log: (cwd) => ipcRenderer.invoke("git:log", cwd),
    stashRef: (cwd) => ipcRenderer.invoke("git:stashRef", cwd),
    branchInfo: (cwd) => ipcRenderer.invoke("git:branchInfo", cwd),
    stage: (cwd, files) => ipcRenderer.invoke("git:stage", cwd, files),
    unstage: (cwd, files) => ipcRenderer.invoke("git:unstage", cwd, files),
    commit: (cwd, message) => ipcRenderer.invoke("git:commit", cwd, message),
    createBranch: (cwd, name) =>
      ipcRenderer.invoke("git:createBranch", cwd, name),
    checkoutBranch: (cwd, name) =>
      ipcRenderer.invoke("git:checkoutBranch", cwd, name),
    push: (cwd, setUpstream) =>
      ipcRenderer.invoke("git:push", cwd, setUpstream),
    createPr: (cwd, title, body, baseBranch) =>
      ipcRenderer.invoke("git:createPr", cwd, title, body, baseBranch),
  },

  // Notifications
  notifications: {
    show: (title, body, options) =>
      ipcRenderer.invoke("notification:show", title, body, options),
  },

  // Auto-updater
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    download: () => ipcRenderer.invoke("updater:download"),
    install: () => ipcRenderer.invoke("updater:install"),
    getVersion: () => ipcRenderer.invoke("updater:getVersion"),
    onUpdateAvailable: (cb) => {
      const listener = (_event, info) => cb(info);
      ipcRenderer.on("updater:update-available", listener);
      return () =>
        ipcRenderer.removeListener("updater:update-available", listener);
    },
    onUpdateNotAvailable: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("updater:update-not-available", listener);
      return () =>
        ipcRenderer.removeListener("updater:update-not-available", listener);
    },
    onDownloadProgress: (cb) => {
      const listener = (_event, progress) => cb(progress);
      ipcRenderer.on("updater:download-progress", listener);
      return () =>
        ipcRenderer.removeListener("updater:download-progress", listener);
    },
    onUpdateDownloaded: (cb) => {
      const listener = (_event, info) => cb(info);
      ipcRenderer.on("updater:update-downloaded", listener);
      return () =>
        ipcRenderer.removeListener("updater:update-downloaded", listener);
    },
    onError: (cb) => {
      const listener = (_event, message) => cb(message);
      ipcRenderer.on("updater:error", listener);
      return () => ipcRenderer.removeListener("updater:error", listener);
    },
  },
});
