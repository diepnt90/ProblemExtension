// MV3 service worker.
// Captures the Azure Portal Bearer token when the portal calls management.azure.com.
// Also records the remote IP used by HTTPer extension fetches.
//
// Differences from MV2:
//  - No more "webRequestBlocking" (MV3 forbids it) -> the listener runs in observe mode,
//    which is all that is needed to read the header.
//  - The service worker can be killed at any time, so the token is NOT kept in a global
//    variable, and it is no longer stuffed into the badge text. It lives in
//    chrome.storage.session (browser-session only, never written to disk).

const TOKEN_KEY = "azureAuthToken";
const TOKEN_TS_KEY = "azureAuthTokenAt";
const REMOTE_CONNECTIONS_KEY = "httperRemoteConnections";

// AAD tokens usually live ~60-75 minutes. Past this mark treat it as expired and ask for a portal refresh.
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;
const REMOTE_CONNECTION_MAX_AGE_MS = 30 * 1000;
const EXTENSION_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

async function saveToken(value) {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  if (stored[TOKEN_KEY] === value) return; // skip the write when the token has not changed

  await chrome.storage.session.set({
    [TOKEN_KEY]: value,
    [TOKEN_TS_KEY]: Date.now()
  });

  // The badge is only a "token captured" indicator; it does not hold the token.
  chrome.action.setBadgeBackgroundColor({ color: "#34d399" });
  chrome.action.setBadgeText({ text: "ok" });
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  function (details) {
    const headers = details.requestHeaders || [];
    for (const header of headers) {
      if (header.name.toLowerCase() !== "authorization") continue;
      const value = header.value || "";
      if (!value.startsWith("Bearer ")) break;
      // The listener must stay synchronous; let the storage write run in the background.
      saveToken(value);
      break;
    }
  },
  { urls: ["https://management.azure.com/*"] },
  ["requestHeaders"]
);

function defaultPortForUrl(url) {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    if (u.protocol === "https:") return 443;
    if (u.protocol === "http:") return 80;
  } catch {}
  return null;
}

function normalizeUrl(url) {
  try { return new URL(String(url || "")).href; } catch { return String(url || ""); }
}

function isLikelyExtensionRequest(details) {
  // Extension fetches normally have our extension origin as initiator. For some redirect/manual-fetch
  // paths Chromium may omit initiator, but those requests are still detached from a normal tab.
  if (details.initiator === EXTENSION_ORIGIN) return true;
  if (!details.initiator && details.tabId === -1) return true;
  if (details.initiator === "null" && details.tabId === -1) return true;
  return false;
}

async function rememberRemoteConnection(details, eventName) {
  if (!isLikelyExtensionRequest(details)) return;

  const now = Date.now();
  const stored = await chrome.storage.session.get(REMOTE_CONNECTIONS_KEY);
  const current = Array.isArray(stored[REMOTE_CONNECTIONS_KEY]) ? stored[REMOTE_CONNECTIONS_KEY] : [];
  const fresh = current.filter(item => now - Number(item.at || 0) <= REMOTE_CONNECTION_MAX_AGE_MS);

  fresh.push({
    requestId: details.requestId,
    method: String(details.method || "GET").toUpperCase(),
    url: normalizeUrl(details.url),
    ip: details.ip || "",
    port: defaultPortForUrl(details.url),
    fromCache: Boolean(details.fromCache),
    statusCode: Number(details.statusCode || 0),
    statusLine: details.statusLine || "",
    redirectUrl: details.redirectUrl || "",
    eventName: eventName || "",
    at: now
  });

  await chrome.storage.session.set({ [REMOTE_CONNECTIONS_KEY]: fresh.slice(-80) });
}

chrome.webRequest.onResponseStarted.addListener(
  details => { rememberRemoteConnection(details, "responseStarted"); },
  { urls: ["http://*/*", "https://*/*"] }
);

// For redirect:'manual', Fetch exposes an opaqueredirect response (status 0), but webRequest
// still sees the actual 30x response. Capture it here as well as onResponseStarted.
chrome.webRequest.onBeforeRedirect.addListener(
  details => { rememberRemoteConnection(details, "beforeRedirect"); },
  { urls: ["http://*/*", "https://*/*"] }
);

// popup.js and HTTPer ask the service worker for session-only data here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "GET_TOKEN") {
    chrome.storage.session.get([TOKEN_KEY, TOKEN_TS_KEY]).then((data) => {
      const token = data[TOKEN_KEY] || "";
      const at = data[TOKEN_TS_KEY] || 0;
      const expired = !at || Date.now() - at > TOKEN_MAX_AGE_MS;
      sendResponse({ token, at, expired: Boolean(token) && expired });
    });
    return true; // keep the message channel open for the async sendResponse
  }

  if (msg.type === "GET_REMOTE_INFO") {
    chrome.storage.session.get(REMOTE_CONNECTIONS_KEY).then((data) => {
      const now = Date.now();
      const method = String(msg.method || "GET").toUpperCase();
      const url = normalizeUrl(msg.url);
      const items = Array.isArray(data[REMOTE_CONNECTIONS_KEY]) ? data[REMOTE_CONNECTIONS_KEY] : [];
      const match = items
        .filter(item => normalizeUrl(item.url) === url && item.method === method && now - Number(item.at || 0) <= REMOTE_CONNECTION_MAX_AGE_MS)
        .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))[0] || null;
      sendResponse(match);
    });
    return true;
  }

  return false;
});

// Session data is gone after a browser restart -> clear the badge so it is not misleading.
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
