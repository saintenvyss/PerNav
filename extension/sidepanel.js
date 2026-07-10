// PerNav — side panel
// UI + chat history + Settings + Control-browser toggle (auto-attach) + multi-tab
// CDP executor + on-page cursor/highlight/status overlay. Talks to the local
// bridge (which runs the agent on YOUR Claude subscription or API key) over WS.

const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:8765";
let bridgeUrl = DEFAULT_BRIDGE_URL;

let ws = null;
let attachedTabId = null;
let agentTabId = null;       // the tab the AGENT controls — independent of the user's active tab
let running = false;         // a task is in flight (agent keeps its tab even if the user switches away)
let pendingTurns = 0;        // turns sent but not yet ended — running stays true across queued messages
let refsMap = {};            // ref -> {x, y, label}
let lastSnapshot = null;     // last page-state text, to dedupe "unchanged" snapshots
let curAssistant = null;
let attachPromise = null;
let lastTabTitle = "";
let controlMode = true;

let chats = [];
let current = null;

const logEl = document.getElementById("log");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const tabInfoEl = document.getElementById("tabinfo");
const inputEl = document.getElementById("input");
const historyEl = document.getElementById("history");
const controlBtn = document.getElementById("control");
const chipsEl = document.getElementById("chips");
const atmenuEl = document.getElementById("atmenu");
let attachments = [];   // [{ name, path }] — chips currently in the input
let sessionDirs = [];   // [{ name, path }] — sticky context for this conversation
let atItems = [];
let atSel = 0;
let atReq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---------- storage ----------
function loadChats() { return new Promise((r) => chrome.storage.local.get(["chats"], (d) => r(d.chats || []))); }
function loadControl() { return new Promise((r) => chrome.storage.local.get(["controlMode"], (d) => r(d.controlMode !== false))); }
function loadBridgeUrl() { return new Promise((r) => chrome.storage.local.get(["bridgeUrl"], (d) => r(d.bridgeUrl || DEFAULT_BRIDGE_URL))); }
function persist() {
  if (current && current.messages.length) { const i = chats.findIndex((c) => c.id === current.id); if (i >= 0) chats[i] = current; else chats.unshift(current); }
  chrome.storage.local.set({ chats: chats.slice(0, 100) });
}
function record(role, text, dirs) {
  if (!current) current = { id: uid(), title: "", ts: Date.now(), messages: [] };
  if (role === "user" && !current.title) current.title = text.slice(0, 60);
  const m = { role, text }; if (dirs && dirs.length) m.dirs = dirs;
  current.messages.push(m); persist();
}

// ---------- UI ----------
const FOLDER_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
function scroll() { logEl.scrollTop = logEl.scrollHeight; }
function setEmpty(s) { emptyEl.style.display = s ? "flex" : "none"; }
function clearLog() { [...logEl.querySelectorAll(".msg")].forEach((n) => n.remove()); curAssistant = null; setEmpty(true); }
function bubble(cls, text) { setEmpty(false); const d = document.createElement("div"); d.className = "msg " + cls; if (text != null) d.textContent = text; logEl.appendChild(d); scroll(); return d; }
function userBubble(text, dirNames) {
  setEmpty(false);
  const d = document.createElement("div"); d.className = "msg user";
  if (dirNames && dirNames.length) {
    const row = document.createElement("div"); row.className = "msg-chips";
    dirNames.forEach((n) => { const c = document.createElement("span"); c.className = "mchip"; c.innerHTML = FOLDER_SVG; c.appendChild(document.createTextNode(n)); row.appendChild(c); });
    d.appendChild(row);
  }
  const tx = document.createElement("div"); tx.textContent = text; d.appendChild(tx);
  logEl.appendChild(d); scroll(); return d;
}
function appendAssistant(t) { if (!curAssistant) curAssistant = bubble("assistant", ""); curAssistant.textContent += t; scroll(); }
function finishAssistant() { if (curAssistant) { const t = curAssistant.textContent.trim(); if (t) record("assistant", t); else curAssistant.remove(); } curAssistant = null; }
function addTool(name, input) {
  finishAssistant();
  const short = String(name).replace(/^mcp__browser__/, "");
  let arg = ""; try { arg = JSON.stringify(input); } catch {}
  const d = bubble("tool", null); const b = document.createElement("b"); b.textContent = short; d.appendChild(b);
  if (arg && arg !== "{}") d.appendChild(document.createTextNode(" " + arg));
  record("tool", short + (arg && arg !== "{}" ? " " + arg : ""));
}
function addError(t) { finishAssistant(); bubble("error", t); record("error", t); }
function addImage(u) { const d = bubble("tool", "screenshot"); const img = document.createElement("img"); img.src = u; d.appendChild(img); scroll(); }
function renderStored(m) {
  if (m.role === "assistant") bubble("assistant", m.text);
  else if (m.role === "user") userBubble(m.text, m.dirs);
  else if (m.role === "error") bubble("error", m.text);
  else { const d = bubble("tool", null); const b = document.createElement("b"); b.textContent = m.text.split(" ")[0]; d.appendChild(b); const rest = m.text.slice(b.textContent.length); if (rest) d.appendChild(document.createTextNode(rest)); }
}
function setStatus(on) { statusEl.className = "dot " + (on ? "on" : "off"); statusEl.title = on ? "bridge: online" : "bridge: offline"; }
function setTab(tab) { lastTabTitle = tab ? (tab.title || tab.url) : ""; updateControlStatus(); }
function updateControlStatus() {
  if (!controlMode) { tabInfoEl.textContent = "Browser control off"; return; }
  if (attachedTabId == null) { tabInfoEl.textContent = "Browser control on · open a page to attach"; return; }
  tabInfoEl.textContent = (running ? "Working on: " : "Controlling: ") + (lastTabTitle || "current tab") + (running ? " (continues in background)" : "");
}
function turnStarted() {
  pendingTurns++; running = true;
  inputEl.placeholder = "Enter to queue · Esc to interrupt and send now";
  updateControlStatus();
}
function turnEnded() {
  pendingTurns = Math.max(0, pendingTurns - 1); running = pendingTurns > 0;
  if (!running) inputEl.placeholder = "Describe a task…";
  updateControlStatus();
}

// ---------- control toggle + auto-attach ----------
function setControl(on) {
  controlMode = on; chrome.storage.local.set({ controlMode: on });
  controlBtn.classList.toggle("on", on);
  controlBtn.title = on ? "Browser control on (click to stop)" : "Browser control off (click to let PerNav act on the page)";
  if (on) autoAttach(); else { agentTabId = null; detach().catch(() => {}); }
  updateControlStatus();
}
// While IDLE, follow the tab the user is looking at (so a new task targets it).
// While RUNNING, the agent keeps its own tab — it works even in the background.
async function autoAttach() { if (!controlMode || running) return; agentTabId = null; try { await attach(); } catch { setTab(null); } }
chrome.tabs.onActivated.addListener(() => { if (controlMode && !running) autoAttach(); });
chrome.windows.onFocusChanged.addListener((w) => { if (controlMode && !running && w !== chrome.windows.WINDOW_ID_NONE) autoAttach(); });

