# Outworked Web Version — Implementation Plan

## Current State Analysis

**Outworked** is a macOS Electron desktop app that orchestrates multiple AI agents in a pixel-art virtual office. Agents have roles, personalities, and skills — they collaborate on tasks, browse the web, send messages, write code, and run on schedules.

### Current Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop | Electron 41.1 |
| Frontend | React 19 + TypeScript + Tailwind CSS 4 |
| Build | Vite 8 |
| Graphics | Phaser 3 (isometric pixel office) |
| Database | SQLite (better-sqlite3, WAL mode) |
| AI | @anthropic-ai/claude-agent-sdk |
| IPC | Electron IPC + Context Bridge |

### Current Features

- **Multi-agent orchestration** — Auto-route tasks to specialist agents based on role/skills
- **Pixel office** — Phaser 3 isometric scene with animated agents, furniture, thought bubbles
- **Chat & streaming** — Real-time tool calls, extended thinking, markdown rendering
- **Skills system** — Modular `.md` files (Browser, Scheduler, Gmail, Slack, Notion, Google Sheets/Drive/Calendar)
- **Triggers** — Pattern matching on channel messages, webhooks, cron schedules
- **Channels** — iMessage (AppleScript), Slack API integration
- **Browser automation** — Hidden Electron BrowserWindow pool with click/fill/screenshot
- **MCP server** — HTTP server exposing memory, channels, triggers, tunnel tools
- **Asset packs** — Custom sprites, furniture, backgrounds, fonts
- **Git panel** — Branch/status/diff/PR preview built into the UI
- **Cost tracking** — Per-agent token spend dashboard

### Current Architecture (Key Files)

```
src/                          # React frontend (~50 files)
├── App.tsx                   # Main app (56KB)
├── components/               # 27 React components
│   ├── ChatWindow.tsx        # Agent chat + orchestration (2938 LOC)
│   ├── OfficeCanvas.tsx      # Phaser scene loader
│   ├── GitPanel.tsx          # Git integration (886 LOC)
│   ├── TerminalPanel.tsx     # Live terminal output
│   └── ...
├── lib/                      # Core logic (16 modules)
│   ├── ai.ts                 # Message sending, system prompts
│   ├── orchestrator.ts       # Multi-agent task routing
│   ├── terminal.ts           # Claude Code SDK integration
│   ├── tools.ts              # Agent tool definitions
│   ├── storage.ts            # Agent persistence (markdown + SQLite)
│   ├── sessions.ts           # Chat session management
│   └── ...
├── phaser/                   # Phaser game logic
│   ├── OfficeScene.ts        # Office scene, sprites, furniture
│   ├── SpriteGen.ts          # Procedural character generation
│   └── FurnitureGen.ts       # Furniture assets
│
electron/                     # Electron main process (~28 files)
├── main.js                   # App lifecycle, IPC handlers (94KB)
├── sdk-bridge.js             # Claude Code SDK wrapper
├── preload.js                # Context bridge
├── db/database.js            # SQLite schema & migrations
├── skills/                   # Skill runtime backends
│   ├── browser/              # Chromium pool
│   ├── scheduler/            # Cron execution
│   ├── gmail/, slack/, notion/, google-sheets/, google-drive/, google-calendar/
├── channels/                 # iMessage, Slack messaging
├── mcp/mcp-server.js         # HTTP MCP server
└── triggers/                 # Event engine + webhook server
```

### Data Models

- **Agent** — id, name, role, personality, model, skills[], position, status, history, todos, spriteKey, color
- **Session** — id, agentId, claudeSessionId, title, messages[], totalCostUsd
- **AgentSkill** — markdown with YAML frontmatter (name, tools, runtime, auth)
- **ScheduledTask** — cron expression + prompt + agentId
- **Trigger** — pattern type (contains/regex/exact) + channel + agentId
- **ChannelMessage** — direction, sender, content, timestamp

---

## Web Version Implementation Plan

