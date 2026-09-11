// MV3 service worker.
// Captures the Azure Portal Bearer token when the portal calls management.azure.com.
// Also records connection and response metadata used by HTTPer extension fetches.

const TOKEN_KEY = "azureAuthToken";
const TOKEN_TS_KEY = "azureAuthTokenAt";
const REMOTE_CONNECTIONS_KEY = "httperRemoteConnections";

// AAD tokens usually live ~60-75 minutes. Past this mark treat it as expired and ask for a portal refresh.
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;
const REMOTE_CONNECTION_MAX_AGE_MS = 30 * 1000;
const EXTENSION_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

async function saveToken(value) {
  const stored = await chrome.storage.session.get(TOKEN_KEY);
  if (stored[TOKEN_KEY] === value) return;

  await chrome.storage.session.set({
    [TOKEN_KEY]: value,
    [TOKEN_TS_KEY]: Date.now()
  });

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
  if (details.initiator === EXTENSION_ORIGIN) return true;
  if (!details.initiator && details.tabId === -1) return true;
  if (details.initiator === "null" && details.tabId === -1) return true;
  return false;
}

function serializeResponseHeaders(headers, redirectUrl) {
  const out = [];
  for (const header of headers || []) {
    const name = String(header?.name || "").trim();
    const value = header?.value ?? (Array.isArray(header?.binaryValue) ? String.fromCharCode(...header.binaryValue) : "");
    if (!name) continue;
    out.push({ name, value: String(value || "") });
  }

  // Chromium internal redirects (for example HSTS/HTTPS upgrades) may expose redirectUrl
  // without a normal Location header. Surface it as Location so HTTPer can still show the target.
  if (redirectUrl && !out.some(h => h.name.toLowerCase() === "location")) {
    out.push({ name: "location", value: String(redirectUrl) });
  }

  return out;
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
    responseHeaders: serializeResponseHeaders(details.responseHeaders, details.redirectUrl),
    eventName: eventName || "",
    at: now
  });

  await chrome.storage.session.set({ [REMOTE_CONNECTIONS_KEY]: fresh.slice(-80) });
}

chrome.webRequest.onResponseStarted.addListener(
  details => { rememberRemoteConnection(details, "responseStarted"); },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

// For redirect:'manual', Fetch exposes an opaqueredirect response (status 0), while webRequest
// still sees the actual 30x response and its Location header.
chrome.webRequest.onBeforeRedirect.addListener(
  details => { rememberRemoteConnection(details, "beforeRedirect"); },
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "GET_TOKEN") {
    chrome.storage.session.get([TOKEN_KEY, TOKEN_TS_KEY]).then((data) => {
      const token = data[TOKEN_KEY] || "";
      const at = data[TOKEN_TS_KEY] || 0;
      const expired = !at || Date.now() - at > TOKEN_MAX_AGE_MS;
      sendResponse({ token, at, expired: Boolean(token) && expired });
    });
    return true;
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

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
