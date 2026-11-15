"use strict";

// Shows an "open in player" button over a video once it starts playing.
// Tapping it opens the video in FirePlayer's fullscreen player (player.js).
// The "⋯" button next to it opens a panel listing every stream found for the
// page, which can be handed to a native Android player (VLC, MX Player, ...)
// through an intent, with a test that shows whether that player can load it.

(() => {
  if (window.__fireplayerLoaded) return;
  window.__fireplayerLoaded = true;

  const HIDE_AFTER_MS = 4000;
  const MIN_WIDTH = 160;
  const MIN_HEIGHT = 90;
  // Distance from the video's bottom-right corner. The bottom offset keeps the
  // button clear of the control bar most players draw along the bottom edge.
  const INSET_RIGHT = 12;
  const INSET_BOTTOM = 56;

  const STREAM_MIME = {
    hls: "application/x-mpegURL",
    dash: "application/dash+xml",
  };
  const KIND_LABEL = { hls: "HLS", dash: "DASH", file: "File" };

  let video = null;
  let hideTimer = 0;
  let rafId = 0;

  const log = (...args) => console.info("[FirePlayer]", ...args);

  // --- UI -----------------------------------------------------------------

  const host = document.createElement("fireplayer-ui");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bar, .toast, .sheet {
        position: fixed;
        z-index: 2147483647;
        font: 400 13px/1.35 system-ui, sans-serif;
        color: #fff;
      }
      .bar {
        display: none;
        gap: 6px;
        opacity: 0;
        transition: opacity 0.2s;
      }
      .bar.shown { opacity: 1; }
      .pill {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 36px;
        padding: 0 12px 0 10px;
        border-radius: 18px;
        font: inherit;
        font-weight: 600;
        color: inherit;
        background: rgba(20, 20, 20, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.25);
        -webkit-backdrop-filter: blur(6px);
        backdrop-filter: blur(6px);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .pill.more { width: 36px; padding: 0; justify-content: center; }
      .pill:active { background: rgba(60, 60, 60, 0.9); }
      .pill svg { width: 18px; height: 18px; fill: currentColor; }
      .toast {
        left: 50%;
        bottom: 24px;
        max-width: min(90vw, 420px);
        transform: translateX(-50%);
        padding: 10px 14px;
        border-radius: 8px;
        background: rgba(20, 20, 20, 0.88);
        text-align: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
      }
      .toast.shown { opacity: 1; }
      .sheet {
        display: none;
        left: 50%;
        bottom: 0;
        transform: translateX(-50%);
        box-sizing: border-box;
        width: min(100vw, 560px);
        max-height: 75vh;
        overflow-y: auto;
        padding: 14px 16px 20px;
        border-radius: 14px 14px 0 0;
        background: #1c1b22;
        box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.5);
      }
      .sheet.open { display: block; }
      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .head b { font-size: 15px; }
      .meta { color: #bbb; margin: 0 0 10px; word-break: break-all; }
      .stream { border-top: 1px solid #333; padding: 10px 0; }
      .tags { display: flex; gap: 6px; margin-bottom: 4px; }
      .tag { font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; background: #3a3944; }
      .tag.pick { background: #0060df; }
      .url { font: 12px/1.35 ui-monospace, monospace; color: #ddd; word-break: break-all; user-select: text; }
      .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .actions button, .close {
        font: inherit;
        color: #fff;
        background: #3a3944;
        border: 0;
        border-radius: 6px;
        padding: 6px 10px;
        cursor: pointer;
      }
      .actions button:active, .close:active { background: #55545f; }
      .results { margin-top: 8px; }
      .row { display: flex; gap: 6px; font-size: 12px; }
      .row .st { flex: none; width: 1.2em; }
      .row .why { color: #bbb; }
      .verdict { margin-top: 6px; padding: 8px; border-radius: 6px; background: #2b2a33; }
      .empty { color: #bbb; }
    </style>
    <div class="bar">
      <button class="pill more" type="button" aria-label="Stream details">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
      <button class="pill open" type="button" aria-label="Open in FirePlayer">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h9v2H6v10h12v-7h2v9H4z M15 3h6v6h-2V6.4l-6.3 6.3-1.4-1.4L17.6 5H15z"/>
        </svg>
        <span>FirePlayer</span>
      </button>
    </div>
    <div class="sheet" role="dialog" aria-label="FirePlayer streams"></div>
    <div class="toast" role="status"></div>
  `;
  const bar = root.querySelector(".bar");
  const sheet = root.querySelector(".sheet");
  const toast = root.querySelector(".toast");

  // Keep taps on our UI from reaching the page's player (many players toggle
  // play/pause on any tap inside them).
  for (const el of [bar, sheet]) {
    for (const type of ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup", "click"]) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }
  const stage = window.__fireplayerStage;
  root.querySelector(".open").addEventListener("click", (e) => {
    e.preventDefault();
    if (!video) return;
    hide();
    stage.open(video);
  });
  root.querySelector(".more").addEventListener("click", (e) => {
    e.preventDefault();
    openSheet();
  });

  // Elements outside the fullscreen element aren't rendered, so the UI has to
  // live inside it while a player is fullscreen.
  function mountHost() {
    const fs = document.fullscreenElement;
    const parent = fs && fs.tagName !== "VIDEO" ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  let toastTimer = 0;
  function showToast(text) {
    mountHost();
    toast.textContent = text;
    toast.classList.add("shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("shown"), 4000);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // --- Button placement -----------------------------------------------------

  function place() {
    rafId = 0;
    if (!video || !video.isConnected) return hide();
    const r = video.getBoundingClientRect();
    const onScreen = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    if (!onScreen || r.width < MIN_WIDTH || r.height < MIN_HEIGHT) {
      bar.style.display = "none";
    } else {
      bar.style.display = "flex";
      const bw = bar.offsetWidth;
      const bh = bar.offsetHeight;
      const bottomInset = r.height > 200 ? INSET_BOTTOM : 8;
      const left = Math.min(r.right, innerWidth) - bw - INSET_RIGHT;
      const top = Math.min(r.bottom, innerHeight) - bh - bottomInset;
      bar.style.left = `${Math.max(left, r.left + 4)}px`;
      bar.style.top = `${Math.max(top, r.top + 4)}px`;
    }
    rafId = requestAnimationFrame(place);
  }

  function show(v) {
    if (stage.isOpen()) return;
    video = v;
    mountHost();
    if (!rafId) place();
    // Let display:flex apply before fading in.
    requestAnimationFrame(() => bar.classList.add("shown"));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_AFTER_MS);
  }

  function hide() {
    clearTimeout(hideTimer);
    bar.classList.remove("shown");
    hideTimer = setTimeout(() => {
      cancelAnimationFrame(rafId);
      rafId = 0;
      bar.style.display = "none";
    }, 200);
  }

  // --- Which videos get a button -------------------------------------------

  function eligible(v) {
    if (!(v instanceof HTMLVideoElement)) return false;
    // Muted looping videos are decorative backgrounds / GIF replacements.
    if (v.loop && v.muted && !v.controls) return false;
    const r = v.getBoundingClientRect();
    return r.width >= MIN_WIDTH && r.height >= MIN_HEIGHT;
  }

  // Media events don't bubble, but they do pass through capture listeners.
  document.addEventListener("play", (e) => {
    if (eligible(e.target)) show(e.target);
  }, true);

  // Tapping a video brings the button back after it auto-hid.
  document.addEventListener("pointerdown", (e) => {
    if (e.target === host || stage.isOpen()) return;
    for (const v of document.querySelectorAll("video")) {
      if (!eligible(v) || (v.paused && v !== video)) continue;
      const r = v.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        show(v);
        return;
      }
    }
  }, true);

  document.addEventListener("fullscreenchange", () => {
    if (sheet.classList.contains("open")) mountHost();
    else if (video) show(video);
  });

  // --- Finding streams -----------------------------------------------------

  function isNetworkUrl(url) {
    return /^https?:/i.test(url || "");
  }

  function kindOf(url) {
    const path = url.split(/[?#]/)[0].toLowerCase();
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".mpd")) return "dash";
    return "file";
  }

  // Every URL that might play elsewhere, best guess first: the video's own
  // network source, then HLS master playlists, other HLS, DASH, and plain
  // files seen on the network (newest first within each group).
  async function candidates(v) {
    const list = [];
    const add = (url, kind, extra) => {
      if (url && !list.some((c) => c.url === url)) list.push({ url, kind, ...extra });
    };

    // currentSrc is what is actually playing. When it's a blob: (MSE) URL, the
    // element's src/<source> attributes are leftovers and not worth trying.
    // Attributes are read raw: an empty src="" reflects as the page's own URL.
    const elementSrcs = v.currentSrc
      ? [v.currentSrc]
      : [v, ...v.querySelectorAll("source")].map((e) => (e.getAttribute("src") || "").trim()).filter(Boolean);
    for (const src of elementSrcs) {
      let abs;
      try {
        abs = new URL(src, document.baseURI).href;
      } catch {
        continue;
      }
      if (isNetworkUrl(abs) && abs !== location.href) add(abs, kindOf(abs), { from: "video element" });
    }

    let streams = [];
    try {
      streams = await browser.runtime.sendMessage({ type: "getStreams" });
    } catch {}
    const newestFirst = [...streams].reverse();
    const rank = (s) => (s.kind === "hls" ? (s.master ? 0 : 1) : s.kind === "dash" ? 2 : 3);
    newestFirst.sort((a, b) => rank(a) - rank(b));
    for (const s of newestFirst) add(s.url, s.kind, { from: "network", master: s.master });
    return list;
  }

  // --- Hand-off ------------------------------------------------------------

  // Firefox for Android hands intent: URIs to Android, which shows the usual
  // "Open with" chooser for every app that handles the given MIME type.
  function toIntentUrl(src, title, mime) {
    const u = new URL(src);
    u.hash = "";
    const scheme = u.protocol.slice(0, -1);
    const rest = u.href.slice(scheme.length + 3); // drop "scheme://"
    let intent = `intent://${rest}#Intent;scheme=${scheme};action=android.intent.action.VIEW;type=${mime}`;
    if (title) intent += `;S.title=${encodeURIComponent(title)}`;
    return `${intent};end`;
  }

  function launch(url, mime) {
    log("opening", url, "as", mime);
    if (video) video.pause();
    hide();
    sheet.classList.remove("open");
    const a = document.createElement("a");
    a.href = toIntentUrl(url, document.title.trim(), mime);
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    root.appendChild(a);
    a.click();
    a.remove();
  }

  // --- Diagnostics panel -----------------------------------------------------

  // Same request from the page's side: page cookies, Referer and Origin.
  // Uses the page's own fetch (content.fetch) so the request is made as the
  // site, not as the extension.
  async function probeAsPage(url, wantText) {
    const pageFetch = typeof content !== "undefined" && content.fetch ? content.fetch.bind(content) : fetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await pageFetch(url, { cache: "no-store", signal: ctrl.signal });
      const result = { ok: r.ok, status: r.status, type: r.headers.get("content-type") || "", url: r.url };
      if (wantText && r.ok) result.text = (await r.text()).slice(0, 200000);
      return result;
    } catch (e) {
      return { ok: false, status: 0, error: ctrl.signal.aborted ? "timed out" : String(e.message || e) };
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
  }

  function probeAsPlayer(url, wantText) {
    return browser.runtime.sendMessage({ type: "probe", url, wantText });
  }

  function firstUri(playlist, base) {
    for (const line of playlist.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) return new URL(t, base).href;
    }
    return null;
  }

  function keyUri(playlist, base) {
    const m = playlist.match(/#EXT-X-KEY:([^\n]*)/);
    if (!m || /METHOD=NONE/.test(m[1])) return null;
    const uri = m[1].match(/URI="([^"]+)"/);
    if (!uri || !/^(https?:|\/|[^:]+$)/i.test(uri[1])) return null; // skip skd:, data:
    return new URL(uri[1], base).href;
  }

  // Walks the stream the way a player would (playlist → variant → key →
  // segment), fetching each piece without browser cookies or headers. When a
  // piece fails, it is retried as the page to see whether the browser context
  // is what makes it work.
  async function diagnose(stream, onUpdate) {
    const steps = [];
    const step = async (label, url, wantText) => {
      const s = { label, url, player: await probeAsPlayer(url, wantText) };
      steps.push(s);
      onUpdate(steps);
      if (!s.player.ok) {
        s.page = await probeAsPage(url, wantText);
        onUpdate(steps);
      }
      const good = s.player.ok ? s.player : s.page && s.page.ok ? s.page : null;
      if (good && !wantText && /^text\/html/i.test(good.type)) {
        s.note = "returned a web page, not media";
        onUpdate(steps);
      }
      return good;
    };

    if (stream.kind === "hls") {
      let r = await step("Playlist", stream.url, true);
      if (!r) return steps;
      if (!r.text.trimStart().startsWith("#EXTM3U")) {
        steps[steps.length - 1].note = "response isn't an HLS playlist";
        onUpdate(steps);
        return steps;
      }
      if (r.text.includes("#EXT-X-STREAM-INF")) {
        const variant = firstUri(r.text, r.url);
        if (!variant) return steps;
        r = await step("Variant playlist", variant, true);
        if (!r) return steps;
      }
      const key = keyUri(r.text, r.url);
      if (key) await step("Decryption key", key, false);
      const seg = firstUri(r.text, r.url);
      if (seg) await step("First segment", seg, false);
    } else if (stream.kind === "dash") {
      await step("Manifest", stream.url, true);
    } else {
      await step("Video file", stream.url, false);
    }
    return steps;
  }

  function describe(p) {
    if (!p) return "";
    if (p.status) return `${p.status}${p.type ? ` ${p.type.split(";")[0]}` : ""}`;
    return p.error || "failed";
  }

  function verdict(steps) {
    if (steps.some((s) => !s.player.ok && s.page && s.page.ok)) {
      return "Only loads with the site's cookies or headers (Referer/Origin). External players can't send those, so this stream can't be handed off.";
    }
    if (steps.some((s) => !s.player.ok)) {
      return "Fails even when requested the way the page does. The link may have expired, be single-use, or be tied to the page session — try reloading the page and test again.";
    }
    if (steps.some((s) => s.note)) {
      return "Loads, but the server isn't returning a playable stream (see notes above).";
    }
    return "Everything loads without the browser. If the app still fails, it probably doesn't support this format — try VLC, or \"Open in app as HLS/DASH\".";
  }

  function renderResults(box, steps, done) {
    box.replaceChildren();
    for (const s of steps) {
      const row = el("div", "row");
      const pending = !s.player.ok && !s.page;
      const ok = s.player.ok;
      row.append(el("span", "st", pending ? "…" : ok ? "✓" : "✗"));
      const text = el("span");
      text.append(`${s.label}: ${describe(s.player)}`);
      if (s.page) text.append(el("span", "why", ` — as page: ${describe(s.page)}`));
      if (s.note) text.append(el("span", "why", ` — ${s.note}`));
      row.append(text);
      box.append(row);
    }
    if (done) box.append(el("div", "verdict", verdict(steps)));
  }

  async function openSheet() {
    const v = video;
    clearTimeout(hideTimer);
    hide();
    mountHost();
    sheet.replaceChildren();

    const head = el("div", "head");
    head.append(el("b", null, "FirePlayer"));
    const close = el("button", "close", "Close");
    close.type = "button";
    close.addEventListener("click", () => sheet.classList.remove("open"));
    head.append(close);
    sheet.append(head);

    if (v) {
      const src = v.currentSrc || v.src || "(none)";
      sheet.append(el("p", "meta", `Video source: ${src}${v.mediaKeys ? " · DRM-protected" : ""}`));
    }
    sheet.classList.add("open");

    const list = v ? await candidates(v) : [];
    log("candidates", list);
    if (!list.length) {
      sheet.append(el("p", "empty", "No stream URLs found for this video yet. Let it play for a few seconds and try again."));
      return;
    }

    list.forEach((c, i) => {
      const item = el("div", "stream");
      const tags = el("div", "tags");
      if (i === 0) tags.append(el("span", "tag pick", "Best guess"));
      tags.append(el("span", "tag", KIND_LABEL[c.kind] + (c.master ? " master" : "")));
      tags.append(el("span", "tag", c.from));
      item.append(tags, el("div", "url", c.url));

      const actions = el("div", "actions");
      const results = el("div", "results");
      const button = (label, fn) => {
        const b = el("button", null, label);
        b.type = "button";
        b.addEventListener("click", fn);
        actions.append(b);
        return b;
      };
      button("Open in app", () => launch(c.url, "video/*"));
      if (STREAM_MIME[c.kind]) {
        button(`Open in app as ${KIND_LABEL[c.kind]}`, () => launch(c.url, STREAM_MIME[c.kind]));
      }
      button("Copy", async () => {
        try {
          await navigator.clipboard.writeText(c.url);
          showToast("URL copied");
        } catch {
          showToast("Couldn't copy — long-press the URL to select it");
        }
      });
      const test = button("Test", async () => {
        test.disabled = true;
        const steps = await diagnose(c, (s) => renderResults(results, s, false));
        renderResults(results, steps, true);
        log("test", c.url, steps);
        test.disabled = false;
      });
      item.append(actions, results);
      sheet.append(item);
    });
  }
})();