### Target Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | Next.js 15 (App Router) | SSR, API routes, edge-ready |
| Frontend | React 19 + TypeScript + Tailwind CSS | Direct port from current code |
| Graphics | Phaser 3 | Already browser-native, no changes needed |
| Database | PostgreSQL + Drizzle ORM | Multi-tenant, relational, migrations |
| Realtime | WebSockets (Socket.io) | Agent streaming, office sync |
| Queue | BullMQ + Redis | Agent tasks, scheduled jobs, retries |
| Sandbox | E2B or Docker | Isolated code execution per workspace |
| Storage | S3-compatible (Cloudflare R2) | Workspace files, assets, sprites |
| Auth | NextAuth.js (or Clerk) | OAuth, magic links, teams |
| AI | Anthropic Claude API (direct) | No SDK bridge needed server-side |
| Deploy | Vercel + Fly.io (workers) | Frontend edge, backend near-GPU |

### Phase 1 — Foundation (Weeks 1-3)

#### 1.1 Project Setup
- [ ] Initialize Next.js 15 project with TypeScript, Tailwind, Drizzle
- [ ] Set up PostgreSQL database (local + hosted)
- [ ] Set up Redis instance
- [ ] Configure environment variables and secrets management
- [ ] Set up CI/CD pipeline (GitHub Actions)

#### 1.2 Database Schema Migration
Translate SQLite schema to PostgreSQL with multi-tenancy:

```
users              — id, email, name, avatar, apiKey (encrypted), plan
teams              — id, name, ownerId
team_members       — teamId, userId, role
offices            — id, teamId, name, layout (JSON), assetPack
agents             — id, officeId, name, role, personality, model, spriteKey, color, position (JSON), config (JSON)
agent_skills       — agentId, skillId
skills             — id, officeId, name, emoji, description, content, runtime, authType
sessions           — id, agentId, userId, title, createdAt, updatedAt
messages           — id, sessionId, role, content, toolCalls (JSON), thinkingContent, costUsd, tokens
scheduled_tasks    — id, officeId, agentId, cron, prompt, enabled, lastRun, nextRun
triggers           — id, officeId, agentId, pattern, patternType, channel, prompt, enabled
channel_configs    — id, officeId, type, config (JSON, encrypted)
channel_messages   — id, channelConfigId, direction, sender, content, timestamp
skill_auth         — id, skillId, userId, tokens (JSON, encrypted)
cost_logs          — id, agentId, sessionId, inputTokens, outputTokens, costUsd, timestamp
```

#### 1.3 Auth & Multi-Tenancy
- [ ] NextAuth.js with GitHub, Google, email providers
- [ ] Team creation, invites, role-based access
- [ ] API key management (encrypted storage for Anthropic keys)
- [ ] Row-level security — all queries scoped to team/office

### Phase 2 — Core Backend (Weeks 3-6)

#### 2.1 API Layer
Replace Electron IPC with REST + WebSocket endpoints:

```
POST   /api/agents                    — Create agent
GET    /api/agents                    — List agents in office
PATCH  /api/agents/:id                — Update agent
DELETE /api/agents/:id                — Delete agent

POST   /api/agents/:id/messages       — Send message (starts streaming)
GET    /api/sessions                  — List sessions
GET    /api/sessions/:id/messages     — Get session messages

POST   /api/orchestrate               — Submit orchestration task
GET    /api/orchestrate/:id/status    — Poll orchestration progress

WS     /ws/office/:officeId           — Real-time office updates
WS     /ws/agent/:agentId/stream      — Agent response streaming
```

#### 2.2 AI Integration (Replace sdk-bridge.js)
- [ ] Server-side Claude API client (Anthropic SDK)
- [ ] System prompt builder (port `ai.ts` logic)
- [ ] Tool definition registry (port `tools.ts`)
- [ ] Streaming response handler → WebSocket relay
- [ ] Extended thinking support
- [ ] Token counting and cost tracking per message

#### 2.3 Orchestrator (Port orchestrator.ts)
- [ ] Task analysis and agent routing (server-side)
- [ ] Execution group management (parallel/sequential)
- [ ] Inter-agent message bus (`[ASK:AgentName]` protocol)
- [ ] BullMQ job queue for agent task execution
- [ ] Orchestration status tracking and progress events

