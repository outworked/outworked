// ─── Browser Runtime ──────────────────────────────────────────────
// Active skill runtime that manages a pool of hidden Electron BrowserWindow
// instances, one per agentId, up to a configurable maximum.

const BaseRuntime = require("../base-runtime");
const { BrowserWindow, session } = require("electron");

// Maximum number of concurrent browser windows
const MAX_WINDOWS = 3;

// Shared session partition for all browse windows — keeps cookies/storage
// isolated from the main app and lets us strip CSP once for all browse windows.
const BROWSE_PARTITION = "persist:outworked-browse";

// Milliseconds to wait after navigation for dynamic content to settle
const NAVIGATE_SETTLE_MS = 2000;

// Milliseconds to wait after a click for any resulting navigation/render
const CLICK_SETTLE_MS = 800;

// Maximum characters of page text returned by browse:navigate
const TEXT_TRUNCATE_LIMIT = 8000;

// Maximum interactive elements to include in the snapshot
const MAX_INTERACTIVE_ELEMENTS = 80;

// ── Interactive element snapshot script ──────────────────────────
// Injected into the page to extract a structured list of clickable/fillable
// elements with stable selectors so the agent can act in 1-2 calls.
const SNAPSHOT_SCRIPT = `
(() => {
  const INTERACTIVE = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [tabindex]';
  const MAX = ${MAX_INTERACTIVE_ELEMENTS};
  const seen = new Set();
  const results = [];

  function getSelector(el) {
    // Prefer aria-label — most stable on modern sites
    const aria = el.getAttribute('aria-label');
    const role = el.getAttribute('role');
    if (aria) {
      var sel = '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
      if (role) sel += '[role="' + role + '"]';
      return sel;
    }

    // data-testid
    const testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';

    // id
    if (el.id) return '#' + CSS.escape(el.id);

    // name (for form elements)
    const tag = el.tagName;
    if (el.name && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')) {
      return tag.toLowerCase() + '[name="' + el.name + '"]';
    }

    // Build a selector from child aria-label (e.g. button containing svg[aria-label="Like"])
    const labeledChild = el.querySelector('[aria-label]');
    if (labeledChild) {
      const childAria = labeledChild.getAttribute('aria-label');
      const childTag = labeledChild.tagName.toLowerCase();
      return ':has(> ' + childTag + '[aria-label="' + childAria.replace(/"/g, '\\\\"') + '"])';
    }

    // Fall back to nth-of-type path (last resort)
    const t = tag.toLowerCase();
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(c => c.tagName === tag);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el) + 1;
        return t + ':nth-of-type(' + idx + ')';
      }
    }
    return t;
  }

  function getLabel(el) {
    // Direct aria-label
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;

    // Check child SVGs/icons with aria-labels (common in React apps like Instagram)
    const labeledChild = el.querySelector('[aria-label]');
    if (labeledChild) return labeledChild.getAttribute('aria-label');

    const text = (el.innerText || '').trim();
    if (text && text.length < 80) return text;
    if (text) return text.substring(0, 77) + '...';
    const title = el.getAttribute('title');
    if (title) return title;
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;
    return '';
  }

  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (results.length >= MAX) break;

    // Skip hidden/zero-size elements
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (el.offsetParent === null && el.tagName !== 'BODY') continue;

    const selector = getSelector(el);
    const key = selector + '|' + el.tagName;
    if (seen.has(key)) continue;
    seen.add(key);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
    const label = getLabel(el);
    const type = el.type || '';
    const value = (tag === 'input' || tag === 'textarea') ? (el.value || '') : '';
    const checked = el.checked;
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';

    let entry = '[' + results.length + '] ' + role;
    if (label) entry += ' "' + label + '"';
    if (type && type !== 'submit' && type !== 'button') entry += ' type=' + type;
    if (value) entry += ' value="' + value.substring(0, 40) + '"';
    if (checked) entry += ' [checked]';
    if (disabled) entry += ' [disabled]';
    entry += '  →  ' + selector;

    results.push(entry);
  }
  return results.join('\\n');
})()
`;

