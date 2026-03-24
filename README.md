<p align="center">
  <img src="build/icon.png" alt="Outworked" width="128" />
</p>

<h1 align="center">Outworked</h1>

<p align="center">
  <strong>AI agent orchestration with an 8-bit office GUI.</strong>
</p>

<p align="center">
  <a href="https://github.com/outworked/outworked/releases"><img src="https://img.shields.io/badge/version-0.1.7-green.svg" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="License: GPL-3.0" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/electron-41-47848F.svg" alt="Electron" />
  <img src="https://img.shields.io/badge/react-19-61DAFB.svg" alt="React" />
</p>

<p align="center">
  Outworked turns AI agents into office employees you can see, click on, and manage.<br/>
  Think <strong>Animal Crossing meets Claude Code</strong> — a cute pixel-art office where each agent has a desk, a personality, and real tasks to do.
</p>

<p align="center">
  <a href="https://github.com/outworked/outworked/releases"><strong>Download</strong></a> ·
  <a href="#how-it-works"><strong>How It Works</strong></a> ·
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#skills"><strong>Skills</strong></a> ·
  <a href="#roadmap"><strong>Roadmap</strong></a>
</p>

---

<p align="center">
  <img src="build/demo.gif" alt="Outworked Demo" width="720" />
</p>

---

## How It Works

1. **Hire agents** — Create employees with a name, role, personality, model, and sprite
2. **Assign tasks** — Describe a goal in plain English; the orchestrator breaks it into subtasks and routes them to the right agents
3. **Watch them work** — Agents walk to their desks, execute Claude Code sessions, edit files, run commands, and collaborate with each other in real time
4. **Ship code** — Review changes in the built-in git panel, approve PRs, and merge — all without leaving the office

---

## Features

- **Visual Office** — Phaser-powered 8-bit office where agents walk, sit, and collaborate in real time
- **Agent Customization** — Give each agent a name, role, personality (system prompt), model, and sprite
- **Task Orchestration** — Describe a goal; the router breaks it into tasks and assigns them to agents
- **Multi-Agent Collaboration** — Agents talk to each other via `[ASK:AgentName]` and a shared message bus
- **Claude Code Integration** — Full tool access (Bash, Edit, Read, etc.) with session persistence
- **Live Chat** — Markdown-rendered conversations with syntax-highlighted code blocks and diffs
- **Git Panel** — View status, staged changes, branches, and create PRs without leaving the app
- **File Browser** — Live-updating workspace tree that syncs as agents edit files
- **Skills System** — Plug-in skills via `SKILL.md` files (GitHub, Whisper, Apple Notes, PDF, and more)
- **Cost Dashboard** — Track tokens and spend per agent, session, and day
- **Background Mode** — Agents continue working when minimized, with tray icon updates
- **Parallel Processing** — Multiple agents tackle subtasks simultaneously
- **Permissions & Safety** — Allowlists, directory restrictions, timeouts, audit logging, and approval prompts
- **Desktop Notifications** — Get notified when tasks finish or agents need approval
- **8-Bit Soundtrack** — Because every office needs background music

---

## Supported Models

| Provider  | Models                             |
| --------- | ---------------------------------- |
| Anthropic | Claude Opus 4.6, Claude Sonnet 4.6 |
| Local     | Any model via Claude Code          |

Each agent can run a different model — pair a fast model for simple tasks with a powerful one for complex work.

---

## Install