// ---------- history menu ----------
function rel(ts) { const s = (Date.now() - ts) / 1000; if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
function toggleHistory() {
  if (!historyEl.classList.contains("hidden")) { historyEl.classList.add("hidden"); return; }
  historyEl.innerHTML = "";
  const nc = document.createElement("div"); nc.className = "h-item h-new"; nc.innerHTML = '<div class="t">+ New chat</div>';
  nc.onclick = () => { newChat(); historyEl.classList.add("hidden"); }; historyEl.appendChild(nc);
  historyEl.appendChild(Object.assign(document.createElement("div"), { className: "h-foot" }));
  if (!chats.length) { const e = document.createElement("div"); e.className = "h-empty"; e.textContent = "No past chats yet"; historyEl.appendChild(e); }
  else {
    chats.forEach((c) => {
      const it = document.createElement("div"); it.className = "h-item";
      const t = document.createElement("div"); t.className = "t"; t.textContent = c.title || "(untitled)";
      const d = document.createElement("div"); d.className = "d"; d.textContent = rel(c.ts);
      it.appendChild(t); it.appendChild(d); it.onclick = () => { loadChat(c.id); historyEl.classList.add("hidden"); }; historyEl.appendChild(it);
    });
    const foot = document.createElement("div"); foot.className = "h-foot";
    const clr = document.createElement("div"); clr.className = "h-clear"; clr.textContent = "Clear all chats";
    clr.onclick = () => { chats = []; chrome.storage.local.set({ chats }); historyEl.classList.add("hidden"); }; foot.appendChild(clr); historyEl.appendChild(foot);
  }
  historyEl.classList.remove("hidden");
}
function resetRunState() { pendingTurns = 0; running = false; agentTabId = null; lastSnapshot = null; inputEl.placeholder = "Describe a task…"; updateControlStatus(); }
function newChat() { finishAssistant(); persist(); current = { id: uid(), title: "", ts: Date.now(), messages: [] }; attachments = []; sessionDirs = []; renderChips(); clearLog(); resetRunState(); sendWS({ type: "reset" }); }
function loadChat(id) { const c = chats.find((x) => x.id === id); if (!c) return; finishAssistant(); persist(); current = c; attachments = []; sessionDirs = []; renderChips(); clearLog(); c.messages.forEach(renderStored); setEmpty(c.messages.length === 0); resetRunState(); sendWS({ type: "reset" }); }

// ---------- @ directory attachments ----------
function renderChips() {
  chipsEl.innerHTML = "";
  if (!attachments.length) { chipsEl.classList.add("hidden"); return; }
  chipsEl.classList.remove("hidden");
  attachments.forEach((a, idx) => {
    const c = document.createElement("div"); c.className = "chip";
    const ic = document.createElement("span"); ic.className = "ic"; ic.innerHTML = FOLDER_SVG; c.appendChild(ic);
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = a.name; nm.title = a.path; c.appendChild(nm);
    const rm = document.createElement("button"); rm.className = "rm"; rm.textContent = "×"; rm.title = "Remove"; rm.onclick = () => { attachments.splice(idx, 1); renderChips(); }; c.appendChild(rm);
    chipsEl.appendChild(c);
  });
}
function addAttachment(name, path) { if (!attachments.some((a) => a.path === path)) { attachments.push({ name, path }); renderChips(); } }
function atContext() {
  const pos = inputEl.selectionStart; const before = inputEl.value.slice(0, pos);
  const at = before.lastIndexOf("@"); if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1); if (query.includes("\n")) return null;
  return { at, pos, query };
}
function closeAt() { atmenuEl.classList.add("hidden"); atItems = []; atSel = 0; }
function handleAt() { const ctx = atContext(); if (!ctx) { closeAt(); return; } const reqId = ++atReq; sendWS({ type: "listDirs", q: ctx.query, reqId }); }
function renderAt(items) {
  atItems = items; atSel = 0; atmenuEl.innerHTML = "";
  if (!items.length) { const e = document.createElement("div"); e.className = "at-empty"; e.textContent = "No matching folders"; atmenuEl.appendChild(e); atmenuEl.classList.remove("hidden"); return; }
  items.forEach((it, i) => {
    const d = document.createElement("div"); d.className = "at-item" + (i === 0 ? " sel" : "");
    const ic = document.createElement("span"); ic.className = "ic"; ic.innerHTML = FOLDER_SVG; d.appendChild(ic);
    const wrap = document.createElement("div"); wrap.style.minWidth = "0";
    const t = document.createElement("div"); t.className = "t"; t.textContent = it.name;
    const p = document.createElement("div"); p.className = "p"; p.textContent = it.path;
    wrap.appendChild(t); wrap.appendChild(p); d.appendChild(wrap);
    d.onmousedown = (e) => { e.preventDefault(); pickAt(i); };
    atmenuEl.appendChild(d);
  });
  atmenuEl.classList.remove("hidden");
}
function moveSel(delta) { if (!atItems.length) return; atSel = (atSel + delta + atItems.length) % atItems.length; [...atmenuEl.querySelectorAll(".at-item")].forEach((n, i) => n.classList.toggle("sel", i === atSel)); }
function pickAt(i) {
  const it = atItems[i]; if (!it) return;
  const ctx = atContext(); if (ctx) inputEl.value = inputEl.value.slice(0, ctx.at) + inputEl.value.slice(ctx.pos);
  addAttachment(it.name, it.path); closeAt(); inputEl.focus(); autosize();
}

// ---------- WebSocket ----------
function sendWS(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }
function connect() {
  ws = new WebSocket(bridgeUrl);
  ws.onopen = () => { setStatus(true); if (settingsOpen) refreshSettings(); };
  ws.onclose = () => { setStatus(false); if (settingsOpen) refreshSettings(); setTimeout(connect, 1500); };
  ws.onerror = () => {};
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "exec") { let r; try { r = await runCommand(m.command, m.args || {}); } catch (e) { r = { error: e.message || String(e) }; } sendWS({ type: "toolResult", id: m.id, result: r }); }
    else if (m.type === "assistantDelta") appendAssistant(m.text);
    else if (m.type === "toolCall") addTool(m.name, m.input);
    else if (m.type === "turnEnd") { finishAssistant(); turnEnded(); }
    else if (m.type === "error") { addError(m.text); pendingTurns = 0; running = false; inputEl.placeholder = "Describe a task…"; updateControlStatus(); }
    else if (m.type === "dirSuggestions") { if (m.reqId === atReq) renderAt(m.items || []); }
    else if (m.type === "settings") { if (m.reqId === settingsReq) { renderSettings(m.settings); requestModels(); } }
    else if (m.type === "settingsSaved") { renderSettings(m.settings); setSetMsg(m.ok ? "Saved ✓" : (m.error || "Could not save"), !m.ok); if (m.ok) requestModels(); }
    else if (m.type === "models") handleModels(m);
  };
}