class BrowserRuntime extends BaseRuntime {
  constructor() {
    super("browser");

    /** @type {Map<string, BrowserWindow>} agentId -> BrowserWindow */
    this.windows = new Map();
    this.maxWindows = MAX_WINDOWS;

    // ── Register tools ────────────────────────────────────────────
    this.registerTool(
      "browse:navigate",
      {
        name: "browse:navigate",
        description:
          "Navigate to a URL and return the page text plus a snapshot of all interactive elements (buttons, links, inputs) with their selectors. Use the selectors from the snapshot with browse:click or browse:fill — no need to probe the DOM yourself.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to navigate to" },
            agentId: {
              type: "string",
              description: "Agent ID (for window management)",
            },
          },
          required: ["url"],
        },
      },
      this._navigate,
      { timeout: 60_000 },
    );

    this.registerTool(
      "browse:snapshot",
      {
        name: "browse:snapshot",
        description:
          "Return a snapshot of all interactive elements on the current page with their selectors, without navigating. Useful after a click changes the page.",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Agent ID" },
          },
          required: [],
        },
      },
      this._snapshot,
    );

    this.registerTool(
      "browse:screenshot",
      {
        name: "browse:screenshot",
        description:
          "Take a screenshot of the current page and return it as an image. Use this to visually verify page state.",
        parameters: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "Agent ID" },
          },
          required: [],
        },
      },
      this._screenshot,
    );

    this.registerTool(
      "browse:click",
      {
        name: "browse:click",
        description:
          "Click an element using a CSS selector from the interactive snapshot. Returns the updated interactive snapshot after clicking.",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description:
                "CSS selector from the interactive snapshot (e.g. [aria-label=\"Like\"] or #submit-btn)",
            },
            agentId: { type: "string", description: "Agent ID" },
          },
          required: ["selector"],
        },
      },
      this._click,
    );

    this.registerTool(
      "browse:fill",
      {
        name: "browse:fill",
        description: "Fill a form field with a value",
        parameters: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: "CSS selector for the input element",
            },
            value: {
              type: "string",
              description: "Value to fill into the field",
            },
            agentId: { type: "string", description: "Agent ID" },
          },
          required: ["selector", "value"],
        },
      },
      this._fill,
    );

    this.registerTool(
      "browse:evaluate",
      {
        name: "browse:evaluate",
        description:
          "Execute JavaScript in the page context and return the result. Use as a last resort — prefer browse:click, browse:fill, and browse:snapshot for interactions.",
        parameters: {
          type: "object",
          properties: {
            script: {
              type: "string",
              description: "JavaScript expression or statement to execute",
            },
            agentId: { type: "string", description: "Agent ID" },
          },
          required: ["script"],
        },
      },
      this._evaluate,
    );

    this.registerTool(
      "browse:show",
      {
        name: "browse:show",
        description:
          'Show the browser window to the user so they can see or interact with the current page. Displays a "Done" banner — when the user clicks Done the window hides and control returns to you. Use this to show results, let the user review content, or hand off for manual interaction.',
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "Optional URL to navigate to before showing the window",
            },
            message: {
              type: "string",
              description:
                'Message to display in the banner (default: "Click Done when finished")',
            },
            agentId: { type: "string", description: "Agent ID" },
          },
          required: [],
        },
      },
      this._show,
      { timeout: 300_000 },
    );

    this.registerTool(
      "browse:login",
      {
        name: "browse:login",
        description:
          'Show the browser window so the user can log in to a website manually. The window is displayed with a "Done" banner — once the user finishes logging in and clicks Done, the window hides and control returns to you.',
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description:
                "URL to navigate to before showing the window (e.g. a login page)",
            },
            message: {
              type: "string",
              description:
                "Optional message to display to the user in the banner",
            },
            agentId: { type: "string", description: "Agent ID" },
          },
          required: [],
        },
      },
      this._login,
      { timeout: 300_000 },
    );
  }

  // ── Auth ──────────────────────────────────────────────────────

  async authenticate() {
    this.status = "connected";
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async destroy() {
    for (const [, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.close();
      }
    }
    this.windows.clear();
    this.status = "disconnected";
  }

  // ── Private: window pool ───────────────────────────────────────

  _getOrCreateWindow(agentId) {
    const existing = this.windows.get(agentId);
    if (existing && !existing.isDestroyed()) {
      return existing;
    }

    // Evict the oldest window when the pool is full
    if (this.windows.size >= this.maxWindows) {
      const oldestId = this.windows.keys().next().value;
      const oldest = this.windows.get(oldestId);
      if (oldest && !oldest.isDestroyed()) {
        oldest.close();
      }
      this.windows.delete(oldestId);
    }

    // Use a dedicated session partition so CSP stripping doesn't affect the
    // main app, and so login cookies persist across browse windows.
    const browseSession = session.fromPartition(BROWSE_PARTITION);

    // Strip CSP headers once per session — real sites load resources from
    // their own CDNs which Electron's default CSP blocks.
    if (!this._cspStripped) {
      browseSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        delete headers["content-security-policy"];
        delete headers["Content-Security-Policy"];
        delete headers["content-security-policy-report-only"];
        delete headers["Content-Security-Policy-Report-Only"];
        callback({ responseHeaders: headers });
      });
      this._cspStripped = true;
    }

    const win = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        session: browseSession,
      },
    });

    // Set a realistic user-agent so sites don't block or serve broken pages
    win.webContents.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );

    win.on("closed", () => {
      if (this.windows.get(agentId) === win) {
        this.windows.delete(agentId);
      }
    });

    this.windows.set(agentId, win);
    return win;
  }

  // ── Helpers ────────────────────────────────────────────────────

  async _waitForLoad(win) {
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        win.webContents.once("did-stop-loading", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    await _sleep(NAVIGATE_SETTLE_MS);
  }

  async _getInteractiveSnapshot(win) {
    try {
      return await win.webContents.executeJavaScript(SNAPSHOT_SCRIPT);
    } catch (err) {
      console.warn("[browser] Snapshot extraction failed:", err.message);
      return "(could not extract interactive elements)";
    }
  }

  // ── Tool implementations ──────────────────────────────────────

  async _navigate({ url, agentId }) {
    const win = this._getOrCreateWindow(agentId || "default");

    // loadURL can hang on redirects, SPAs, or error pages — race with a timeout
    const LOAD_TIMEOUT_MS = 30_000;
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error("Page load timed out")),
            LOAD_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      const currentUrl = win.webContents.getURL();
      if (!currentUrl || currentUrl === "about:blank") {
        throw new Error(`Failed to load ${url}: ${err.message}`);
      }
    }

    await this._waitForLoad(win);

    let title = "";
    let text = "";

    try {
      title = await win.webContents.executeJavaScript("document.title");
    } catch (err) {
      console.warn("[browser] Could not read document.title:", err.message);
    }

    try {
      text = await win.webContents.executeJavaScript(
        "document.body?.innerText || ''",
      );
    } catch (err) {
      console.warn("[browser] Could not read body text:", err.message);
      text = "";
    }

    const truncated =
      text.length > TEXT_TRUNCATE_LIMIT
        ? text.slice(0, TEXT_TRUNCATE_LIMIT) + "\n\n[truncated]"
        : text;

    const snapshot = await this._getInteractiveSnapshot(win);

    return `# ${title}\nURL: ${win.webContents.getURL()}\n\n${truncated}\n\n## Interactive Elements\n${snapshot}`;
  }

  async _snapshot({ agentId }) {
    const win = this._getOrCreateWindow(agentId || "default");
    const url = win.webContents.getURL();
    const title = await win.webContents
      .executeJavaScript("document.title")
      .catch(() => "");
    const snapshot = await this._getInteractiveSnapshot(win);
    return `# ${title}\nURL: ${url}\n\n## Interactive Elements\n${snapshot}`;
  }

  async _screenshot({ agentId }) {
    const win = this._getOrCreateWindow(agentId || "default");
    try {
      const image = await win.webContents.capturePage();
      const base64 = image.toPNG().toString("base64");
      // Return structured result — the MCP server will send this as an image
      return {
        __mcp_content: [
          {
            type: "image",
            data: base64,
            mimeType: "image/png",
          },
        ],
      };
    } catch (err) {
      throw new Error(`browse:screenshot failed: ${err.message}`);
    }
  }

  async _click({ selector, agentId }) {
    const win = this._getOrCreateWindow(agentId || "default");

    // Find the element, walk up to the nearest clickable ancestor if needed
    // (handles SVGs inside role="button" divs, spans inside links, etc.),
    // scroll it into view, and simulate a full mouse click sequence.
    const clicked = await win.webContents.executeJavaScript(`
      (() => {
        let el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'NOT_FOUND';

        // If the element itself isn't natively clickable, walk up to the
        // nearest interactive ancestor (React apps put handlers there).
        const CLICKABLE = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], input, select, textarea';
        if (!el.matches(CLICKABLE)) {
          const ancestor = el.closest(CLICKABLE);
          if (ancestor) el = ancestor;
        }

        // Scroll into view
        el.scrollIntoView({ block: 'center', behavior: 'instant' });

        // Get element center coordinates for realistic mouse events
        const rect = el.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

        // Full mouse event sequence — required for React/Vue/Angular apps
        el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));

        return 'OK';
      })()
    `);

    if (clicked === "NOT_FOUND") {
      throw new Error(`Element not found: ${selector}`);
    }

    await _sleep(CLICK_SETTLE_MS);
    await this._waitForLoad(win);

    // Return updated snapshot so agent can see what changed
    const snapshot = await this._getInteractiveSnapshot(win);
    const url = win.webContents.getURL();
    return `Clicked: ${selector}\nURL: ${url}\n\n## Interactive Elements (after click)\n${snapshot}`;
  }

  async _fill({ selector, value, agentId }) {
    const win = this._getOrCreateWindow(agentId || "default");
    try {
      await win.webContents.executeJavaScript(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
          el.focus();
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()
      `);
    } catch (err) {
      throw new Error(
        `browse:fill failed for selector "${selector}": ${err.message}`,
      );
    }
    return `Filled ${selector} with value`;
  }

  async _evaluate({ script, agentId }) {
    const win = this._getOrCreateWindow(agentId || "default");
    let result;
    try {
      result = await win.webContents.executeJavaScript(script);
    } catch (err) {
      throw new Error(`browse:evaluate failed: ${err.message}`);
    }
    return String(result);
  }

  async _show({ url, message, agentId }) {
    return this._showWindow({
      url,
      message: message || "Click Done when finished.",
      agentId,
      resultPrefix: "User finished viewing.",
    });
  }

  async _login({ url, message, agentId }) {
    return this._showWindow({
      url,
      message: message || "Log in below, then click Done when finished.",
      agentId,
      resultPrefix: "Login complete.",
    });
  }

  // ── Shared: show window with Done banner ───────────────────────

  async _showWindow({ url, message, agentId, resultPrefix }) {
    const win = this._getOrCreateWindow(agentId || "default");

    if (url) {
      try {
        await Promise.race([
          win.loadURL(url),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Page load timed out")), 30_000),
          ),
        ]);
      } catch {
        // Partial load is fine — user will see the page
      }
      await _sleep(NAVIGATE_SETTLE_MS);
    }

    const bannerText = message;
    await win.webContents.executeJavaScript(`
      (() => {
        const existing = document.getElementById('__outworked_banner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = '__outworked_banner';
        banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#4f46e5;color:white;font-family:-apple-system,system-ui,sans-serif;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.3);';

        const label = document.createElement('span');
        label.textContent = ${JSON.stringify(bannerText)};
        banner.appendChild(label);

        const btn = document.createElement('button');
        btn.textContent = 'Done';
        btn.style.cssText = 'margin-left:16px;padding:6px 20px;background:white;color:#4f46e5;border:none;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer;';
        btn.onmouseover = () => btn.style.background = '#e0e7ff';
        btn.onmouseout  = () => btn.style.background = 'white';
        btn.onclick = () => { document.title = '__outworked_done'; };
        banner.appendChild(btn);

        document.body.prepend(banner);
      })()
    `);

    win.show();
    win.focus();

    const finalUrl = await new Promise((resolve) => {
      const onTitle = (_event, title) => {
        if (title === "__outworked_done") {
          win.webContents.removeListener("page-title-updated", onTitle);
          resolve(win.webContents.getURL());
        }
      };
      win.webContents.on("page-title-updated", onTitle);
      win.once("closed", () => resolve(null));
    });

    if (finalUrl !== null && !win.isDestroyed()) {
      await win.webContents.executeJavaScript(`
        (() => {
          const b = document.getElementById('__outworked_banner');
          if (b) b.remove();
        })()
      `);
      win.hide();
    }

    if (finalUrl === null) {
      return "Window was closed by the user.";
    }
    return `${resultPrefix} Current page: ${finalUrl}`;
  }
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = BrowserRuntime;
