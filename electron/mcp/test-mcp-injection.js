#!/usr/bin/env node
// Tests for MCP server injection and per-agent permissions.
//
// These are pure unit tests — no running Outworked app required.
// They exercise the MCP assembly logic that determines which MCP
// servers and runtimes each agent sees.
//
// Run: node electron/mcp/test-mcp-injection.js

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// ─── Inline the pure functions from src/lib/ai.ts ───────────────
// (These mirror the exported buildMcpServers / buildAllowedRuntimes
//  so we can test without a TS build step.)

function buildMcpServers({ subDef, agentId, allowedRuntimes, useTools }) {
  let mcpServers = subDef?.mcpServers
    ? subDef.mcpServers.filter(
        (s) => !(typeof s === "object" && s !== null && "outworked-skills" in s),
      )
    : [];

  if (useTools) {
    const qsParts = [];
    if (agentId) qsParts.push(`agentId=${encodeURIComponent(agentId)}`);
    if (allowedRuntimes) {
      qsParts.push(`runtimes=${encodeURIComponent(allowedRuntimes.join(","))}`);
    }
    const qs = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";
    mcpServers.push({
      "outworked-skills": {
        type: "http",
        url: `http://127.0.0.1:7823/mcp${qs}`,
      },
    });
  }

  return mcpServers;
}

function buildAllowedRuntimes(allResolvedSkills) {
  return [
    ...new Set(
      allResolvedSkills
        .map((s) => s.metadata?.runtime)
        .filter((r) => typeof r === "string"),
    ),
  ];
}

// Simulates the global skill exclusion logic from sendMessage()
function resolveRuntimes({ globalSkills, agentSkills, excludeGlobalSkills }) {
  const excludeSet = new Set(excludeGlobalSkills || []);
  const filteredGlobal = globalSkills.filter((s) => !excludeSet.has(s.id));
  const allSkills = [...filteredGlobal, ...agentSkills];
  return buildAllowedRuntimes(allSkills);
}

// ─── Test helpers ───────────────────────────────────────────────

function skill(id, runtime) {
  return { id, name: id, content: "", metadata: runtime ? { runtime } : {} };
}

function getOutworkedSkillsUrl(mcpServers) {
  for (const entry of mcpServers) {
    if (typeof entry === "object" && "outworked-skills" in entry) {
      return entry["outworked-skills"].url;
    }
  }
  return null;
}

function getRuntimesFromUrl(url) {
  if (!url) return null;
  const u = new URL(url);
  const r = u.searchParams.get("runtimes");
  return r ? r.split(",").sort() : [];
}

function getAgentIdFromUrl(url) {
  if (!url) return null;
  return new URL(url).searchParams.get("agentId");
}

// ─── Tests ──────────────────────────────────────────────────────

console.log("\n=== MCP Injection & Per-Agent Permission Tests ===\n");

// ── 1. Agent-specific MCP servers are included ──────────────────
console.log("1. Agent with assigned MCP servers sees them");
{
  const subDef = {
    description: "GitHub bot",
    mcpServers: [
      "github",
      { "my-postgres": { type: "stdio", command: "npx", args: ["@mcp/postgres"] } },
    ],
  };
  const result = buildMcpServers({ subDef, agentId: "agent-1", useTools: true });

  assert("includes github preset", result.includes("github"));
  assert("includes my-postgres server", result.some(
    (s) => typeof s === "object" && "my-postgres" in s,
  ));
  assert("includes outworked-skills", result.some(
    (s) => typeof s === "object" && "outworked-skills" in s,
  ));
  assert("total 3 entries (github + postgres + outworked-skills)", result.length === 3);
}

// ── 2. Agent with NO MCP servers only gets outworked-skills ─────
console.log("2. Agent with no MCP servers gets only outworked-skills");
{
  const result = buildMcpServers({ subDef: { description: "bare" }, agentId: "agent-2", useTools: true });

  assert("only 1 entry", result.length === 1);
  assert("it is outworked-skills", typeof result[0] === "object" && "outworked-skills" in result[0]);
}

// ── 3. Agent with no subagentDef at all ─────────────────────────
console.log("3. Agent with undefined subagentDef");
{
  const result = buildMcpServers({ subDef: undefined, agentId: "agent-3", useTools: true });

  assert("gets outworked-skills", result.length === 1);
  assert("url contains agentId", getAgentIdFromUrl(getOutworkedSkillsUrl(result)) === "agent-3");
}

