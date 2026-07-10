// PerNav — shared browser-tool definitions.
// Used by bridge.mjs (Claude Agent SDK + OpenAI-compatible loop) and by
// mcp-shim.mjs (the stdio MCP server that CLI agents like Codex connect to).
// `command` is what the bridge sends to the extension to execute.

import { z } from "zod";

export const TOOLS = [
  { name: "browser_snapshot", command: "snapshot", returns: "text",
    description: "Read the current page as a list of interactive elements with @eN refs. Only needed when you have NO current page state — every action tool already returns the updated state.",
    schema: {} },
  { name: "browser_read_page", command: "read_page", returns: "text",
    description: "Get the FULL visible text of the current page — the fastest way to read articles, prices, listings, emails or results. Prefer this over screenshots.",
    schema: { max_chars: z.number().optional().describe("max characters to return (default 15000)") } },
  { name: "browser_navigate", command: "navigate", returns: "text",
    description: "Navigate the current tab to a URL. Waits for the page to load and returns the new page state.",
    schema: { url: z.string().describe("Full URL, e.g. https://vercel.com/login") } },
  { name: "browser_click", command: "click", returns: "text",
    description: "Click the element with the given ref. Auto-waits for any resulting navigation and returns the updated page state.",
    schema: { ref: z.string().describe("An element ref like e3 from the latest page state") } },
  { name: "browser_type", command: "type", returns: "text",
    description: "Type text into the element with the given ref (replaces its current value). Set submit=true to press Enter after (e.g. to submit a search). Returns the updated page state.",
    schema: { ref: z.string(), text: z.string(), submit: z.boolean().optional() } },
  { name: "browser_select", command: "select", returns: "text",
    description: "Pick an option in a native <select> dropdown by its visible text or value (options are listed on the element in the page state). For custom dropdowns, click to open them instead. Returns the updated page state.",
    schema: { ref: z.string(), option: z.string().describe("visible text (or value) of the option to pick") } },
  { name: "browser_press", command: "press", returns: "text",
    description: "Press a key or combo at the current focus (e.g. Enter, Tab, Escape, Control+End). Returns the updated page state.",
    schema: { key: z.string() } },
  { name: "browser_scroll", command: "scroll", returns: "text",
    description: "Scroll the page or an inner pane (pass the ref of an element inside it). Returns the updated page state with newly visible elements.",
    schema: { direction: z.enum(["up", "down", "top", "bottom"]), pixels: z.number().optional(), ref: z.string().optional().describe("optional element ref to scroll within (for inner panes)") } },
  { name: "browser_get_text", command: "get_text", returns: "text",
    description: "Get the visible text of the element with the given ref.",
    schema: { ref: z.string() } },
  { name: "browser_wait", command: "wait", returns: "text",
    description: "Wait a number of milliseconds (rarely needed — actions already auto-wait for page loads).",
    schema: { ms: z.number() } },
  { name: "browser_screenshot", command: "screenshot", returns: "image",
    description: "Capture a screenshot of the tab (works even when the tab is in the background). Use only when visual layout/appearance matters — browser_read_page and action results are much faster for text.",
    schema: {} },
  { name: "browser_tabs", command: "tabs", returns: "text",
    description: "List all open tabs in the window, numbered, so you can work across multiple tabs.",
    schema: {} },
  { name: "browser_new_tab", command: "new_tab", returns: "text",
    description: "Open a URL in a NEW tab and move your control to it (without stealing the user's focus if they're working elsewhere). Returns the new page state.",
    schema: { url: z.string() } },
  { name: "browser_switch_tab", command: "switch_tab", returns: "text",
    description: "Move your control to an existing tab by its number from browser_tabs (e.g. to return to the login page after reading a code). Returns that tab's page state.",
    schema: { index: z.number().describe("1-based tab number from browser_tabs") } },
  { name: "browser_close_tab", command: "close_tab", returns: "text",
    description: "Close a tab by its number from browser_tabs.",
    schema: { index: z.number() } },
];

// Read-only filesystem tools for @-attached context dirs, as plain JSON Schema
// (the SDK path uses its built-in Read/Glob/Grep instead; the open loop and the
// MCP shim both expose these two).
export const FS_TOOL_DEFS = [
  { name: "fs_list", description: "List the files and subfolders of a directory inside an attached context directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "absolute path inside an attached context directory" } }, required: ["path"], additionalProperties: false } },
  { name: "fs_read", description: "Read a text file inside an attached context directory (up to 50 KB).",
    parameters: { type: "object", properties: { path: { type: "string", description: "absolute file path inside an attached context directory" } }, required: ["path"], additionalProperties: false } },
];

// JSON Schema for a browser tool's input (for OpenAI function-calling and MCP).
export function toolInputSchema(def) {
  const schema = z.toJSONSchema(z.object(def.schema));
  delete schema.$schema;
  return schema;
}
