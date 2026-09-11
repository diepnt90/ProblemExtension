// MV3 service worker.
// Captures the Azure Portal Bearer token when the portal calls management.azure.com.
//
// Differences from MV2:
//  - No more "webRequestBlocking" (MV3 forbids it) -> the listener runs in observe mode,
//    which is all that is needed to read the header.
//  - The service worker can be killed at any time, so the token is NOT kept in a global
//    variable, and it is no longer stuffed into the badge text. It lives in
//    chrome.storage.session (browser-session only, never written to disk).

const TOKEN_KEY = "azureAuthToken";
const TOKEN_TS_KEY = "azureAuthTokenAt";

// AAD tokens usually live ~60-75 minutes. Past this mark treat it as expired and ask for a portal refresh.
const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

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

// popup.js asks for the token here instead of reading the badge like the MV2 build did.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "GET_TOKEN") return false;

  chrome.storage.session.get([TOKEN_KEY, TOKEN_TS_KEY]).then((data) => {
    const token = data[TOKEN_KEY] || "";
    const at = data[TOKEN_TS_KEY] || 0;
    const expired = !at || Date.now() - at > TOKEN_MAX_AGE_MS;
    sendResponse({ token, at, expired: Boolean(token) && expired });
  });

  return true; // keep the message channel open for the async sendResponse
});

// The token is gone after a browser restart (storage.session clears itself) -> clear the badge so it is not misleading.
chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});
