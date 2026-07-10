// PerNav — MCP stdio shim.
// A tiny MCP server (newline-delimited JSON-RPC over stdio) that CLI agents
// (Codex CLI, Gemini CLI, Qwen Code, Copilot CLI, …) launch as an MCP server.
// Every tools/call is forwarded to the local bridge over WebSocket, which
// executes it in the browser extension and returns the result — so a CLI
// running on your ChatGPT/Google/GitHub account gets the same browser hands
// as the Claude Agent SDK path.
//
//   node mcp-shim.mjs --ws ws://127.0.0.1:8765 --token <session-token>
//
// The token routes this shim to the panel session that spawned the CLI.

import WebSocket from "ws";
import { TOOLS, FS_TOOL_DEFS, toolInputSchema } from "./tools.mjs";

function arg(name, envName) {
  const i = process.argv.indexOf(name);
  return (i >= 0 && process.argv[i + 1]) || process.env[envName] || "";
}
const WS_URL = arg("--ws", "PERNAV_WS") || "ws://127.0.0.1:8765";
const TOKEN = arg("--token", "PERNAV_TOKEN");

const MCP_TOOLS = [
  ...TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: toolInputSchema(t) })),
  ...FS_TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
];

// ---------- stdio JSON-RPC ----------
function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { out({ jsonrpc: "2.0", id, result }); }
function replyErr(id, code, message) { out({ jsonrpc: "2.0", id, error: { code, message } }); }

// ---------- bridge connection ----------
let ws = null;
let wsReady = null; // promise resolving when the bridge accepted our token
const pending = new Map();
let execSeq = 0;

function connectBridge() {
  wsReady = new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);
    ws.on("open", () => ws.send(JSON.stringify({ type: "shimHello", token: TOKEN })));
    ws.on("message", (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === "shimReady") resolve();
      else if (m.type === "shimDenied") reject(new Error("bridge rejected this shim session (stale token?)"));
      else if (m.type === "shimResult") {
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); p.resolve(m.result || {}); }
      }
    });
    ws.on("error", (e) => reject(new Error(`cannot reach the PerNav bridge at ${WS_URL}: ${e.message}`)));
    ws.on("close", () => {
      reject(new Error("bridge connection closed"));
      const err = { error: "bridge connection closed" };
      for (const p of pending.values()) p.resolve(err);
      pending.clear();
    });
  });
  wsReady.catch(() => {}); // avoid unhandled rejection before first await
  return wsReady;
}
connectBridge();

async function execOnBridge(name, args) {
  await wsReady;
  const id = String(++execSeq);
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ type: "shimExec", id, name, args }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ error: `tool call timed out: ${name}` }); }
    }, 60000);
  });
}

// ---------- MCP methods ----------
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    const v = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
    return reply(id, {
      protocolVersion: v,
      capabilities: { tools: {} },
      serverInfo: { name: "pernav-browser", version: "0.4.0" },
    });
  }
  if (method === "notifications/initialized" || (method || "").startsWith("notifications/")) return; // notification: no reply
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: MCP_TOOLS });
  if (method === "tools/call") {
    const name = params?.name;
    if (!MCP_TOOLS.some((t) => t.name === name)) return replyErr(id, -32602, `unknown tool ${name}`);
    let r;
    try { r = await execOnBridge(name, params?.arguments || {}); }
    catch (e) { r = { error: String(e?.message || e) }; }
    if (r.error) return reply(id, { content: [{ type: "text", text: `Error: ${r.error}` }], isError: true });
    if (r.data) return reply(id, { content: [{ type: "image", data: r.data, mimeType: r.mime || "image/png" }] });
    return reply(id, { content: [{ type: "text", text: r.text || "ok" }] });
  }
  if (id !== undefined) replyErr(id, -32601, `method not found: ${method}`);
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).replace(/\r$/, "").trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) replyErr(msg.id, -32603, String(e?.message || e)); });
  }
});
process.stdin.on("end", () => process.exit(0)); // the CLI shut us down
