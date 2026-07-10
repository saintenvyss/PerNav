// Open the side panel when the toolbar icon is clicked. Browsers without the
// Side Panel API (Chromium < 114, or forks that removed the panel UI) get the
// same page in a small floating window instead.
const hasSidePanel = !!chrome.sidePanel;

chrome.runtime.onInstalled.addListener(() => {
  if (hasSidePanel) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

const PANEL_URL = chrome.runtime.getURL("sidepanel.html");
async function openPanelWindow() {
  const [existing] = await chrome.tabs.query({ url: PANEL_URL });
  if (existing) {
    try { await chrome.windows.update(existing.windowId, { focused: true }); return; } catch {}
  }
  await chrome.windows.create({ url: PANEL_URL, type: "popup", width: 420, height: 720 });
}

chrome.action.onClicked.addListener((tab) => {
  if (hasSidePanel) {
    if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  } else {
    openPanelWindow().catch(() => {});
  }
});