#### 2.4 Sandboxed Execution
- [ ] E2B or Docker sandbox provisioning per workspace
- [ ] File read/write/list within sandbox
- [ ] Bash execution with timeout and resource limits
- [ ] Workspace file persistence to S3
- [ ] Git operations within sandbox

### Phase 3 — Frontend Port (Weeks 5-8)

#### 3.1 Layout & Navigation
- [ ] Port main 3-panel layout (sidebar, office, chat) from App.tsx
- [ ] Replace Electron window controls with responsive web layout
- [ ] Implement mobile-responsive breakpoints (office collapses, chat fullscreen)
- [ ] Dark/light theme support

#### 3.2 Phaser Office Scene (Direct Port)
- [ ] Embed Phaser 3 canvas in Next.js (dynamic import, no SSR)
- [ ] Port OfficeScene.ts, SpriteGen.ts, FurnitureGen.ts as-is
- [ ] Load sprite sheets and assets from CDN/S3
- [ ] Connect agent status updates via WebSocket → Phaser events
- [ ] Furniture drag-and-drop with server persistence
- [ ] Multi-user cursor presence (collaborative)

#### 3.3 Chat Interface
- [ ] Port ChatWindow.tsx (markdown rendering, tool call display, streaming)
- [ ] WebSocket-based message streaming (replace Electron IPC)
- [ ] Orchestration UI (task routing visualization, progress bars)
- [ ] File preview and code syntax highlighting
- [ ] Image/screenshot display from agent actions

#### 3.4 Component Ports
- [ ] AgentList — sidebar agent cards with live status
- [ ] TerminalPanel — live tool execution output via WebSocket
- [ ] GitPanel — server-side git operations, diff rendering
- [ ] SkillsModal — CRUD skills, assign to agents
- [ ] TriggersPanel — create/edit triggers and webhooks
- [ ] CostDashboard — per-agent/team spend visualization
- [ ] AssetsModal — upload and manage custom asset packs
- [ ] PermissionsPanel — approval gates for sensitive operations
- [ ] SettingsPanel — user/team/office configuration

### Phase 4 — Skills & Integrations (Weeks 7-10)

#### 4.1 Skill Runtime (Server-Side)
- [ ] Skill parser (port skill-parser.ts) — YAML frontmatter + markdown content
- [ ] Skill runtime manager on server
- [ ] Built-in skill bundling

#### 4.2 Browser Skill
- [ ] Headless Chromium pool (Puppeteer/Playwright on server)
- [ ] navigate, click, fill, screenshot, snapshot, evaluate tools
- [ ] Screenshot relay to client via WebSocket
- [ ] Session isolation per agent
- [ ] Proxy support for geo-specific browsing

#### 4.3 Scheduler Skill
- [ ] BullMQ-based cron scheduler (replace node-cron)
- [ ] Scheduled task CRUD API
- [ ] Execution logging and retry logic
- [ ] Dashboard showing upcoming/past runs

#### 4.4 Channel Integrations
- [ ] Slack — OAuth flow, message send/receive, webhook listener
- [ ] Email (Gmail/SMTP) — OAuth, send/receive
- [ ] Discord — Bot token integration
- [ ] Webhook receiver — Generic HTTP endpoint per office
- [ ] Drop iMessage (macOS-only, not viable for web)

#### 4.5 OAuth Flows
- [ ] Generic OAuth2 handler for Google (Gmail, Sheets, Drive, Calendar)
- [ ] Slack OAuth
- [ ] Notion OAuth
- [ ] Encrypted token storage in database

### Phase 5 — Collaboration & Polish (Weeks 9-12)

