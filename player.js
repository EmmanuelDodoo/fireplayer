"use strict";

// Full-screen player that takes over the page's own <video> element. The
// site's player keeps loading the stream, so its cookies, headers and DRM all
// still work; we only move the element into our own fullscreen container and
// draw native-style controls and gestures on top. Closing puts it back.

(() => {
  if (window.__fireplayerStage) return;

  const SKIP_SECONDS = 10;
  const DOUBLE_TAP_MS = 300;
  const LONG_PRESS_MS = 450;
  const HIDE_CONTROLS_MS = 3000;
  const DRAG_THRESHOLD = 15;
  // One screen-width swipe seeks this far (or the whole video, if shorter).
  const SWIPE_SPAN_SECONDS = 180;
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const MAX_SAVED_POSITIONS = 200;

  const ICONS = {
    back: "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z",
    play: "M8 5v14l11-7z",
    pause: "M6 5h4v14H6zm8 0h4v14h-4z",
    rewind: "M11 18V6l-8.5 6zm.5-6 8.5 6V6z",
    forward: "M4 18l8.5-6L4 6zm9-12v12l8.5-6z",
    fit: "M3 5v4h2V7h2V5zm16 0h-4v2h2v2h2zM5 15H3v4h4v-2H5zm14 2h-2v2h4v-4h-2z",
    rotate: "M16.5 2.5A10 10 0 0 1 22 11h1.5A11.5 11.5 0 0 0 12.7.5zM7.5 21.5A10 10 0 0 1 2 13H.5a11.5 11.5 0 0 0 10.8 10.5zM14.1 3.5l6.4 6.4c.6.6.6 1.5 0 2.1L12 20.5c-.6.6-1.5.6-2.1 0l-6.4-6.4c-.6-.6-.6-1.5 0-2.1L12 3.5c.6-.6 1.5-.6 2.1 0zM13 5.6 5.6 13l5.4 5.4 7.4-7.4z",
  };
  function icon(name) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", ICONS[name]);
    svg.append(path);
    return svg;
  }

  // Applied with !important so the site's own video CSS can't fight it.
  const VIDEO_STYLE = {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    "max-width": "none",
    "max-height": "none",
    "min-width": "0",
    "min-height": "0",
    margin: "0",
    padding: "0",
    border: "0",
    transform: "none",
    "object-fit": "contain",
    background: "#000",
    visibility: "visible",
    opacity: "1",
  };

  let current = null;

  const log = (...args) => console.info("[FirePlayer]", ...args);

  function fmt(sec) {
    if (!Number.isFinite(sec)) return "LIVE";
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // --- Remembered positions --------------------------------------------------

  const pageKey = () => location.origin + location.pathname + location.search;

  async function loadPosition() {
    try {
      const { positions = {} } = await browser.storage.local.get("positions");
      return positions[pageKey()] || null;
    } catch {
      return null;
    }
  }

  async function savePosition(v) {
    if (!Number.isFinite(v.duration) || v.duration < 60) return;
    try {
      const { positions = {} } = await browser.storage.local.get("positions");
      const key = pageKey();
      if (v.currentTime < 15 || v.currentTime > v.duration - 15) {
        delete positions[key];
      } else {
        positions[key] = { t: v.currentTime, d: v.duration, at: Date.now() };
      }
      const keys = Object.keys(positions);
      if (keys.length > MAX_SAVED_POSITIONS) {
        keys.sort((a, b) => positions[a].at - positions[b].at);
        for (const k of keys.slice(0, keys.length - MAX_SAVED_POSITIONS)) delete positions[k];
      }
      await browser.storage.local.set({ positions });
    } catch {}
  }

  // --- Open / close -----------------------------------------------------------

  // Moving a media element out of the document and back in the same task
  // keeps it playing, but nudge it in case the browser paused it anyway.
  function keepPlaying(v, wasPlaying) {
    if (wasPlaying) setTimeout(() => v.paused && v.play().catch(() => {}), 0);
  }

  function lockOrientation(v, mode) {
    const o = screen.orientation;
    if (!o || !o.lock) return;
    const want = mode || (v.videoHeight > v.videoWidth ? "portrait" : "landscape");
    o.lock(want).catch(() => {});
    return want;
  }

  // Some site players leave fullscreen when the phone turns to portrait, or
  // take it for their own element, which would close FirePlayer. While it is
  // open, the page's calls to the fullscreen API do nothing. Our own calls go
  // through Firefox's Xray wrappers, which always see the real methods.
  const FULLSCREEN_METHODS = [
    ["Document", ["exitFullscreen", "mozCancelFullScreen", "webkitExitFullscreen"]],
    ["Element", ["requestFullscreen", "mozRequestFullScreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]],
  ];

  function blockPageFullscreen() {
    if (typeof exportFunction !== "function") return () => {};
    const pageWin = window.wrappedJSObject;
    const restores = [];
    for (const [iface, names] of FULLSCREEN_METHODS) {
      const proto = pageWin[iface].prototype;
      for (const name of names) {
        if (!(name in proto)) continue;
        const original = proto[name];
        proto[name] = exportFunction(() => {
          log(`ignored the page's ${name}() call`);
          return pageWin.Promise.resolve();
        }, pageWin);
        restores.push(() => {
          proto[name] = original;
        });
      }
    }
    return () => restores.forEach((restore) => restore());
  }

  // Same idea for speed: while FirePlayer is open, the page's own writes to
  // this video's playbackRate are dropped (other videos are unaffected).
  function blockPageRate(v) {
    if (typeof exportFunction !== "function") return () => {};
    try {
      const pageWin = window.wrappedJSObject;
      const proto = pageWin.HTMLMediaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "playbackRate");
      const pageVideo = v.wrappedJSObject;
      Object.defineProperty(proto, "playbackRate", {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: exportFunction(function (value) {
          if (this === pageVideo || this === v) {
            log(`ignored the page setting speed to ${value}×`);
            return;
          }
          desc.set.call(this, value);
        }, pageWin),
      });
      return () => Object.defineProperty(proto, "playbackRate", desc);
    } catch (e) {
      log("couldn't guard playback speed", e);
      return () => {};
    }
  }

  function open(v) {
    if (current || !v.parentNode) return;

    const stage = document.createElement("fireplayer-stage");
    stage.style.cssText =
      "all: initial; position: fixed; inset: 0; z-index: 2147483647; display: block; background: #000;";
    const root = stage.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .wrap {
          position: absolute;
          inset: 0;
          overflow: hidden;
          font: 400 14px/1.3 system-ui, sans-serif;
          color: #fff;
          -webkit-tap-highlight-color: transparent;
          user-select: none;
        }
        .gest { position: absolute; inset: 0; touch-action: none; }
        button {
          display: grid;
          place-items: center;
          min-width: 44px;
          height: 44px;
          padding: 0 10px;
          border: 0;
          border-radius: 22px;
          color: inherit;
          font: inherit;
          font-weight: 600;
          background: transparent;
          cursor: pointer;
        }
        button:active { background: rgba(255, 255, 255, 0.15); }
        svg { width: 24px; height: 24px; fill: currentColor; }

        .ui { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity 0.2s; }
        .ui.on { opacity: 1; }
        .ui.on button, .ui.on input { pointer-events: auto; }
        .top, .bottom {
          position: absolute;
          left: 0;
          right: 0;
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 8px max(8px, env(safe-area-inset-right)) 8px max(8px, env(safe-area-inset-left));
        }
        .top { top: 0; background: linear-gradient(rgba(0, 0, 0, 0.7), transparent); }
        .bottom { bottom: 0; padding-bottom: max(12px, env(safe-area-inset-bottom)); background: linear-gradient(transparent, rgba(0, 0, 0, 0.7)); }
        .title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
        .mid {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%);
          display: flex;
          align-items: center;
          gap: 40px;
        }
        .mid button { width: 56px; height: 56px; border-radius: 50%; background: rgba(0, 0, 0, 0.35); }
        .mid .play { width: 72px; height: 72px; }
        .mid .play svg { width: 40px; height: 40px; }
        .time { flex: none; font-variant-numeric: tabular-nums; font-size: 13px; padding: 0 6px; }
        .seek { flex: 1; min-width: 0; height: 32px; margin: 0; accent-color: #ff7139; }
        .live .seek, .live .rew, .live .fwd { visibility: hidden; }

        .hint, .flash, .resume, .spinner { position: absolute; pointer-events: none; }
        .hint {
          left: 50%;
          top: 18%;
          transform: translateX(-50%);
          padding: 8px 14px;
          border-radius: 8px;
          background: rgba(0, 0, 0, 0.6);
          font-size: 16px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          display: none;
        }
        .hint.on { display: block; }
        .flash {
          top: 0;
          bottom: 0;
          width: 38%;
          display: grid;
          place-items: center;
          font-size: 20px;
          font-weight: 700;
          text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
          background: rgba(255, 255, 255, 0.15);
          opacity: 0;
          transition: opacity 0.25s;
        }
        .flash.left { left: 0; border-radius: 0 50% 50% 0; }
        .flash.right { right: 0; border-radius: 50% 0 0 50%; }
        .flash.on { opacity: 1; }
        .resume { left: 16px; bottom: 76px; display: none; }
        .resume.on { display: block; }
        .resume button { pointer-events: auto; background: rgba(30, 30, 30, 0.9); border: 1px solid rgba(255, 255, 255, 0.25); }
        .spinner {
          left: 50%;
          top: 50%;
          width: 48px;
          height: 48px;
          margin: -24px 0 0 -24px;
          border: 4px solid rgba(255, 255, 255, 0.25);
          border-top-color: #fff;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          display: none;
        }
        .spinner.on { display: block; }
        @keyframes spin { to { transform: rotate(360deg); } }
      </style>
      <div class="wrap">
        <slot></slot>
        <div class="gest"></div>
        <div class="flash left"></div>
        <div class="flash right"></div>
        <div class="spinner"></div>
        <div class="hint"></div>
        <div class="ui on">
          <div class="top">
            <button class="close" aria-label="Close player"><i data-icon="back"></i></button>
            <div class="title"></div>
            <button class="speed" aria-label="Playback speed">1×</button>
            <button class="fit" aria-label="Zoom to fill"><i data-icon="fit"></i></button>
            <button class="rotate" aria-label="Rotate"><i data-icon="rotate"></i></button>
          </div>
          <div class="mid">
            <button class="rew" aria-label="Skip back"><i data-icon="rewind"></i></button>
            <button class="play" aria-label="Play or pause"><i data-icon="pause"></i></button>
            <button class="fwd" aria-label="Skip forward"><i data-icon="forward"></i></button>
          </div>
          <div class="bottom">
            <span class="time cur">0:00</span>
            <input class="seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek">
            <span class="time dur">0:00</span>
          </div>
        </div>
        <div class="resume"><button type="button"></button></div>
      </div>
    `;
    for (const slot of root.querySelectorAll("[data-icon]")) slot.replaceWith(icon(slot.dataset.icon));
    const $ = (sel) => root.querySelector(sel);

    const placeholder = document.createComment("fireplayer");
    const wasPlaying = !v.paused;
    const ac = new AbortController();
    const on = (target, type, fn, opts) => target.addEventListener(type, fn, { signal: ac.signal, ...opts });

    current = {
      v,
      stage,
      placeholder,
      ac,
      style: v.getAttribute("style"),
      controls: v.controls,
      defaultRate: v.defaultPlaybackRate,
      fullscreen: false,
      rotatedAt: -Infinity,
      timers: new Set(),
      unblockFullscreen: blockPageFullscreen(),
      unblockRate: blockPageRate(v),
    };

    v.parentNode.insertBefore(placeholder, v);
    document.documentElement.appendChild(stage);
    stage.appendChild(v);
    v.controls = false;
    for (const [k, val] of Object.entries(VIDEO_STYLE)) v.style.setProperty(k, val, "important");
    keepPlaying(v, wasPlaying);

    // Fullscreen needs the tap that opened us, so request it right away. If
    // the site's own player was fullscreen, leave that first.
    const enter = () =>
      stage.requestFullscreen({ navigationUI: "hide" }).then(() => {
        if (current && current.stage === stage) {
          current.fullscreen = true;
          current.orientation = lockOrientation(v);
        }
      });
    (document.fullscreenElement ? document.exitFullscreen().then(enter) : enter()).catch(() => {});

    on(document, "fullscreenchange", () => {
      if (!current || !current.fullscreen || document.fullscreenElement === stage) return;
      // Fullscreen lost right after our rotate button: something other than
      // the user (likely the site, through a path we couldn't block) left it.
      // The rotate tap still counts as user activation, so take it back.
      if (performance.now() - current.rotatedAt < 4000) {
        log("fullscreen lost after rotating, re-entering");
        stage
          .requestFullscreen({ navigationUI: "hide" })
          .then(() => current && lockOrientation(v, current.orientation))
          .catch(close);
        return;
      }
      close();
    });

    // --- Controls ---------------------------------------------------------

    const ui = $(".ui");
    const playBtn = $(".play");
    const seek = $(".seek");
    const cur = $(".cur");
    const dur = $(".dur");
    const hint = $(".hint");
    const spinner = $(".spinner");
    const wrap = $(".wrap");
    $(".title").textContent = document.title;

    let hideTimer = 0;
    function showControls() {
      ui.classList.add("on");
      clearTimeout(hideTimer);
      if (!v.paused) hideTimer = setTimeout(() => ui.classList.remove("on"), HIDE_CONTROLS_MS);
    }
    function toggleControls() {
      if (ui.classList.contains("on")) {
        clearTimeout(hideTimer);
        ui.classList.remove("on");
      } else {
        showControls();
      }
    }

    let hintTimer = 0;
    function showHint(text, ms) {
      hint.textContent = text;
      hint.classList.add("on");
      clearTimeout(hintTimer);
      if (ms) hintTimer = setTimeout(() => hint.classList.remove("on"), ms);
    }

    let dragging = false;
    let shownPaused = null;
    function render() {
      const live = !Number.isFinite(v.duration);
      wrap.classList.toggle("live", live);
      cur.textContent = fmt(v.currentTime);
      dur.textContent = fmt(v.duration);
      if (!live && !dragging && v.duration > 0) seek.value = String(Math.round((v.currentTime / v.duration) * 1000));
      if (shownPaused !== v.paused) {
        shownPaused = v.paused;
        playBtn.replaceChildren(icon(v.paused ? "play" : "pause"));
      }
    }

    function togglePlay() {
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }

    function seekTo(t) {
      if (!Number.isFinite(v.duration)) return;
      v.currentTime = Math.min(Math.max(t, 0), v.duration);
      render();
    }

    on(v, "timeupdate", render);
    on(v, "durationchange", render);
    on(v, "play", () => { render(); showControls(); });
    on(v, "pause", () => { render(); showControls(); });
    on(v, "waiting", () => spinner.classList.add("on"));
    for (const type of ["playing", "canplay", "seeked", "pause"]) {
      on(v, type, () => spinner.classList.remove("on"));
    }
    // Site players often force their own speed back (on ratechange, or when
    // they reload the source), so keep re-applying the one picked here. The
    // cap stops a tug-of-war if the site insists.
    let wantRate = v.playbackRate;
    let fights = 0;
    let fightWindow = 0;
    function setRate(rate) {
      wantRate = rate;
      v.defaultPlaybackRate = rate;
      v.playbackRate = rate;
    }
    function holdRate() {
      if (v.playbackRate === wantRate) return false;
      const now = performance.now();
      if (now - fightWindow > 1000) {
        fightWindow = now;
        fights = 0;
      }
      if (fights++ >= 10) return false;
      log(`site changed speed to ${v.playbackRate}×, restoring ${wantRate}×`);
      v.playbackRate = wantRate;
      return true;
    }
    on(v, "ratechange", () => {
      if (holdRate()) return;
      $(".speed").textContent = `${v.playbackRate}×`;
    });
    for (const type of ["loadedmetadata", "playing", "seeked"]) on(v, type, holdRate);

    // Keep taps on the overlay away from the site's own click/touch handlers,
    // and stop long-press from opening Firefox's context menu.
    const wrapEl = $(".wrap");
    for (const type of ["click", "dblclick", "pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"]) {
      on(wrapEl, type, (e) => e.stopPropagation());
    }
    on(wrapEl, "contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    on($(".close"), "click", close);
    on(playBtn, "click", () => { togglePlay(); showControls(); });
    on($(".rew"), "click", () => { seekTo(v.currentTime - SKIP_SECONDS); showControls(); });
    on($(".fwd"), "click", () => { seekTo(v.currentTime + SKIP_SECONDS); showControls(); });
    on($(".speed"), "click", () => {
      const i = SPEEDS.indexOf(wantRate);
      setRate(i < 0 ? 1 : SPEEDS[(i + 1) % SPEEDS.length]);
      showHint(`${wantRate}× speed`, 800);
      showControls();
    });
    on($(".fit"), "click", () => {
      const fill = v.style.getPropertyValue("object-fit") !== "cover";
      v.style.setProperty("object-fit", fill ? "cover" : "contain", "important");
      showHint(fill ? "Zoom to fill" : "Fit to screen", 800);
      showControls();
    });
    on($(".rotate"), "click", () => {
      current.rotatedAt = performance.now();
      const next = current.orientation === "portrait" ? "landscape" : "portrait";
      current.orientation = lockOrientation(v, next) || current.orientation;
      showControls();
    });
    on(seek, "input", () => {
      dragging = true;
      const t = (Number(seek.value) / 1000) * v.duration;
      cur.textContent = fmt(t);
      showHint(`${fmt(t)} / ${fmt(v.duration)}`);
      clearTimeout(hideTimer);
    });
    on(seek, "change", () => {
      dragging = false;
      seekTo((Number(seek.value) / 1000) * v.duration);
      hint.classList.remove("on");
      showControls();
    });

    // --- Gestures -----------------------------------------------------------
    // Tap: show/hide controls. Double-tap left/right: skip back/forward (keep
    // tapping to skip further). Double-tap centre: play/pause. Swipe sideways:
    // scrub. Long-press: 2× speed while held.

    const gest = $(".gest");
    const flashes = { left: $(".flash.left"), right: $(".flash.right") };
    let press = null;
    let lastTap = { t: 0, zone: null };
    let tapTimer = 0;
    let skipTotal = 0;
    let skipTimer = 0;

    function zoneAt(x) {
      const w = gest.clientWidth;
      return x < w / 3 ? "left" : x > (2 * w) / 3 ? "right" : "center";
    }

    function skip(zone) {
      const dir = zone === "left" ? -1 : 1;
      seekTo(v.currentTime + dir * SKIP_SECONDS);
      skipTotal += SKIP_SECONDS;
      const el = flashes[zone];
      el.textContent = `${dir < 0 ? "−" : "+"}${skipTotal}s`;
      el.classList.add("on");
      clearTimeout(skipTimer);
      skipTimer = setTimeout(() => {
        skipTotal = 0;
        flashes.left.classList.remove("on");
        flashes.right.classList.remove("on");
      }, 700);
    }

    function onTap(x) {
      const zone = zoneAt(x);
      const now = performance.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && zone === lastTap.zone) {
        clearTimeout(tapTimer);
        if (zone === "center") togglePlay();
        else skip(zone);
      } else {
        if (lastTap.zone !== zone) skipTotal = 0;
        tapTimer = setTimeout(toggleControls, DOUBLE_TAP_MS);
      }
      lastTap = { t: now, zone };
    }

    on(gest, "pointerdown", (e) => {
      if (!e.isPrimary) return;
      try {
        gest.setPointerCapture(e.pointerId);
      } catch {}
      press = { x: e.clientX, y: e.clientY, start: v.currentTime, mode: null, target: 0, rate: wantRate };
      press.longTimer = setTimeout(() => {
        if (!press || press.mode) return;
        press.mode = "fast";
        setRate(2);
        showHint("2× speed ▸▸");
      }, LONG_PRESS_MS);
    });

    on(gest, "pointermove", (e) => {
      if (!press || !e.isPrimary) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.mode && Math.abs(dx) > DRAG_THRESHOLD && Math.abs(dx) > Math.abs(dy) && Number.isFinite(v.duration)) {
        press.mode = "scrub";
        clearTimeout(press.longTimer);
      }
      if (press.mode === "scrub") {
        const span = Math.min(v.duration, SWIPE_SPAN_SECONDS);
        press.target = Math.min(Math.max(press.start + (dx / gest.clientWidth) * span, 0), v.duration);
        const delta = press.target - press.start;
        showHint(`${delta < 0 ? "−" : "+"}${fmt(Math.abs(delta))}  ·  ${fmt(press.target)} / ${fmt(v.duration)}`);
      } else if (!press.mode && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        clearTimeout(press.longTimer);
        press.mode = "ignore";
      }
    });

    function endPress(e, cancelled) {
      if (!press || !e.isPrimary) return;
      clearTimeout(press.longTimer);
      if (press.mode === "fast") {
        setRate(press.rate);
        hint.classList.remove("on");
      } else if (press.mode === "scrub") {
        if (!cancelled) seekTo(press.target);
        hint.classList.remove("on");
      } else if (!press.mode && !cancelled) {
        onTap(e.clientX - gest.getBoundingClientRect().left);
      }
      press = null;
    }
    on(gest, "pointerup", (e) => endPress(e, false));
    on(gest, "pointercancel", (e) => endPress(e, true));

    // --- Resume -------------------------------------------------------------

    const resume = $(".resume");
    loadPosition().then((saved) => {
      if (!saved || current?.v !== v || Math.abs(saved.t - v.currentTime) < 15) return;
      const btn = resume.querySelector("button");
      btn.textContent = `Resume from ${fmt(saved.t)}`;
      resume.classList.add("on");
      on(btn, "click", () => {
        seekTo(saved.t);
        resume.classList.remove("on");
      });
      current.timers.add(setTimeout(() => resume.classList.remove("on"), 8000));
    });
    current.timers.add(setInterval(() => savePosition(v), 5000));

    render();
    showControls();
  }

  function close() {
    const c = current;
    if (!c) return;
    current = null;
    const { v, stage, placeholder } = c;

    savePosition(v);
    c.ac.abort();
    for (const t of c.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    try {
      screen.orientation.unlock();
    } catch {}

    const wasPlaying = !v.paused;
    if (c.style == null) v.removeAttribute("style");
    else v.setAttribute("style", c.style);
    v.controls = c.controls;
    v.defaultPlaybackRate = c.defaultRate;
    if (placeholder.isConnected) placeholder.replaceWith(v);
    else v.remove(); // the site threw away the spot the video came from
    keepPlaying(v, wasPlaying && v.isConnected);

    if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
    stage.remove();
    c.unblockFullscreen();
    c.unblockRate();
  }

  window.__fireplayerStage = {
    open,
    close,
    isOpen: () => current !== null,
  };
})();
