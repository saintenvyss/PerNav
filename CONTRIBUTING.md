# Contributing to PerNav

Thanks for your interest! PerNav is a small, dependency-light codebase and most
changes land fast. This page tells you how to get a dev setup running and what
makes a PR easy to merge.

## Dev setup

There is no build step anywhere — the extension is plain JS/HTML/CSS and the
bridge is plain Node ESM.

```sh
git clone https://github.com/saintenvyss/PerNav
cd PerNav/bridge
npm install
npm start          # → [pernav] bridge listening on ws://127.0.0.1:8765
```

Then load `extension/` unpacked (`chrome://extensions` → Developer mode →
Load unpacked) in any Chromium-based browser, or use `./launch.ps1` /
`./launch.sh` to do bridge + browser in one command with an isolated profile.

### The edit-reload loop

| You changed | To see it take effect |
|---|---|
| `bridge/bridge.mjs`, `bridge/tools.mjs`, `bridge/mcp-shim.mjs` | Restart the bridge (`Ctrl-C`, `npm start`). A running task keeps its old code until you restart. |
| `extension/sidepanel.js` / `sidepanel.css` / `sidepanel.html` | Close and reopen the side panel — no extension reload needed. |
| `extension/manifest.json` / `background.js` | Full reload of the extension on `chrome://extensions`. |

### Trying your change

There's no automated test suite yet (contributions welcome!). Before opening a
PR, run a real task end-to-end on at least one provider and one Chromium
browser: open a page, give the sidebar a task that clicks and types, and check
the tool-call trace in the panel looks sane. If you touched the bridge's
provider layer, say in the PR which provider(s) you tested with.

## Where things live

- `bridge/bridge.mjs` — provider registry (`PROVIDERS`), Claude Agent SDK
  session, CLI engine (Codex/Gemini/Qwen/Copilot), OpenAI-compatible agent
  loop, WebSocket server, settings/config.
- `bridge/tools.mjs` — browser tool definitions shared by every engine.
- `bridge/mcp-shim.mjs` — stdio MCP server the CLIs launch; forwards tool
  calls back to the bridge.
- `extension/sidepanel.js` — UI, Settings, `chrome.debugger` executor, DOM
  snapshot, cursor overlay.
- `extension/background.js` — opens the side panel (or a floating window).

## Adding a provider

The most common contribution. For anything with an OpenAI-compatible API it's
one entry in the `PROVIDERS` registry in `bridge/bridge.mjs`: id, label, base
URL, where to get a key, and a curated model shortlist. Copy an existing entry
(e.g. `deepseek`) and adjust. The model dropdown's "refresh list" pulls the
live list from the provider's `/models` endpoint automatically.

## Ground rules

- **Vanilla JS, no frameworks, no build step.** That's a feature — anyone can
  read the whole codebase in an afternoon. Match the style of the file you're
  editing.
- **Keep dependencies near zero.** The extension has none; the bridge has
  three. A new dependency needs a strong reason.
- **Never log or transmit secrets.** Keys/tokens live only in
  `~/.pernav/config.json`; the extension only ever sees masked previews. Keep
  it that way.
- **Don't loosen the security posture** — the bridge binds to `127.0.0.1` and
  rejects WebSocket connections with web-page origins; the agent gets browser
  tools only; CLI providers run sandboxed/tool-restricted. PRs that relax any
  of this need a very good story.
- **Small, focused PRs** with a clear description of what changed and how you
  tested it merge much faster than grab-bags.

## Bugs & ideas

Open an issue — there are templates for bug reports and feature requests. For
bugs, the bridge's terminal output and the panel's tool-call trace are usually
the fastest route to a diagnosis, so include them if you can (strip anything
private first).

## License

MIT. By contributing you agree your contributions are licensed under the same
terms. There is no CLA.