// ── 4. Duplicate outworked-skills in agent def is filtered ──────
console.log("4. Duplicate outworked-skills in agent config is deduplicated");
{
  const subDef = {
    description: "test",
    mcpServers: [
      { "outworked-skills": { type: "http", url: "http://old-url/mcp" } },
      "github",
    ],
  };
  const result = buildMcpServers({ subDef, agentId: "agent-4", useTools: true });

  const owEntries = result.filter((s) => typeof s === "object" && "outworked-skills" in s);
  assert("only 1 outworked-skills entry (not 2)", owEntries.length === 1);
  assert("uses canonical URL (not the agent's stale one)",
    owEntries[0]["outworked-skills"].url.includes("127.0.0.1:7823"));
  assert("github still present", result.includes("github"));
}

// ── 5. Tools disabled → no MCP servers at all ───────────────────
console.log("5. Tools disabled skips all MCP injection");
{
  const subDef = {
    description: "router",
    mcpServers: ["github"],
  };
  const result = buildMcpServers({ subDef, useTools: false });

  assert("github is kept (agent-specific)", result.includes("github"));
  assert("no outworked-skills injected", !result.some(
    (s) => typeof s === "object" && "outworked-skills" in s,
  ));
}

// ── 6. Runtime filtering via skills ─────────────────────────────
console.log("6. Allowed runtimes derived from agent skills");
{
  const runtimes = buildAllowedRuntimes([
    skill("slack-skill", "slack"),
    skill("gmail-skill", "gmail"),
    skill("no-runtime", undefined),
  ]);

  assert("includes slack", runtimes.includes("slack"));
  assert("includes gmail", runtimes.includes("gmail"));
  assert("exactly 2 runtimes (undefined filtered out)", runtimes.length === 2);
}

// ── 7. Runtimes are deduplicated ────────────────────────────────
console.log("7. Duplicate runtimes are deduplicated");
{
  const runtimes = buildAllowedRuntimes([
    skill("slack-1", "slack"),
    skill("slack-2", "slack"),
    skill("browser-1", "browser"),
  ]);

  assert("slack appears once", runtimes.filter((r) => r === "slack").length === 1);
  assert("total 2 unique runtimes", runtimes.length === 2);
}

// ── 8. Runtimes passed to outworked-skills URL ──────────────────
console.log("8. Runtimes are encoded in outworked-skills URL");
{
  const result = buildMcpServers({
    subDef: { description: "test" },
    agentId: "agent-8",
    allowedRuntimes: ["slack", "browser"],
    useTools: true,
  });
  const url = getOutworkedSkillsUrl(result);

  assert("URL contains runtimes param", url.includes("runtimes="));
  const runtimes = getRuntimesFromUrl(url);
  assert("runtimes has slack", runtimes.includes("slack"));
  assert("runtimes has browser", runtimes.includes("browser"));
}

// ── 9. Global skill exclusion removes runtimes ──────────────────
console.log("9. excludeGlobalSkills removes the excluded skill's runtime");
{
  const globalSkills = [
    skill("slack-skill", "slack"),
    skill("gmail-skill", "gmail"),
    skill("browser-skill", "browser"),
  ];
  const agentSkills = [
    skill("notion-skill", "notion"),
  ];

  // Exclude gmail globally for this agent
  const runtimes = resolveRuntimes({
    globalSkills,
    agentSkills,
    excludeGlobalSkills: ["gmail-skill"],
  });

  assert("has slack (not excluded)", runtimes.includes("slack"));
  assert("has browser (not excluded)", runtimes.includes("browser"));
  assert("has notion (agent-level)", runtimes.includes("notion"));
  assert("NO gmail (excluded)", !runtimes.includes("gmail"));
}

// ── 10. Excluding all globals leaves only agent skills ──────────
console.log("10. Excluding all global skills leaves only agent-level runtimes");
{
  const globalSkills = [
    skill("slack-skill", "slack"),
    skill("gmail-skill", "gmail"),
  ];
  const agentSkills = [
    skill("browser-skill", "browser"),
  ];

  const runtimes = resolveRuntimes({
    globalSkills,
    agentSkills,
    excludeGlobalSkills: ["slack-skill", "gmail-skill"],
  });

  assert("only browser remains", runtimes.length === 1 && runtimes[0] === "browser");
}

