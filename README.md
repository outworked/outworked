<p align="center">
  <img src="build/icon.png" alt="Outworked" width="128" />
</p>

<h1 align="center">Outworked</h1>

<p align="center">
  <strong>Your AI dev team, visualized. Hire agents. Assign tasks. Watch them code.</strong>
</p>

<p align="center">
  <a href="https://github.com/outworked/outworked/releases"><img src="https://img.shields.io/badge/version-0.2.0-green.svg" alt="Version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL%203.0-blue.svg" alt="License: GPL-3.0" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey.svg" alt="Platform" />
  <img src="https://img.shields.io/badge/electron-41-47848F.svg" alt="Electron" />
  <img src="https://img.shields.io/badge/react-19-61DAFB.svg" alt="React" />
</p>

<h3 align="center">Download it. Open it. Start building.</h3>
<p align="center"><em>No build steps, no config, no API keys. Just a .dmg and your Claude Code login.</em></p>

<p align="center">
  <a href="https://github.com/outworked/outworked/releases/tag/v0.2.0">
    <img src="https://img.shields.io/badge/Download_Latest_Release-v0.2.0-brightgreen?style=for-the-badge&logo=github" alt="Download Latest Release" />
  </a>
</p>

<p align="center">
  <strong>Animal Crossing meets Claude Code.</strong><br/>
  A pixel-art office where AI agents have desks, personalities, and real code to ship.<br/>
  Describe what you want built — Outworked breaks it into tasks, assigns agents, and lets you<br/>
  watch them collaborate, edit files, and open PRs in real time.
</p>

<p align="center">
  <a href="https://github.com/outworked/outworked/releases/"><strong>Download the Latest Release</strong></a> ·
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

1. **Hire agents** — Give each one a name, role, personality, model, and pixel sprite
2. **Describe a goal** — Write what you want in plain English; the orchestrator breaks it into subtasks and routes them to the right agents automatically
3. **Watch them work** — Agents walk to their desks, open Claude Code sessions, edit files, run commands, and talk to each other — all visible in the office
4. **Ship code** — Review diffs in the built-in git panel, approve PRs, and merge without ever leaving the app

---

## Why Outworked?

Most AI coding tools give you a chat box. Outworked gives you an **office**.

You don't just prompt one model — you build a team. A frontend agent, a backend agent, a reviewer. They work in parallel, talk to each other, and you can see all of it happening live in a pixel-art world. It's the most fun way to ship code with AI.

## Features

- **Pixel Office** — A Phaser-powered world where your agents walk, sit at desks, and collaborate — in real time
- **Build a Team** — Give each agent a name, role, personality, model, and sprite. Mix Claude Opus for hard problems with Sonnet for fast ones
- **Auto-Orchestration** — Describe a goal; the router breaks it into tasks and assigns them to the right agents
- **Multi-Agent Collaboration** — Agents talk to each other via `[ASK:AgentName]` and a shared message bus
- **Full Claude Code Power** — Every agent gets full tool access (Bash, Edit, Read, etc.) with persistent sessions
- **Live Chat** — Markdown-rendered conversations with syntax-highlighted code blocks and diffs
- **Built-in Git** — View status, staged changes, branches, and create PRs without leaving the app
- **File Browser** — Live-updating workspace tree that syncs as agents edit files
- **Skills System** — Extend agents with plug-in `SKILL.md` files (GitHub, MCP servers, and more)
- **Cost Dashboard** — Track tokens and spend per agent, session, and day
- **Background Mode** — Minimize and let agents keep working. Tray icon keeps you updated
- **Parallel Processing** — Multiple agents tackle subtasks simultaneously
- **Safe by Default** — Approval gates, command allowlists, directory restrictions, timeouts, and full audit logging
- **Desktop Notifications** — Get pinged when tasks finish or agents need approval
- **Original Soundtrack** — Because every office needs a vibe

---

## Supported Models

| Provider  | Models                             |
| --------- | ---------------------------------- |
| Anthropic | Claude Opus 4.6, Claude Sonnet 4.6 |
| Local     | Any model via Claude Code          |

Each agent can run a different model — pair a fast model for simple tasks with a powerful one for complex work.

---

## Get Started in 2 Minutes

### 1. Download

Grab the latest release for your platform:

<p align="center">
  <a href="https://github.com/outworked/outworked/releases"><strong>Download Outworked</strong></a>
</p>

| Platform | Format                        |
| -------- | ----------------------------- |
| macOS    | `.dmg` (drag to Applications) |

### 2. Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (your existing subscription covers usage — no separate API key needed)

### 3. Launch and Hire Your First Agent

On first launch, the onboarding modal walks you through picking a workspace and creating your first agent. You'll be watching pixel employees write code in under two minutes.

### Build from Source

```bash
git clone https://github.com/outworked/outworked.git
cd outworked
npm install
npm run electron:dev
```

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

Every office needs a vibe. Outworked ships with an original soundtrack featuring tracks like:

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

Nope. Outworked runs on Claude Code, so your existing subscription covers everything. No extra keys or billing to set up.

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