#### 5.1 Real-Time Collaboration
- [ ] Multiple users viewing same office simultaneously
- [ ] Cursor presence (who's looking at what)
- [ ] Agent "claimed by" indicator (prevent conflicting instructions)
- [ ] Activity feed (who did what, when)

#### 5.2 Agent Marketplace
- [ ] Export agent as template (role + personality + skills)
- [ ] Public/private template gallery
- [ ] One-click import into office
- [ ] Community ratings and usage stats

#### 5.3 Billing & Usage
- [ ] Stripe integration for subscription plans
- [ ] Token usage metering and limits
- [ ] Team billing with per-seat pricing
- [ ] Usage alerts and spending caps

#### 5.4 Performance & Scale
- [ ] WebSocket connection pooling
- [ ] Agent task queue with priority and concurrency limits
- [ ] CDN for static assets and sprite sheets
- [ ] Database query optimization and indexing
- [ ] Rate limiting on API endpoints

#### 5.5 Security
- [ ] API key encryption at rest (AES-256)
- [ ] Sandbox escape prevention (container hardening)
- [ ] Content Security Policy headers
- [ ] Input sanitization on all user content
- [ ] Audit log for sensitive operations
- [ ] GDPR compliance (data export, deletion)

---

## Migration Mapping

### What Ports Directly (~70%)

| Current | Web Version | Effort |
|---------|-------------|--------|
| React components (27) | Same, swap IPC calls for fetch/WS | Low |
| Phaser scenes (3 files) | Same, runs in browser natively | Minimal |
| Tailwind styles | Same | None |
| Type definitions (types.ts) | Same, add server-side types | Low |
| Orchestrator logic | Port to server, same algorithm | Medium |
| Skill parser | Same logic, server-side | Low |
| Cost tracking | Same logic, add billing | Low |

### What Needs Rewriting (~30%)

| Current | Web Version | Effort |
|---------|-------------|--------|
| Electron IPC (main.js, preload.js) | REST API + WebSocket server | High |
| sdk-bridge.js | Server-side Anthropic SDK client | Medium |
| SQLite database.js | PostgreSQL + Drizzle schema | Medium |
| Local filesystem ops | S3 + sandbox file ops | Medium |
| BrowserWindow pool | Headless Chromium on server | Medium |
| iMessage channel | Drop (replace with Discord/email) | N/A |
| electron-builder config | Vercel/Docker deployment | Low |

---

## Deployment Architecture

```
                    ┌──────────────┐
                    │   Vercel CDN  │
                    │  (Next.js SSR │
                    │   + Static)   │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │  API Server   │
                    │  (Next.js API │
                    │   or Express) │
                    └──┬───┬───┬───┘
                       │   │   │
              ┌────────┘   │   └────────┐
              │            │            │
       ┌──────▼──┐  ┌─────▼────┐  ┌───▼──────┐
       │PostgreSQL│  │  Redis   │  │    S3    │
       │(Neon/    │  │(Upstash/ │  │(R2/Minio)│
       │Supabase) │  │ Railway) │  │          │
       └──────────┘  └─────┬────┘  └──────────┘
                           │
                    ┌──────▼───────┐
                    │  BullMQ      │
                    │  Workers     │
                    │  (Fly.io)    │
                    └──┬───────┬───┘
                       │       │
              ┌────────▼┐  ┌──▼──────────┐
              │ Claude   │  │ E2B/Docker  │
              │ API      │  │ Sandboxes   │
              └──────────┘  └─────────────┘
```

---

## Success Metrics

- **P0**: Single user can create agents, chat, see office, run orchestrations
- **P1**: Streaming works smoothly, tools execute in sandbox, skills function
- **P2**: Multi-user collaboration, channels, triggers, scheduling
- **P3**: Marketplace, billing, mobile support, custom domains

---

## Estimated Effort

| Phase | Scope | Duration |
|-------|-------|----------|
| Phase 1 | Foundation (DB, auth, project setup) | 2-3 weeks |
| Phase 2 | Core backend (API, AI, orchestrator, sandbox) | 3-4 weeks |
| Phase 3 | Frontend port (layout, Phaser, chat, components) | 3-4 weeks |
| Phase 4 | Skills & integrations (browser, scheduler, channels) | 3-4 weeks |
| Phase 5 | Collaboration, marketplace, billing, polish | 3-4 weeks |
| **Total** | **Full web version** | **~12-16 weeks** |

Phases 2 and 3 can run in parallel with separate frontend/backend developers.
