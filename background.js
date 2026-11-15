"use strict";

// Sites that use Media Source Extensions (most of them) give the <video> a
// blob: URL that no other app can open. The real stream is usually an HLS
// (.m3u8) or DASH (.mpd) manifest fetched by the page, so we watch the tab's
// network traffic and remember those URLs for the content script to use.

const MAX_PER_TAB = 20;

/** @type {Map<number, {url: string, kind: string, time: number, master: boolean}[]>} */
const streamsByTab = new Map();

const MANIFEST_TYPES = {
  "application/vnd.apple.mpegurl": "hls",
  "application/x-mpegurl": "hls",
  "audio/mpegurl": "hls",
  "audio/x-mpegurl": "hls",
  "application/dash+xml": "dash",
};

function classify(url, contentType, requestType) {
  const type = (contentType || "").split(";")[0].trim().toLowerCase();
  if (MANIFEST_TYPES[type]) return MANIFEST_TYPES[type];

  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname.toLowerCase();
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  // Some players load manifests through a script, e.g. /play?file=x.m3u8
  const query = u.search.toLowerCase();
  if (/\.m3u8(\W|$)/.test(query)) return "hls";
  if (/\.mpd(\W|$)/.test(query)) return "dash";

  // Progressive files loaded directly by a media element. XHR-loaded video/*
  // responses are almost always MSE segments, which are useless on their own.
  if (requestType === "media" && type.startsWith("video/")) return "file";
  return null;
}

function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : "";
}

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    const kind = classify(
      details.url,
      headerValue(details.responseHeaders, "content-type"),
      details.type
    );
    if (!kind) return;

    const list = streamsByTab.get(details.tabId) || [];
    if (list.some((s) => s.url === details.url)) return;
    const entry = { url: details.url, kind, time: Date.now(), master: false };
    list.push(entry);
    if (list.length > MAX_PER_TAB) list.shift();
    streamsByTab.set(details.tabId, list);

    // A page usually fetches an HLS master playlist (all qualities) followed
    // by one or more variant playlists. Prefer handing off the master so the
    // external player can pick quality itself.
    if (kind === "hls") {
      fetch(details.url, { credentials: "include" })
        .then((r) => r.text())
        .then((text) => {
          entry.master = text.includes("#EXT-X-STREAM-INF");
        })
        .catch(() => {});
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Forget a tab's streams when it navigates to a new page or closes.
browser.webRequest.onBeforeRequest.addListener(
  (details) => streamsByTab.delete(details.tabId),
  { urls: ["<all_urls>"], types: ["main_frame"] }
);
browser.tabs.onRemoved.addListener((tabId) => streamsByTab.delete(tabId));

// Fetches a URL the way an external player would: no cookies, no Referer,
// no Origin. Bodies are only read when asked for (playlists); for media the
// request is aborted once headers arrive.
async function probeAsPlayer(url, wantText) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: ctrl.signal,
    });
    const result = {
      ok: r.ok,
      status: r.status,
      type: r.headers.get("content-type") || "",
      url: r.url,
    };
    if (wantText && r.ok) result.text = (await r.text()).slice(0, 200000);
    return result;
  } catch (e) {
    return { ok: false, status: 0, error: ctrl.signal.aborted ? "timed out" : String(e.message || e) };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender.tab) return undefined;
  if (msg.type === "getStreams") {
    return Promise.resolve(streamsByTab.get(sender.tab.id) || []);
  }
  if (msg.type === "probe") {
    return probeAsPlayer(msg.url, msg.wantText);
  }
  return undefined;
});