// ---------- settings ----------
// Provider, auth + model live in the BRIDGE's config file (the agent runs
// there); the panel only ever sees masked values. The bridge URL is the one
// purely-local setting. Model lists come from the bridge: a curated shortlist
// instantly, the provider's full live /models list on request.
let settingsOpen = false;
let settingsReq = 0;          // matches getSettings replies to the latest request
let lastSettings = null;      // last masked snapshot from the bridge
let uiProvider = "anthropic"; // provider shown in the form (saved on Save)
let modelsReq = 0;            // matches listModels replies to the latest request
const modelCache = {};        // providerId -> fetched model list (this session)
const setOfflineEl = document.getElementById("setOffline");
const authDotEl = document.getElementById("authDot");
const authTextEl = document.getElementById("authText");
const anthAuthEl = document.getElementById("anthAuth");
const provAuthEl = document.getElementById("provAuth");
const cliAuthEl = document.getElementById("cliAuth");
const cliNoteEl = document.getElementById("cliNote");
const cliSetupEl = document.getElementById("cliSetup");
const cliPathInputEl = document.getElementById("cliPathInput");
const provKeyInputEl = document.getElementById("provKeyInput");
const provKeyHintEl = document.getElementById("provKeyHint");
const provBaseInputEl = document.getElementById("provBaseInput");
const provBaseHintEl = document.getElementById("provBaseHint");
const providerSelectEl = document.getElementById("providerSelect");
const tokenInputEl = document.getElementById("tokenInput");
const keyInputEl = document.getElementById("keyInput");
const modelSelectEl = document.getElementById("modelSelect");
const modelCustomEl = document.getElementById("modelCustom");
const modelHintEl = document.getElementById("modelHint");
const bridgeInputEl = document.getElementById("bridgeInput");
const setMsgEl = document.getElementById("setMsg");
const setAboutEl = document.getElementById("setAbout");

