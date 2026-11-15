# FirePlayer

A Firefox for Android extension that adds a **FirePlayer** button to a
video once it starts playing, similar to Samsung Internet's video assistant.
Tapping it opens the video in a clean fullscreen player with gesture controls.
Streams that allow it can also be handed to a native Android player (VLC, MX
Player, ...) from the **⋯** panel.

## The player

The site's own `<video>` element is moved into FirePlayer's fullscreen layer
and moved back when you close it. The site keeps loading the stream, so it
works anywhere the video plays in Firefox, including sites that check cookies
or headers, and DRM services.

| Gesture / control | Action |
| --- | --- |
| Tap | Show / hide controls |
| Double-tap left / right | Skip 10 s back / forward (keep tapping to skip more) |
| Double-tap centre | Play / pause |
| Swipe sideways | Scrub (one screen width = 3 minutes, or the whole video if shorter) |
| Press and hold | 2× speed while held |
| `1×` | Cycle speed 0.5× – 2× |
| Corners icon | Zoom to fill / fit to screen |
| Rotate icon | Switch between landscape and portrait lock |
| Back arrow or Android back | Close and return the video to the page |

Opening rotates to match the video and remembers where you stopped; reopening
the same page offers **Resume from …** (videos over a minute long).

Not available from a browser extension: brightness and system-volume swipes,
background playback, and picture-in-picture.

## How it works

- `content.js` listens for `play` on any `<video>` (all frames), shows a
  floating button at the video's bottom-right for 4 seconds, and brings it back
  when you tap the video. Small videos and muted looping "GIF" videos are
  ignored.
- `player.js` is the fullscreen player described above.
- The **⋯** button opens a panel listing every stream found for the page:
  1. the video's own `http(s)` source, or
  2. for `blob:` / Media Source playback, the HLS (`.m3u8`) or DASH (`.mpd`)
     manifest that `background.js` saw the tab download. HLS master playlists
     are listed first so an external player can choose quality.

  Each can be copied, tested (see Debugging below), or opened in another app
  through an Android intent URI
  (`intent://…#Intent;action=android.intent.action.VIEW;type=video/*;S.title=…;end`).

## Installing

### Try it on your phone (development)

1. On the phone: enable Developer options → **USB debugging**, then in Firefox
   go to Settings → **Remote debugging via USB** and turn it on.
2. On the PC: install [Android platform tools](https://developer.android.com/tools/releases/platform-tools)
   so `adb` is on your PATH, plug the phone in and accept the prompt.
3. From this folder:

   ```bash
   adb devices
   ```

   ```bash
   npx web-ext run -t firefox-android --android-device <device-id> --firefox-apk org.mozilla.firefox
   ```

   The extension stays installed until Firefox restarts.

### Keep it installed

Release Firefox only installs extensions signed by Mozilla. Getting one signed
without publishing it (an "unlisted" add-on) is free and usually automatic:

1. Sign in at https://addons.mozilla.org and create API credentials at
   https://addons.mozilla.org/developers/addon/api/key/ (a *JWT issuer* and a
   *JWT secret*).
2. From this folder, sign it. Passing the credentials as environment variables
   keeps them out of the command line (PowerShell shown):

   ```powershell
   $env:WEB_EXT_API_KEY = "<jwt-issuer>"; $env:WEB_EXT_API_SECRET = "<jwt-secret>"
   ```

   ```bash
   npx web-ext sign --channel unlisted
   ```

   The signed file lands in `web-ext-artifacts/`. `web-ext-config.mjs` keeps
   the platform-tools folder out of it.
3. Install the `.xpi` on each device:
   - **Firefox for Android:** copy the file to the phone. In Firefox go to
     Settings → About Firefox, tap the Firefox logo 5 times to turn on the
     debug menu, then back in Settings choose **Install extension from file**.
   - **Desktop Firefox:** `about:addons` → gear icon → **Install Add-on From
     File…**

**Updating:** raise `version` in `manifest.json` (Mozilla won't sign the same
version twice), sign again, and install the new file over the old one on each
device. Unlisted add-ons don't update themselves; publishing a *listed* add-on
on addons.mozilla.org instead (`--channel listed`) gives automatic updates and
a page to install from on any device, but makes it public and goes through
Mozilla's review.

## If "Open in app" does nothing

Firefox only hands links to other apps when Settings → **Open links in apps**
is set to *Ask before opening* or *Always*. Also make sure a video player app
is installed; VLC handles the widest range of streams (including HLS and DASH).

## Debugging a stream that won't play in another app

Most players (Samsung's included) only say "failed to play". Work through
these in order:

1. **Test the stream in FirePlayer.** Tap **⋯** → **Test** on the stream
   marked *Best guess*. It fetches each piece the player would (playlist,
   variant, decryption key, first segment) without the browser's cookies or
   headers, like an external player does. Anything that fails is retried as
   the page to show why:
   - ✗ with *as page: 200* → the site requires its cookies, `Referer` or
     `Origin`. No external player can play it from a link.
   - ✗ both ways → the link expired or was single-use. Reload the page, play
     again, and retest.
   - all ✓ → the stream is reachable, so the player is the problem. Try
     **Open in app as HLS/DASH** (sends the stream's real MIME type instead of
     `video/*`) or open it in VLC.
   - Wrong stream picked (an ad, a preview)? Try the other entries in the list.

   Testing makes real requests, so a single-use link may stop working after
   it. Reload the page before opening it.

2. **Use VLC for real error messages.** VLC → Settings → Advanced → enable
   **Debug logs**, reproduce the failure, then read the log there. Or use
   **Copy** in the panel and paste the URL into VLC → More → **New stream**.

3. **Read the player's errors from the phone log.** With USB debugging on:

   ```bash
   ./platform-tools-latest-windows/platform-tools/adb logcat -c
   ```

   ```bash
   ./platform-tools-latest-windows/platform-tools/adb logcat *:W
   ```

   Reproduce the failure and look for lines with HTTP status codes
   (`403`, `404`), `MediaPlayer`, `ExoPlayer` or `Source error`.

4. **Read FirePlayer's own log.** On desktop Firefox open `about:debugging`,
   connect the phone under **Setup → USB devices**, then **Inspect** the tab.
   Messages prefixed `[FirePlayer]` show the candidates, the URL handed off and
   test results.

## Limitations

The FirePlayer player works on any video that plays in Firefox. These limits
apply to **Open in app** only:

- **DRM video** (Netflix, Disney+, Prime Video, ...) can't leave the browser.
- **YouTube** and other sites that stream raw segments without a manifest give
  nothing a player can open on its own.
- Streams that need the site's cookies, `Referer` or auth headers fail in
  the external player, because the player fetches the URL itself.
- The playback position isn't passed on; the app starts from the beginning.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (Manifest V2, Firefox 120+ on Android) |
| `background.js` | Records HLS/DASH manifests and media files each tab downloads |
| `player.js` | Fullscreen player with gesture controls |
| `content.js` | Overlay button, intent hand-off and diagnostics panel |
| `icons/icon.svg` | Extension icon |
| `web-ext-config.mjs` | Keeps `platform-tools` out of the packaged extension |
