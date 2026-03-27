---
name: Web Browser
description: "Browse the web, take screenshots, interact with pages, fill forms. Use when: researching online, checking websites, filling out web forms, taking screenshots."
emoji: "🌐"
runtime: browser
tools:
  - browse:navigate
  - browse:snapshot
  - browse:screenshot
  - browse:click
  - browse:fill
  - browse:evaluate
  - browse:show
  - browse:login
---

# Web Browser Skill

You can browse the web using the browse:* tools. A managed browser window handles navigation and interaction.

## Available Tools

- **browse:navigate** — Navigate to a URL. Returns the page text AND a snapshot of all interactive elements with their CSS selectors. **Start here.** Params: `url` (string).
- **browse:snapshot** — Get the interactive element snapshot for the current page without navigating. Use after a click to see what changed. No required params.
- **browse:screenshot** — Take a screenshot of the current page. Returns an actual image you can see. Use to visually verify state. No required params.
- **browse:click** — Click an element using a CSS selector from the interactive snapshot. Returns the updated snapshot after clicking. Params: `selector` (string).
- **browse:fill** — Fill a form field. Params: `selector` (string), `value` (string).
- **browse:evaluate** — Execute JavaScript in the page context. **Use as a last resort** — prefer the other tools. Params: `script` (string).
- **browse:show** — Show the browser window to the user so they can see or interact with the page. Displays a "Done" banner. Use to present results, let the user review content, or hand off for manual steps. Params: `url` (string, optional), `message` (string, optional).
- **browse:login** — Show the browser window so the user can log in manually. Params: `url` (string, optional), `message` (string, optional).

## Workflow

1. **Navigate** to the target URL with `browse:navigate` — the response includes all interactive elements with selectors
2. **Click or fill** using the selectors from the snapshot — no need to probe the DOM
3. After a click, the response includes the **updated snapshot** so you can see what changed
4. Use `browse:screenshot` if you need to visually verify the page state
5. Use `browse:snapshot` to refresh the interactive element list without navigating

## Best Practices

- **Never probe the DOM manually** with `browse:evaluate` to find elements — the interactive snapshot gives you everything
- Use the CSS selectors exactly as shown in the snapshot (e.g. `[aria-label="Like"]`)
- When a site requires authentication, use `browse:login` to let the user sign in
- A typical interaction should be 2-3 tool calls: navigate → click → done