function setSetMsg(text, isErr) {
  setMsgEl.textContent = text || "";
  setMsgEl.classList.toggle("err", !!isErr);
  if (text) { clearTimeout(setSetMsg.t); setSetMsg.t = setTimeout(() => { setMsgEl.textContent = ""; }, 4000); }
}
function toggleSettings(open) {
  settingsOpen = open == null ? !settingsOpen : open;
  document.body.classList.toggle("settings-open", settingsOpen);
  if (settingsOpen) { historyEl.classList.add("hidden"); setSetMsg(""); refreshSettings(); }
}
function bridgeOnline() { return !!ws && ws.readyState === WebSocket.OPEN; }
function refreshSettings() {
  if (document.activeElement !== bridgeInputEl) bridgeInputEl.value = bridgeUrl;
  setOfflineEl.classList.toggle("hidden", bridgeOnline());
  renderAuthStatus();
  if (bridgeOnline()) sendWS({ type: "getSettings", reqId: ++settingsReq });
}
function provInfo(id) { return lastSettings && lastSettings.providers && lastSettings.providers.find((p) => p.id === id); }
function currentUiModel() {
  if (!modelSelectEl.options.length) return "";
  return modelSelectEl.value === "__custom" ? modelCustomEl.value.trim() : modelSelectEl.value;
}
// Rebuild the model dropdown for the provider being viewed: fetched live list
// if we have one, otherwise the curated shortlist; the saved model and a
// "Custom model id…" entry are always present.
function renderModelOptions(preserveSelection) {
  const p = provInfo(uiProvider); if (!p) return;
  const isCli = p.engine === "cli";
  const models = modelCache[uiProvider] || p.models || [];
  const want = (preserveSelection && currentUiModel()) || p.model || p.defaultModel || "";
  modelSelectEl.innerHTML = "";
  const ids = new Set();
  if (isCli) {
    // CLI providers can simply run whatever the CLI itself is configured with
    const o = document.createElement("option"); o.value = ""; o.textContent = "CLI default (what the CLI is configured to use)";
    modelSelectEl.appendChild(o); ids.add("");
  }
  for (const m of models) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    const o = document.createElement("option"); o.value = m.id; o.textContent = m.label || m.id;
    modelSelectEl.appendChild(o);
  }
  if (want && !ids.has(want)) {
    const o = document.createElement("option"); o.value = want; o.textContent = want;
    modelSelectEl.insertBefore(o, modelSelectEl.firstChild);
    ids.add(want);
  }
  const oc = document.createElement("option"); oc.value = "__custom"; oc.textContent = "Custom model id…";
  modelSelectEl.appendChild(oc);
  if (want || isCli) { modelSelectEl.value = want; modelCustomEl.classList.add("hidden"); }
  else { modelSelectEl.value = "__custom"; modelCustomEl.value = ""; modelCustomEl.classList.remove("hidden"); }
}
function defaultModelHint() {
  const p = provInfo(uiProvider); if (!p) return "";
  if (p.engine === "cli") {
    if (modelCache[uiProvider]) return `${modelCache[uiProvider].length} models from the CLI. “CLI default” is always safe.`;
    return uiProvider === "codex"
      ? "“CLI default” uses your Codex config. “Refresh list” reads the models your ChatGPT login can use."
      : "“CLI default” uses the CLI's own configured model; the shortlist and Custom work too.";
  }
  if (modelCache[uiProvider]) return `${modelCache[uiProvider].length} models, live from the provider`;
  if (p.needsKey && !p.hasKey) return "Built-in shortlist. Save an API key, then “refresh list” to load every model.";
  return "Built-in shortlist. “Refresh list” loads every model from the provider.";
}
function requestModels() {
  if (!bridgeOnline() || !provInfo(uiProvider)) return;
  modelHintEl.textContent = "Loading model list…";
  sendWS({ type: "listModels", provider: uiProvider, reqId: ++modelsReq });
}
function handleModels(m) {
  if (m.reqId !== modelsReq) return;
  if (m.models && m.models.length) modelCache[m.provider] = m.models;
  if (m.provider !== uiProvider) return;
  renderModelOptions(true);
  if (m.live) modelHintEl.textContent = `${m.models.length} models, full live list from the provider`;
  else if (m.error) modelHintEl.textContent = `Couldn't fetch the live list (${m.error.slice(0, 120)}). Showing the built-in shortlist; any model id works via “Custom”.`;
  else modelHintEl.textContent = defaultModelHint();
}
// Show the right account block for the viewed provider: Anthropic auth methods,
// CLI install/login status, or API key + endpoint fields.
function renderProviderUI() {
  const p = provInfo(uiProvider); if (!p) return;
  const isCli = p.engine === "cli";
  anthAuthEl.classList.toggle("hidden", uiProvider !== "anthropic");
  cliAuthEl.classList.toggle("hidden", !isCli);
  provAuthEl.classList.toggle("hidden", uiProvider === "anthropic" || isCli);
  if (isCli) {
    cliNoteEl.textContent = p.authNote || "";
    const c = p.cli || {};
    cliSetupEl.textContent = c.found
      ? `CLI found: ${c.path}` + (c.loggedIn === false ? `. Not logged in yet: run  ${c.loginCmd}` : "")
      : `Not installed yet. Install:  ${c.installCmd || ""}   then log in:  ${c.loginCmd || ""}`;
    if (document.activeElement !== cliPathInputEl) cliPathInputEl.value = p.cliPath || "";
  } else if (uiProvider !== "anthropic") {
    provKeyInputEl.placeholder = p.hasKey ? `saved: ${p.keyMasked} (paste to replace)` : (p.needsKey ? "API key…" : "API key (optional)…");
    provKeyHintEl.textContent = p.keyUrl ? `Get a key at ${p.keyUrl}. Stored only in the bridge's config file on this machine.` : "";
    provKeyHintEl.classList.toggle("hidden", !p.keyUrl);
    if (document.activeElement !== provBaseInputEl) provBaseInputEl.value = p.baseUrl || "";
    provBaseHintEl.textContent = "Endpoint (OpenAI-compatible base URL). " + (p.baseNote || "Change only for proxies, regional endpoints, or local servers.");
  }
  renderModelOptions(false);
  modelHintEl.textContent = defaultModelHint();
  renderAuthStatus();
}
function renderSettings(s) {
  if (!s) return;
  lastSettings = s;
  uiProvider = s.provider;
  providerSelectEl.innerHTML = "";
  const groups = new Map(); // group label -> <optgroup>, in bridge order
  (s.providers || []).forEach((p) => {
    let parent = providerSelectEl;
    if (p.group) {
      if (!groups.has(p.group)) {
        const g = document.createElement("optgroup"); g.label = p.group;
        providerSelectEl.appendChild(g); groups.set(p.group, g);
      }
      parent = groups.get(p.group);
    }
    const o = document.createElement("option"); o.value = p.id; o.textContent = p.label;
    parent.appendChild(o);
  });
  providerSelectEl.value = uiProvider;
  document.querySelectorAll('input[name="auth"]').forEach((r) => { r.checked = r.value === s.authMethod; });
  tokenInputEl.value = "";
  tokenInputEl.placeholder = s.hasOauthToken ? `saved: ${s.oauthTokenMasked} (paste to replace)` : "sk-ant-oat01-…";
  keyInputEl.value = "";
  keyInputEl.placeholder = s.hasApiKey ? `saved: ${s.apiKeyMasked} (paste to replace)` : "sk-ant-api03-…";
  provKeyInputEl.value = "";
  setAboutEl.textContent = `PerNav bridge v${s.version}, port ${s.port}`;
  renderProviderUI();
}
function renderAuthStatus() {
  let ok = false, text;
  const s = lastSettings;
  const p = provInfo(uiProvider);
  if (!bridgeOnline()) text = "Bridge offline; account can't be checked.";
  else if (!s || !p) text = "Checking…";
  else if (p.engine === "cli") {
    const c = p.cli || {};
    if (!c.found) text = `${c.name || "CLI"} not installed. Run:  ${c.installCmd || ""}`;
    else if (c.loggedIn === false) text = `CLI installed, not logged in. Run:  ${c.loginCmd || ""}`;
    else if (c.loggedIn == null) { ok = true; text = `CLI installed; login can't be auto-checked (run ${c.loginCmd} if tasks fail)`; }
    else { ok = true; text = `Connected: ${c.loginDetail || "logged in"} via the ${c.name} CLI`; }
  }
  else if (uiProvider !== "anthropic") {
    if (p.hasKey) { ok = true; text = `Connected: API key ${p.keyMasked}`; }
    else if (!p.needsKey) {
      if (uiProvider === "ollama") { ok = true; text = "Local endpoint; no API key needed (make sure Ollama is running)."; }
      else { ok = !!p.baseUrl; text = p.baseUrl ? `Custom endpoint: ${p.baseUrl}` : "Set an endpoint URL below."; }
    }
    else text = "No API key saved yet. Paste one below.";
  } else if (s.authMethod === "claude-login") {
    if (s.claudeLogin && s.claudeLogin.present) { ok = true; text = "Connected: Claude Code login" + (s.claudeLogin.subscriptionType ? ` (${s.claudeLogin.subscriptionType} plan)` : ""); }
    else text = "Not connected. Run `claude` in a terminal, then /login.";
  } else if (s.authMethod === "token") {
    if (s.hasOauthToken) { ok = true; text = `Connected: subscription token ${s.oauthTokenMasked}`; }
    else text = "No token saved yet. Run `claude setup-token` and paste it below.";
  } else {
    if (s.hasApiKey) { ok = true; text = `Connected: API key ${s.apiKeyMasked} (pay-as-you-go)`; }
    else text = "No API key saved yet.";
  }
  authDotEl.className = "dot " + (ok ? "on" : "off");
  authTextEl.textContent = text;
}
function normalizeBridgeUrl(v) {
  v = String(v || "").trim();
  if (!v) return DEFAULT_BRIDGE_URL;
  if (!/^wss?:\/\//.test(v)) v = "ws://" + v;
  return v.replace(/\/+$/, "");
}
function saveSettings() {
  const url = normalizeBridgeUrl(bridgeInputEl.value);
  const urlChanged = url !== bridgeUrl;
  if (urlChanged) {
    bridgeUrl = url; chrome.storage.local.set({ bridgeUrl });
    try { ws.close(); } catch {}          // onclose reconnects to the new address
  }
  if (!bridgeOnline()) { setSetMsg(urlChanged ? "Bridge address saved, reconnecting…" : "Bridge offline; only the address can be saved.", !urlChanged); return; }
  const p = provInfo(uiProvider);
  const payload = { provider: uiProvider, model: currentUiModel() };
  if (uiProvider === "anthropic") {
    payload.authMethod = (document.querySelector('input[name="auth"]:checked') || {}).value || "claude-login";
    if (tokenInputEl.value.trim()) payload.oauthToken = tokenInputEl.value.trim();
    if (keyInputEl.value.trim()) payload.apiKey = keyInputEl.value.trim();
  } else if (p && p.engine === "cli") {
    payload.cliPath = cliPathInputEl.value.trim();
  } else {
    if (provKeyInputEl.value.trim()) payload.providerKey = provKeyInputEl.value.trim();
    payload.baseUrl = provBaseInputEl.value.trim();
  }
  setSetMsg("Saving…");
  sendWS({ type: "saveSettings", reqId: ++settingsReq, settings: payload });
}
document.getElementById("gear").addEventListener("click", () => toggleSettings());
document.getElementById("settingsSave").addEventListener("click", saveSettings);
document.getElementById("modelRefresh").addEventListener("click", requestModels);
providerSelectEl.addEventListener("change", () => {
  uiProvider = providerSelectEl.value;
  provKeyInputEl.value = "";
  renderProviderUI();
  requestModels();
});
modelSelectEl.addEventListener("change", () => {
  modelCustomEl.classList.toggle("hidden", modelSelectEl.value !== "__custom");
  if (modelSelectEl.value === "__custom") modelCustomEl.focus();
});
document.getElementById("clearChats").addEventListener("click", () => {
  chats = []; chrome.storage.local.set({ chats }); newChat(); setSetMsg("Chats cleared ✓");
});

// ---------- chrome.debugger (CDP) ----------
function rawAttach(id) { return new Promise((res, rej) => chrome.debugger.attach({ tabId: id }, "1.3", () => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res())); }
function rawDetach(id) { return new Promise((res) => chrome.debugger.detach({ tabId: id }, () => res())); }
async function detach() { if (attachedTabId == null) return; const id = attachedTabId; attachedTabId = null; await rawDetach(id); setTab(null); }
// This page may be docked to a browser window (side panel) or floating in its own
// popup window (fallback for browsers without the Side Panel API), so "the user's
// tab" must come from the last-focused *normal* window — never from our own window.
// Focus is tracked live because getLastFocused({windowTypes}) filtering is
// deprecated and inconsistent across Chromium versions.
let lastNormalWinId = null;
chrome.windows.onFocusChanged.addListener(async (w) => {
  if (w === chrome.windows.WINDOW_ID_NONE) return;
  try { const win = await chrome.windows.get(w); if (win.type === "normal") lastNormalWinId = w; } catch {}
});
async function lastNormalWindowId() {
  if (lastNormalWinId != null) {
    try { const w = await chrome.windows.get(lastNormalWinId); if (w.type === "normal") return w.id; } catch {}
    lastNormalWinId = null;
  }
  try { const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); if (w && w.type === "normal") return w.id; } catch {}
  try { const all = await chrome.windows.getAll({ windowTypes: ["normal"] }); const w = all.find((x) => x.focused) || all[0]; if (w) return w.id; } catch {}
  return null;
}
async function agentWindowId() {
  if (agentTabId != null) { try { return (await chrome.tabs.get(agentTabId)).windowId; } catch {} }
  return lastNormalWindowId();
}
async function queryActiveTab() {
  const winId = await lastNormalWindowId();
  if (winId != null) { const [t] = await chrome.tabs.query({ active: true, windowId: winId }); if (t) return t; }
  let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
// Is the user currently looking at the agent's tab? (decides whether tab switches steal focus)
async function userWatching() { try { const t = await queryActiveTab(); return !!t && t.id === agentTabId; } catch { return false; } }
async function attach() {
  // already attached to the agent's tab — nothing to do
  if (attachedTabId != null && attachedTabId === agentTabId) {
    try { return await chrome.tabs.get(attachedTabId); } catch { attachedTabId = null; agentTabId = null; }
  }
  if (attachPromise) return attachPromise;
  attachPromise = (async () => {
    let tab = null;
    if (agentTabId != null) { try { tab = await chrome.tabs.get(agentTabId); } catch { agentTabId = null; } }
    if (!tab) { tab = await queryActiveTab(); if (tab) agentTabId = tab.id; }
    if (!tab) throw new Error("No tab to control.");
    if (!/^https?:|^file:/.test(tab.url || "")) throw new Error("This page can't be controlled (browser/internal page).");
    if (attachedTabId != null && attachedTabId !== tab.id) { try { await detach(); } catch {} }
    try { await rawAttach(tab.id); }
    catch (e) {
      if (/already attached/i.test(e.message)) { await rawDetach(tab.id); await sleep(200); try { await rawAttach(tab.id); } catch { throw new Error("Tab is held by another debugger. Close DevTools on this tab."); } }
      else throw e;
    }
    attachedTabId = tab.id; await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("DOM.enable");
    // make the page think it's focused so it keeps working while backgrounded
    try { await cdp("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}
    setTab(tab); return tab;
  })();
  try { return await attachPromise; } finally { attachPromise = null; }
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId === attachedTabId) { attachedTabId = null; refsMap = {}; setTab(null); if (controlMode) setTimeout(() => { attach().catch(() => {}); }, 400); } });
function cdp(method, params = {}) { return new Promise((res, rej) => chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params, (r) => chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r))); }
async function evaluate(expression) { const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error"); return r.result ? r.result.value : undefined; }
function waitTabComplete(id, ms) { return new Promise((resolve) => { const t0 = Date.now(); const iv = setInterval(async () => { let t; try { t = await chrome.tabs.get(id); } catch { clearInterval(iv); return resolve(); } if (t.status === "complete" || Date.now() - t0 > ms) { clearInterval(iv); resolve(); } }, 100); }); }
// After an action: if it kicked off a navigation, wait for the load instead of a blind sleep.
async function settle() {
  await sleep(120);
  try {
    const t = await chrome.tabs.get(attachedTabId);
    if (t.status === "loading") { await waitTabComplete(attachedTabId, 10000); await sleep(150); }
  } catch {}
}
// Take a snapshot, refresh the refs map, and return page-state text for the action result.
// Identical consecutive snapshots collapse to a one-liner to save tokens.
let lastStateTs = 0;   // when the agent last observed the page (browser_wait subtracts this)
async function pageState() {
  try {
    const data = await evaluate(SNAPSHOT_JS);
    refsMap = {};
    for (const r of (data.refs || [])) refsMap[r.ref] = { x: r.x, y: r.y, label: r.label };
    lastStateTs = Date.now();
    if (data.text === lastSnapshot) return "(page unchanged — existing refs still valid)";
    lastSnapshot = data.text;
    return "Current page state:\n" + data.text;
  } catch {
    return "(page state unavailable — call browser_snapshot)";
  }
}
async function afterAction(note) { await settle(); return { text: note + "\n\n" + (await pageState()) }; }

// ---------- on-page overlay: cursor + highlight + status pill ----------
function overlayExpr(x, y, label) {
  return `(function(){
    function mk(id,css){var e=document.getElementById(id);if(!e){e=document.createElement('div');e.id=id;e.style.cssText=css;(document.body||document.documentElement).appendChild(e);}return e;}
    var c=mk('__sk_cursor','position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(125,156,196,.28);border:2px solid #7d9cc4;pointer-events:none;transition:left .25s ease,top .25s ease;box-shadow:0 1px 4px rgba(0,0,0,.35)');
    var r=mk('__sk_ring','position:fixed;z-index:2147483646;border:2px solid #7d9cc4;border-radius:6px;pointer-events:none;transition:all .18s ease;opacity:0');
    var t=mk('__sk_tip','position:fixed;z-index:2147483647;background:#141519;color:#d6d8dc;font:12px/1.4 system-ui;padding:3px 7px;border-radius:5px;pointer-events:none;border:1px solid #3a3e45');
    c.style.left=${x}+'px';c.style.top=${y}+'px';
    t.textContent=${JSON.stringify(label)};t.style.left=(${x}+14)+'px';t.style.top=(${y}+12)+'px';
    var el=document.elementFromPoint(${x},${y});
    if(el){var b=el.getBoundingClientRect();r.style.left=b.left+'px';r.style.top=b.top+'px';r.style.width=b.width+'px';r.style.height=b.height+'px';r.style.opacity='1';setTimeout(function(){r.style.opacity='0';},800);}
  })()`;
}
function announceExpr(text) {
  return `(function(){
    var h=document.getElementById('__sk_hud');
    if(!h){h=document.createElement('div');h.id='__sk_hud';h.style.cssText='position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(16,17,19,.95);color:#d6d8dc;font:13px/1.4 system-ui;padding:7px 12px;border-radius:8px;border:1px solid #3a3e45;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;display:flex;align-items:center;gap:9px;max-width:78vw;transition:opacity .2s';(document.body||document.documentElement).appendChild(h);}
    h.innerHTML='<span style="width:7px;height:7px;border-radius:50%;background:#7d9cc4;flex:0 0 auto"></span>';
    var s=document.createElement('span');s.textContent=${JSON.stringify(text)};s.style.cssText='white-space:nowrap;overflow:hidden;text-overflow:ellipsis';h.appendChild(s);
    h.style.opacity='1';clearTimeout(window.__sk_hud_t);window.__sk_hud_t=setTimeout(function(){h.style.opacity='0';},3500);
  })()`;
}
async function overlay(x, y, label) { try { await evaluate(overlayExpr(x, y, label)); } catch {} }
async function announce(text) { try { await evaluate(announceExpr(text)); } catch {} }

// Snapshot v2 (techniques adapted from browser-use / alibaba page-agent):
// walks the DOM in document order — shadow roots and same-origin iframes included —
// interleaving visible text with interactive elements, drops occluded elements via
// elementFromPoint hit-tests (we click by coordinates, so occluded = wrong click),
// marks elements new since the last snapshot with *, and flags scrollable panes.
// Element handles live in window.__sk_refs (direct refs — no DOM mutation).
const SNAPSHOT_JS = `(function(){
  var MAX_ELS=250, TEXT_BUDGET=3500;
  var first=!window.__sk_seen, seen=window.__sk_seen||(window.__sk_seen=new WeakSet());
  var vw=innerWidth, vh=innerHeight, out=[], refs=[], n=0, tb=TEXT_BUDGET;
  var refEls=window.__sk_refs={};
  var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,HEAD:1,META:1,LINK:1,TITLE:1,SVG:1,PATH:1,BR:1};
  var ITAG={A:1,BUTTON:1,INPUT:1,SELECT:1,TEXTAREA:1,SUMMARY:1,LABEL:1};
  var IROLE={button:1,link:1,tab:1,checkbox:1,radio:1,'switch':1,menuitem:1,menuitemcheckbox:1,menuitemradio:1,option:1,combobox:1,slider:1,searchbox:1,textbox:1,listbox:1,treeitem:1};
  function scrollInfo(el,st){
    if(!/(auto|scroll|overlay)/.test(st.overflowY))return null;
    var up=Math.round(el.scrollTop), down=Math.round(el.scrollHeight-el.clientHeight-el.scrollTop);
    return (up>20||down>20)?{up:up,down:down}:null;
  }
  function isInteractive(el,st,hot){
    if(ITAG[el.tagName]) return !el.disabled;
    if(el.isContentEditable){var pp=el.parentElement;if(!pp||!pp.isContentEditable)return true;}
    var role=el.getAttribute('role');
    if(role&&IROLE[role]) return true;
    if(hot) return false; // inside an indexed element only real controls/roles count
    if(el.hasAttribute('onclick')) return true;
    var ti=el.getAttribute('tabindex'); if(ti!=null&&+ti>=0) return true;
    if(st.cursor==='pointer'){var pe=el.parentElement;var ps=pe&&getComputedStyle(pe);if(!ps||ps.cursor!=='pointer')return true;}
    return false;
  }
  function nameOf(el){
    var noVal=el.type==='checkbox'||el.type==='radio'||el.type==='password';
    var s=el.getAttribute('aria-label')||(!noVal&&'value' in el&&typeof el.value==='string'&&el.value?el.value:'')
      ||el.getAttribute('placeholder')||el.innerText||(el.labels&&el.labels[0]&&el.labels[0].innerText)
      ||el.getAttribute('title')||el.getAttribute('alt')||'';
    return String(s).replace(/\\s+/g,' ').trim().slice(0,80);
  }
  // occluded elements are unclickable at their point — probe center then two corners,
  // and keep the first point that actually hits the element (that's where we click)
  function visibleAt(doc,el,r){
    var dx=Math.min(8,r.width/3), dy=Math.min(8,r.height/3);
    var pts=[[r.left+r.width/2,r.top+r.height/2],[r.left+dx,r.top+dy],[r.right-dx,r.bottom-dy]];
    for(var i=0;i<pts.length;i++){
      var h;try{h=doc.elementFromPoint(pts[i][0],pts[i][1]);}catch(e){h=null;}
      while(h&&h.shadowRoot){var inner=h.shadowRoot.elementFromPoint(pts[i][0],pts[i][1]);if(!inner||inner===h)break;h=inner;}
      if(h&&(h===el||el.contains(h)||h.contains(el)))return pts[i];
    }
    return null;
  }
  function pushText(t){
    if(tb<=0)return; t=String(t).replace(/\\s+/g,' ').trim(); if(t.length<2)return;
    if(t.length>tb)t=t.slice(0,tb)+'…'; tb-=t.length;
    var last=out[out.length-1];
    if(last&&last.txt&&last.s.length<400)last.s+=' '+t; else out.push({txt:1,s:t});
  }
  function walk(node,doc,ox,oy,hot){
    for(var ch=node.firstChild;ch&&n<MAX_ELS;ch=ch.nextSibling){
      if(ch.nodeType===3){
        if(hot)continue;
        var pe=ch.parentElement; if(!pe)continue;
        var pr=pe.getBoundingClientRect();
        if(pr.bottom+oy<0||pr.top+oy>vh||pr.right+ox<0||pr.left+ox>vw)continue;
        pushText(ch.nodeValue); continue;
      }
      if(ch.nodeType!==1)continue;
      var el=ch;
      if(SKIP[el.tagName])continue;
      if(el.getAttribute('aria-hidden')==='true')continue;
      if(el.id&&el.id.indexOf('__sk_')===0)continue;
      var st;try{st=(el.ownerDocument.defaultView||window).getComputedStyle(el);}catch(e){continue;}
      if(st.display==='none'||st.visibility==='hidden'||st.opacity==='0')continue;
      var r=el.getBoundingClientRect();
      var inView=r.width>1&&r.height>1&&r.bottom+oy>0&&r.top+oy<vh&&r.right+ox>0&&r.left+ox<vw;
      var hotChild=hot;
      var si=inView?scrollInfo(el,st):null;   // scrollable panes get a ref even if not clickable
      var inter=inView&&isInteractive(el,st,hot);
      if(si||inter){
        var pt=visibleAt(doc,el,r);
        if(pt){
          n++;var ref='e'+n;refEls[ref]=el;
          var isNew=!first&&!seen.has(el);
          var tag=el.tagName.toLowerCase();
          var bits=[];
          var type=el.getAttribute('type');if(type)bits.push('type='+type);
          var role=el.getAttribute('role');if(role&&role!==tag)bits.push('role='+role);
          if(el.checked===true)bits.push('checked');
          var exp=el.getAttribute('aria-expanded');if(exp)bits.push('expanded='+exp);
          var name=nameOf(el);
          var line=(isNew?'*':'')+'@'+ref+' <'+tag+(bits.length?' '+bits.join(' '):'')+'>'+(name?' "'+name+'"':'');
          if(tag==='select'){var os=[].map.call(el.options,function(o){return (o.textContent||'').trim();}).filter(Boolean);line+=' options: '+os.slice(0,8).join(' | ')+(os.length>8?' | …'+(os.length-8)+' more':'');}
          var href=el.getAttribute('href');if(href)line+=' ['+String(href).slice(0,60)+']';
          if(si)line+=' [scrollable pane: '+si.up+'px above, '+si.down+'px below]';
          out.push({s:line});
          refs.push({ref:ref,x:Math.round(pt[0]+ox),y:Math.round(pt[1]+oy),label:name});
          if(inter)hotChild=true;   // pure scroll containers keep their contents visible
        }
      }
      seen.add(el);
      if(el.tagName==='IFRAME'){
        try{var idoc=el.contentDocument;if(idoc&&idoc.body&&r.width>50&&r.height>50)walk(idoc.body,idoc,ox+r.left,oy+r.top,false);}catch(e){}
        continue;
      }
      if(el.shadowRoot)walk(el.shadowRoot,doc,ox,oy,hotChild);
      walk(el,doc,ox,oy,hotChild);
    }
  }
  walk(document.body||document.documentElement,document,0,0,false);
  var total=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);
  var above=Math.round(scrollY), below=Math.max(0,Math.round(total-scrollY-vh));
  var page='Page: '+document.title+'\\nURL: '+location.href
    +'\\nViewport: '+above+'px above, '+below+'px below ('+Math.round(total)+'px total'+(below>40?' — browser_scroll for more':'')+')'
    +(first?'':'\\n(elements marked * are NEW since your last action)')+'\\n\\n';
  var lines=out.map(function(o){return o.s;});
  return {text:page+(lines.length?lines.join('\\n'):'(nothing visible — page may be loading; browser_wait then browser_snapshot)'),refs:refs};
})()`;

const KEYMAP = {
  Enter: { code: "Enter", key: "Enter", vk: 13 }, Tab: { code: "Tab", key: "Tab", vk: 9 },
  Escape: { code: "Escape", key: "Escape", vk: 27 }, Backspace: { code: "Backspace", key: "Backspace", vk: 8 },
  Delete: { code: "Delete", key: "Delete", vk: 46 }, Space: { code: "Space", key: " ", vk: 32 },
  ArrowDown: { code: "ArrowDown", key: "ArrowDown", vk: 40 }, ArrowUp: { code: "ArrowUp", key: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", key: "ArrowRight", vk: 39 },
  PageDown: { code: "PageDown", key: "PageDown", vk: 34 }, PageUp: { code: "PageUp", key: "PageUp", vk: 33 },
  Home: { code: "Home", key: "Home", vk: 36 }, End: { code: "End", key: "End", vk: 35 },
};
function keyInfo(name) {
  if (KEYMAP[name]) return KEYMAP[name];
  if (name.length === 1) return { key: name, code: "Key" + name.toUpperCase(), vk: name.toUpperCase().charCodeAt(0) };
  return { key: name, code: name, vk: 0 };
}
async function pressKey(combo) {
  const parts = String(combo).split("+");
  const keyName = parts.pop();
  let mod = 0;
  for (const p of parts) { const m = p.toLowerCase(); if (m === "alt") mod |= 1; else if (m === "ctrl" || m === "control") mod |= 2; else if (m === "meta" || m === "cmd") mod |= 4; else if (m === "shift") mod |= 8; }
  if (mod === 0 && keyName.length === 1 && !KEYMAP[keyName]) { await cdp("Input.insertText", { text: keyName }); return; }
  const info = keyInfo(keyName);
  const base = { modifiers: mod, key: info.key, code: info.code, windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...base });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function currentTabs() {
  const winId = await agentWindowId();
  const t = winId != null ? await chrome.tabs.query({ windowId: winId }) : await chrome.tabs.query({ currentWindow: true });
  return t.sort((a, b) => a.index - b.index);
}

// ---------- command executor ----------
async function runCommand(command, args) {
  if (!controlMode) return { error: "Browser control is off. Click the Control-browser button (bottom-left) so I can act on the page." };

  // tab management doesn't require a prior attachment
  if (command === "tabs") {
    const tabs = await currentTabs();
    return { text: "Open tabs:\n" + tabs.map((t, i) => `${i + 1}. ${t.id === agentTabId ? "[controlled] " : ""}${t.active ? "[active] " : ""}${(t.title || "").slice(0, 50)} — ${t.url}`).join("\n") };
  }
  if (command === "new_tab") {
    // only steal focus if the user is already watching the agent work
    const watching = await userWatching();
    const winId = await agentWindowId(); // create in a normal window, not our own popup
    const t = await chrome.tabs.create({ url: args.url, active: watching, ...(winId != null ? { windowId: winId } : {}) });
    agentTabId = t.id;
    await waitTabComplete(t.id, 10000); await attach(); await sleep(150); lastSnapshot = null;
    if (watching) await announce("Opened a new tab: " + args.url);
    return { text: `opened a new tab (control moved to it): ${args.url}\n\n` + (await pageState()) };
  }
  if (command === "switch_tab") {
    const tabs = await currentTabs(); const t = tabs[(args.index || 1) - 1];
    if (!t) return { error: `no tab #${args.index} (use browser_tabs to list)` };
    const watching = await userWatching();
    agentTabId = t.id;
    if (watching) {
      await chrome.tabs.update(t.id, { active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch {}
    }
    await attach(); lastSnapshot = null;
    if (watching) await announce("Switched to tab " + args.index);
    return { text: `control moved to tab ${args.index}: ${t.title || t.url}\n\n` + (await pageState()) };
  }
  if (command === "close_tab") {
    const tabs = await currentTabs(); const t = tabs[(args.index || 1) - 1];
    if (!t) return { error: `no tab #${args.index}` };
    if (attachedTabId === t.id) attachedTabId = null;
    if (agentTabId === t.id) agentTabId = null;
    await chrome.tabs.remove(t.id);
    return { text: `closed tab ${args.index}` };
  }

  await attach();
  const watching = await userWatching();   // overlay/cursor only cost time when someone can see them
  switch (command) {
    case "snapshot": {
      if (watching) await announce("Reading the page…");
      lastSnapshot = null; // explicit snapshot: always return the full state
      return { text: (await pageState()).replace(/^Current page state:\n/, "") };
    }
    case "read_page": {
      const max = Math.min(Math.max(args.max_chars || 15000, 500), 60000);
      const t = await evaluate(`(function(){
        var t=document.body?document.body.innerText:'';
        t=t.replace(/\\n{3,}/g,'\\n\\n');
        var out=t.slice(0,${max});
        return 'Page: '+document.title+'\\nURL: '+location.href+'\\n\\n'+out
          +(t.length>${max}?'\\n\\n[truncated — '+(t.length-${max})+' more characters; call again with a larger max_chars]':'');
      })()`);
      return { text: t || "(no text on page)" };
    }
    case "navigate": {
      if (watching) await announce("Navigating to " + args.url);
      await cdp("Page.navigate", { url: args.url });
      await waitTabComplete(attachedTabId, 12000); await sleep(150); lastSnapshot = null;
      return { text: `navigated to ${args.url}\n\n` + (await pageState()) };
    }
    case "click": {
      const c = refsMap[args.ref]; if (!c) return { error: `unknown ref ${args.ref} — use a ref from the latest page state` };
      if (watching) { await announce("Clicking " + (c.label ? `“${c.label}”` : args.ref)); await overlay(c.x, c.y, "click " + args.ref); await sleep(150); }
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: c.x, y: c.y });
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: c.x, y: c.y, button: "left", clickCount: 1 });
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: c.x, y: c.y, button: "left", clickCount: 1 });
      return afterAction(`clicked ${args.ref}${c.label ? ` (“${c.label}”)` : ""}`);
    }
    case "type": {
      const c = refsMap[args.ref]; if (!c) return { error: `unknown ref ${args.ref} — use a ref from the latest page state` };
      if (watching) { await announce("Typing into " + (c.label ? `“${c.label}”` : args.ref)); await overlay(c.x, c.y, "type " + args.ref); await sleep(120); }
      // Focus + clear via the framework-safe native value setter (realm-safe: walk the
      // element's own prototype chain, so it works inside same-origin iframes too).
      // Contenteditable: select-all so the CDP insertText below replaces, not appends.
      const prep = await evaluate(`(function(){
        var el=(window.__sk_refs||{})['${args.ref}']; if(!el)return 'missing';
        try{el.ownerDocument.defaultView.focus();}catch(e){}
        el.focus();
        if((el.tagName==='INPUT'||el.tagName==='TEXTAREA')&&'value' in el){
          var p=Object.getPrototypeOf(el),d=null;
          while(p&&!(d=Object.getOwnPropertyDescriptor(p,'value')))p=Object.getPrototypeOf(p);
          try{if(d&&d.set)d.set.call(el,'');else el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));}catch(e){}
        }else if(el.isContentEditable){
          try{var s=el.ownerDocument.getSelection(),g=el.ownerDocument.createRange();g.selectNodeContents(el);s.removeAllRanges();s.addRange(g);}catch(e){}
        }
        return 'ok';
      })()`);
      if (prep === "missing") return { error: `ref ${args.ref} is no longer on the page — use a ref from the latest page state` };
      await cdp("Input.insertText", { text: args.text });
      if (args.submit) await pressKey("Enter");
      return afterAction(`typed into ${args.ref}${c.label ? ` (“${c.label}”)` : ""}${args.submit ? " and pressed Enter" : ""}`);
    }
    case "select": {
      const c = refsMap[args.ref]; if (!c) return { error: `unknown ref ${args.ref} — use a ref from the latest page state` };
      if (watching) { await announce("Selecting “" + args.option + "”"); await overlay(c.x, c.y, "select " + args.ref); await sleep(120); }
      const r = await evaluate(`(function(){
        var el=(window.__sk_refs||{})['${args.ref}']; if(!el)return {err:'ref no longer on the page — use a ref from the latest page state'};
        if(el.tagName!=='SELECT')return {err:'not a native <select> — click it to open the dropdown, then click the option'};
        var want=${JSON.stringify(String(args.option))}.trim().toLowerCase(), hit=null, i, o, t;
        for(i=0;i<el.options.length&&!hit;i++){o=el.options[i];t=(o.textContent||'').trim().toLowerCase();if(t===want||o.value.toLowerCase()===want)hit=o;}
        for(i=0;i<el.options.length&&!hit;i++){o=el.options[i];if(((o.textContent||'').trim().toLowerCase()).indexOf(want)>=0)hit=o;}
        if(!hit)return {err:'no matching option. Options: '+[].map.call(el.options,function(o){return (o.textContent||'').trim();}).filter(Boolean).slice(0,20).join(' | ')};
        var p=Object.getPrototypeOf(el),d=null;
        while(p&&!(d=Object.getOwnPropertyDescriptor(p,'value')))p=Object.getPrototypeOf(p);
        if(d&&d.set)d.set.call(el,hit.value);else el.value=hit.value;
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return {ok:(hit.textContent||'').trim()};
      })()`);
      if (r && r.err) return { error: r.err };
      return afterAction(`selected “${(r && r.ok) || args.option}” in ${args.ref}`);
    }
    case "press":
      await pressKey(args.key);
      return afterAction(`pressed ${args.key}`);
    case "scroll": {
      if (watching) await announce("Scrolling " + args.direction);
      const px = args.pixels || 600;
      if (args.direction === "top" || args.direction === "bottom") {
        await evaluate(`window.scrollTo(0, ${args.direction === "top" ? 0 : "document.body.scrollHeight"})`);
        return afterAction(`scrolled to ${args.direction}`);
      }
      const dy = args.direction === "up" ? -px : px;
      // a real wheel event scrolls whatever scrollable element is under the point — inner panes/iframes included
      const r = args.ref && refsMap[args.ref];
      let pt;
      if (r) pt = { x: r.x, y: r.y };
      else { const vp = await evaluate("({w:innerWidth,h:innerHeight})"); pt = { x: Math.round(vp.w / 2), y: Math.round(vp.h / 2) }; }
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: pt.x, y: pt.y, deltaX: 0, deltaY: dy });
      return afterAction(`scrolled ${args.direction}${r ? " in @" + args.ref : ""}`);
    }
    case "get_text": {
      const t = await evaluate(`(function(){var el=(window.__sk_refs||{})['${args.ref}'];return el?String(el.innerText||el.value||'').trim().slice(0,2000):null;})()`);
      if (t == null) return { error: `unknown ref ${args.ref}` }; return { text: t || "(empty)" };
    }
    case "wait": {
      // the time since the last observation (LLM latency included) already counts as waiting
      const ms = Math.min(args.ms || 500, 15000);
      const left = Math.max(0, ms - (lastStateTs ? Date.now() - lastStateTs : 0));
      if (left) await sleep(left);
      return { text: `waited ${ms}ms${left < ms ? ` (${ms - left}ms had already passed)` : ""}` };
    }
    case "screenshot": {
      if (watching) await announce("Taking a screenshot");
      let r;
      try {
        r = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 72 });
      } catch {
        // background tabs may not be rendering — flash it to front, capture, then restore focus
        const prev = await queryActiveTab();
        await chrome.tabs.update(attachedTabId, { active: true });
        await sleep(200);
        r = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 72 });
        if (prev && prev.id !== attachedTabId) { try { await chrome.tabs.update(prev.id, { active: true }); } catch {} }
      }
      addImage("data:image/jpeg;base64," + r.data);
      return { data: r.data, mime: "image/jpeg" };
    }
    default: return { error: "unknown command " + command };
  }
}