Download the latest release from [**GitHub Releases**](https://github.com/outworked/outworked/releases):

| Platform | Format                        |
| -------- | ----------------------------- |
| macOS    | `.dmg` (drag to Applications) |

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### From Source

```bash
# Requires Node.js v18+
git clone https://github.com/outworked/outworked.git
cd outworked
npm install
npm run electron:dev
```

On first launch, the onboarding modal will walk you through picking a workspace and creating your first agent.

---

## Scripts

| Command                  | Description                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run dev`            | Start Vite dev server (browser only, no Electron)                           |
| `npm run electron:dev`   | Build and launch the full Electron app                                      |
| `npm run electron:build` | Package distributable (dmg/zip on macOS, exe on Windows, AppImage on Linux) |

---

## Tech Stack

| Layer    | Technology                           |
| -------- | ------------------------------------ |
| Desktop  | Electron                             |
| Frontend | React 19 + TypeScript + Tailwind CSS |
| Build    | Vite                                 |
| Graphics | Phaser 3                             |
| AI       | Claude Code SDK                      |

---

## Project Structure

```
src/
├── components/       # React UI (ChatWindow, OfficeCanvas, GitPanel, etc.)
├── lib/              # Core logic (AI, orchestration, terminal, storage, costs)
├── basic-skills/     # Bundled SKILL.md modules (github, whisper, etc.)
└── phaser/           # Phaser game scene and sprite logic

electron/
├── main.js           # Electron main process (IPC, shell, permissions)
├── preload.js        # Context bridge to renderer
└── sdk-bridge.js     # Claude Code SDK bridge

public/
├── sprites/          # 8-bit character sprite sheets (procedurally generated)
├── backgrounds/      # Office background art
└── music/            # Background music tracks
```

---

## Skills

Outworked uses a `SKILL.md` format — markdown files with YAML frontmatter that define what an agent can do. Bundled skills include:

| Skill        | Description                                           |
| ------------ | ----------------------------------------------------- |
| **github**   | GitHub API access via `gh` CLI (issues, PRs, CI runs) |
| **mcporter** | MCP server support                                    |

Create custom skills by writing a `SKILL.md` file and assigning it to any agent.

---

## Safety Model

Outworked takes a defense-in-depth approach:

1. **Approval gates** — Explicit approval required before dangerous commands (deletes, installs, network changes)
2. **Command allowlists** — Permit or block specific shell commands per agent
3. **Directory restrictions** — Agents are confined to their workspace
4. **Timeouts** — Configurable limits on long-running tasks
5. **Audit trail** — Full logging of all agent actions
6. **Plan-first execution** — Agents produce a plan before making changes
7. **Permissions dashboard** — Review and manage all access grants in one place

---

## Roadmap

- [x] Conversation persistence & session history
- [x] Streaming markdown output with syntax highlighting
- [x] Live file watcher & workspace sync
- [x] Git integration panel
- [x] MCP server support
- [x] Multi-agent collaboration
- [x] Cost & token dashboard
- [x] Desktop notifications
- [x] Background agent mode
- [x] Parallel task processing
- [ ] Agent templates
- [ ] Hooks configuration UI
- [ ] Customizable sprites & backgrounds
- [ ] More model integrations

---

## The Soundtrack

Every office needs a vibe. Outworked ships with an original 8-bit soundtrack featuring tracks like:

> _"Don't Ever Turn Me Off"_ · _"She's Just a Coder Agent"_ · _"LLM Love Lying Machine"_ · _"Can Love Be Binary"_ · _"Goodbye Humans"_ · _"How Does Grass Feel"_ · _"Are You Even Reading This"_

Toggle music from the player in the bottom-left corner.

---

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please open a discussion first for large changes so we can discuss the approach.

---

## FAQ

<details>
<summary><strong>Do I need a Claude API key?</strong></summary>

No. Outworked uses Claude Code under the hood, so you just need Claude Code installed and authenticated. Your existing Claude Code subscription covers usage.

</details>

<details>
<summary><strong>Is my code sent to the cloud?</strong></summary>

Outworked runs locally on your machine. Code is processed through whichever model provider you select for each agent, with the same privacy guarantees as using those APIs directly.

</details>

<details>
<summary><strong>Can agents mess up my codebase?</strong></summary>

Agents require explicit approval for destructive operations, are restricted to their workspace directory, and produce a plan before executing. You can also configure command allowlists and timeouts per agent. See <a href="#safety-model">Safety Model</a>.

</details>

<details>
<summary><strong>How do I create a custom skill?</strong></summary>

Write a markdown file with YAML frontmatter (name, description, tools) and save it as `SKILL.md`. Then assign it to any agent from the Skills panel. See the bundled skills in `src/basic-skills/` for examples.

</details>

---

## License

[GPL-3.0](LICENSE)
