// Floating button + slide-out panel for portal.azure.com, so the extension menu is not needed.
// The whole UI lives in a shadow DOM, so Azure Portal CSS cannot reach it.
(function () {
  const HOST_ID = "optimizely-im-tool-host";
  const PANEL_URL = chrome.runtime.getURL("popup.html");
  const ICON_URL = chrome.runtime.getURL("logo.png");
  const PANEL_WIDTH = 420;

  let host = null;
  let isOpen = false;
  let frame = null;

  function build() {
    if (host && host.isConnected) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    // Attach to <html> rather than <body>: a transform/filter on body would
    // anchor the children's position:fixed to the wrong containing block.
    host.setAttribute(
      "style",
      "position:fixed!important;top:0!important;left:0!important;width:0!important;" +
        "height:0!important;margin:0!important;padding:0!important;border:0!important;" +
        "z-index:2147483647!important;"
    );
    const shadow = host.attachShadow({ mode: "open" });
    document.documentElement.appendChild(host);

    const style = document.createElement("style");
    style.textContent = `
      .launcher {
        position: fixed;
        right: 8px;
        top: 42%;
        width: 48px;
        height: 48px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        /* No frame at all: the logo itself is the button, so nothing boxes it in */
        background: none;
        border: 0;
        border-radius: 50%;
        cursor: pointer;
        font: 600 13px/1 system-ui, sans-serif;
        color: #97fa4c;
        transition: right 0.18s ease, transform 0.15s ease;
      }
      .launcher:hover { transform: scale(1.1); }
      .launcher:focus-visible { outline: 2px solid #97fa4c; outline-offset: 2px; }
      /* contain keeps the logo whole; the shadow lifts it off light Azure blades */
      .launcher img {
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
        filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.35));
      }
      .launcher .fallback {
        width: 32px;
        height: 32px;
        line-height: 32px;
        border-radius: 50%;
        background: #0d3a2b;
      }
      .launcher .close {
        display: none;
        width: 32px;
        height: 32px;
        line-height: 30px;
        border-radius: 50%;
        background: #161b27;
        color: #cbd5e1;
        font-size: 20px;
        font-weight: 400;
      }

      .launcher.open { right: ${PANEL_WIDTH + 8}px; }
      .launcher.open img, .launcher.open .fallback { display: none; }
      .launcher.open .close { display: block; }

      .panel {
        position: fixed;
        right: 0;
        top: 12px;
        width: ${PANEL_WIDTH}px;
        height: min(560px, calc(100vh - 24px));
        background: #0e1117;
        border: 1px solid #2a3347;
        border-right: none;
        border-radius: 10px 0 0 10px;
        box-shadow: -6px 0 32px rgba(0, 0, 0, 0.55);
        overflow: hidden;
        display: none;
      }
      .panel.open { display: block; }
      .panel iframe {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
        color-scheme: dark;
      }
    `;

    const launcher = document.createElement("button");
    launcher.className = "launcher";
    launcher.type = "button";
    launcher.title = "Optimizely IM tool";

    const img = document.createElement("img");
    img.alt = "";
    img.src = ICON_URL;
    const fallback = document.createElement("span");
    fallback.className = "fallback";
    fallback.textContent = "IM";
    fallback.style.display = "none";
    // The button must stay visible even if the icon fails to load
    img.addEventListener("error", () => {
      img.style.display = "none";
      fallback.style.display = "block";
    });
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "×";
    launcher.append(img, fallback, close);

    const panel = document.createElement("div");
    panel.className = "panel";
    frame = document.createElement("iframe");
    // clipboard-write so document.execCommand("copy") still works inside the panel
    frame.setAttribute("allow", "clipboard-write");
    panel.appendChild(frame);

    shadow.append(style, launcher, panel);

    function open() {
      // Reload on every open so popup.js reads the current blade URL and the latest Bearer token
      frame.src = `${PANEL_URL}?t=${Date.now()}`;
      isOpen = true;
      panel.classList.add("open");
      launcher.classList.add("open");
      launcher.title = "Close";
    }

    function close_() {
      isOpen = false;
      panel.classList.remove("open");
      launcher.classList.remove("open");
      launcher.title = "Optimizely IM tool";
      frame.removeAttribute("src");
    }

    launcher.addEventListener("click", () => (isOpen ? close_() : open()));

    // Clicking outside the panel closes it (clicks inside the iframe never reach this document, so it is safe)
    document.addEventListener(
      "mousedown",
      (e) => {
        if (isOpen && !e.composedPath().includes(host)) close_();
      },
      true
    );

    document.addEventListener("keydown", (e) => {
      if (isOpen && e.key === "Escape") close_();
    });
  }

  build();

  // Azure Portal is a SPA and may wipe the DOM; rebuild the button if it gets removed.
  new MutationObserver(() => {
    if (!host || !host.isConnected) build();
  }).observe(document.documentElement, { childList: true });
})();