// ---------- input wiring ----------
function autosize() { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + "px"; }
function takeMessage() {
  // Pull the composed message out of the input: bubble + record + chip handling.
  const text = inputEl.value.trim(); if (!text) return null;
  if (!ws || ws.readyState !== WebSocket.OPEN) { addError("Bridge offline. Start it:  cd bridge && npm start"); return null; }
  const newNames = attachments.map((a) => a.name);
  for (const a of attachments) if (!sessionDirs.some((s) => s.path === a.path)) sessionDirs.push(a); // sticky context
  finishAssistant();
  userBubble(text, newNames);          // show the attached folder(s) on this message
  record("user", text, newNames);
  attachments = []; renderChips();      // clear the input chips, but keep sessionDirs
  inputEl.value = ""; autosize();
  return text;
}
function submit() {
  const wasRunning = running;
  const text = takeMessage(); if (text == null) return;
  if (!wasRunning) { agentTabId = null; lastSnapshot = null; }  // idle: lock onto the tab the user is on now
  turnStarted();                        // mid-run follow-ups keep the agent's current work tab
  sendWS({ type: "task", text, dirs: sessionDirs.map((s) => s.path) });
}
// Escape: interrupt the current turn NOW. With text in the box, the message jumps
// the queue and the agent reads it immediately; with an empty box it's a plain stop.
function interruptSend() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!running) { submit(); return; }  // idle: Escape behaves like Enter
  const d = bubble("tool", null); const b = document.createElement("b"); b.textContent = "interrupted"; d.appendChild(b);
  record("tool", "interrupted");
  const text = takeMessage();          // null/empty ⇒ pure stop
  if (text != null) turnStarted();     // the interrupt message starts its own turn
  sendWS({ type: "interrupt", text: text || "", dirs: sessionDirs.map((s) => s.path) });
}
document.getElementById("send").addEventListener("click", submit);
document.querySelectorAll("#empty .eg").forEach((b) => {
  b.addEventListener("click", () => { inputEl.value = b.textContent; autosize(); inputEl.focus(); });
});
inputEl.addEventListener("input", () => { autosize(); handleAt(); });
inputEl.addEventListener("keydown", (e) => {
  const atOpen = !atmenuEl.classList.contains("hidden");
  if (atOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); return; }
    if (e.key === "Escape") { e.preventDefault(); closeAt(); return; }
    if (e.key === "Enter" && atItems.length) { e.preventDefault(); pickAt(atSel); return; }
  }
  if (e.key === "Escape") { e.preventDefault(); interruptSend(); return; }
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
});
controlBtn.addEventListener("click", () => setControl(!controlMode));
document.getElementById("menu").addEventListener("click", (e) => { e.stopPropagation(); toggleHistory(); });
document.addEventListener("click", (e) => {
  if (!historyEl.contains(e.target)) historyEl.classList.add("hidden");
  if (!atmenuEl.contains(e.target) && e.target !== inputEl) closeAt();
});

(async () => {
  chats = await loadChats(); controlMode = await loadControl(); bridgeUrl = await loadBridgeUrl();
  controlBtn.classList.toggle("on", controlMode);
  controlBtn.title = controlMode ? "Browser control on (click to stop)" : "Browser control off (click to let PerNav act on the page)";
  updateControlStatus(); renderChips(); connect(); if (controlMode) autoAttach();
})();