// ── 11. No exclusions → all runtimes available ──────────────────
console.log("11. No exclusions means all global + agent runtimes");
{
  const globalSkills = [
    skill("slack-skill", "slack"),
    skill("gmail-skill", "gmail"),
  ];
  const agentSkills = [
    skill("notion-skill", "notion"),
  ];

  const runtimes = resolveRuntimes({
    globalSkills,
    agentSkills,
    excludeGlobalSkills: [],
  });

  assert("all 3 runtimes present", runtimes.length === 3);
  assert("has slack", runtimes.includes("slack"));
  assert("has gmail", runtimes.includes("gmail"));
  assert("has notion", runtimes.includes("notion"));
}

// ── 12. End-to-end: agent with MCP + excluded global ────────────
console.log("12. Full pipeline: agent MCP servers + excluded global skill");
{
  const globalSkills = [
    skill("slack-skill", "slack"),
    skill("gmail-skill", "gmail"),
  ];
  const agentSkills = [skill("browser-skill", "browser")];
  const subDef = {
    description: "DevOps agent",
    mcpServers: [
      "github",
      { "linear": { type: "stdio", command: "npx", args: ["@mcp/linear"] } },
    ],
    excludeGlobalSkills: ["gmail-skill"],
  };

  // Step 1: resolve runtimes (as sendMessage does)
  const runtimes = resolveRuntimes({
    globalSkills,
    agentSkills,
    excludeGlobalSkills: subDef.excludeGlobalSkills,
  });

  // Step 2: build MCP servers (as invokeClaudeCode does)
  const servers = buildMcpServers({
    subDef,
    agentId: "devops-1",
    allowedRuntimes: runtimes,
    useTools: true,
  });

  // Verify MCP servers
  assert("has github", servers.includes("github"));
  assert("has linear", servers.some((s) => typeof s === "object" && "linear" in s));
  assert("has outworked-skills", servers.some((s) => typeof s === "object" && "outworked-skills" in s));
  assert("total 3 servers", servers.length === 3);

  // Verify runtimes in URL
  const url = getOutworkedSkillsUrl(servers);
  const urlRuntimes = getRuntimesFromUrl(url);
  assert("URL has slack runtime", urlRuntimes.includes("slack"));
  assert("URL has browser runtime", urlRuntimes.includes("browser"));
  assert("URL does NOT have gmail runtime", !urlRuntimes.includes("gmail"));
  assert("agentId is devops-1", getAgentIdFromUrl(url) === "devops-1");
}

// ── 13. Agent with no skills → empty runtimes param ─────────────
console.log("13. Agent with no skills gets empty runtimes");
{
  const runtimes = resolveRuntimes({
    globalSkills: [],
    agentSkills: [],
    excludeGlobalSkills: [],
  });
  assert("no runtimes", runtimes.length === 0);

  const servers = buildMcpServers({
    subDef: { description: "basic" },
    agentId: "basic-1",
    allowedRuntimes: runtimes,
    useTools: true,
  });
  const url = getOutworkedSkillsUrl(servers);
  assert("runtimes param is empty string", getRuntimesFromUrl(url).length === 0);
}

// ── 14. Multiple agents get different MCP configs ───────────────
console.log("14. Two agents get different MCP server sets");
{
  // Agent A: has github + slack
  const serversA = buildMcpServers({
    subDef: { description: "A", mcpServers: ["github"] },
    agentId: "a",
    allowedRuntimes: ["slack"],
    useTools: true,
  });

  // Agent B: has linear + gmail
  const serversB = buildMcpServers({
    subDef: { description: "B", mcpServers: [{ "linear": { type: "stdio", command: "npx", args: [] } }] },
    agentId: "b",
    allowedRuntimes: ["gmail"],
    useTools: true,
  });

  assert("A has github, B does not", serversA.includes("github") && !serversB.includes("github"));
  assert("B has linear, A does not",
    serversB.some((s) => typeof s === "object" && "linear" in s) &&
    !serversA.some((s) => typeof s === "object" && "linear" in s));

  const urlA = getOutworkedSkillsUrl(serversA);
  const urlB = getOutworkedSkillsUrl(serversB);
  assert("A runtimes = slack", getRuntimesFromUrl(urlA).join(",") === "slack");
  assert("B runtimes = gmail", getRuntimesFromUrl(urlB).join(",") === "gmail");
  assert("different agentIds", getAgentIdFromUrl(urlA) === "a" && getAgentIdFromUrl(urlB) === "b");
}

// ── Summary ─────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
