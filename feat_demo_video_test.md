# Demo video as code: test results

Date: 2026-11-05 (Asia/Kolkata). Branch `demo-video`. Linear STUB-128.

## What it is

`demo/video/` records cfind on made-up data and edits it with Remotion into
`out/cfind-demo.mp4` (1920x1080) and `out/cfind-demo-vertical.mp4` (1080x1920).
See `demo/video/README.md`.

## Setup and commands

```sh
cd demo/video
npm install
npm run demo        # record + render, about 8 minutes on an M-series Mac
npm run record      # harness + web + iPhone recordings into public/
npm run render      # both videos from public/
node demo.mjs --no-phone   # without Xcode
```

- Node 24, Google Chrome (Playwright `channel: "chrome"`), system ffmpeg.
- iPhone part: Xcode 27 (`DEVELOPER_DIR` defaults to /Applications/Xcode.app),
  a booted iPhone simulator (`CFIND_SIM=<udid>` to pick one), the cfind-apple
  repo next to this one (`CFIND_APPLE=<path>`). Its `testDemo` must exist.
- The harness runs the daemon from `ts/src` through `ts/test/typescript-loader.mjs`
  with its own HOME, data dir and port. It never reads ~/.claude* or the real daemon.

## Cases

| # | Case | Expect | Result |
|---|---|---|---|
| D1 | `npm run record` | web.mp4/json and phone.mp4/json in public/ | Pass: web 36.7 s, 7 clicks, 1 typing; phone 39.4 s, 8 taps |
| D2 | Web frames sharp at 1.55x zoom | 2880x1620 source | Fail at first: CDP screencast gave 1440x810 with deviceScaleFactor 2. Fix: launch Chrome with `--force-device-scale-factor=2` and set `Emulation.setDeviceMetricsOverride` again. Pass: 2880x1620 |
| D3 | Frame list for ffmpeg concat | no negative durations | Fail once: the first two screencast frames came out of order (duration -0.02, ffmpeg "Invalid data"). Fix: sort frames by timestamp. Pass |
| D4 | Phone clip lines up with test events | scene titles match screens, no home screen | Fail at first: "Recording started" is not video time 0; simctl's clock skipped part of the idle wait before the app launched, so the clip ran 4.6 s late and ended on the home screen (real app icons). Fix: the test prints `sync`, the recorder flips the simulator to dark mode for 0.6 s at a noted time, and the first dark frame (YAVG < 80 after > 150) ties the clocks. Pass: 1 fps contact sheet shows sessions 0-4 s, chat 5-11 s, follow-up 13-31 s, usage 33-39 s, no home screen |
| D5 | Camera zooms land on click targets | zoom centers on the clicked control | Pass by eye on stills (search field, submit, agent card, answer option) |
| D6 | Click that changes the page | camera leaves the old spot soon | Partly: after "Glass lens" the card is gone and the zoom shows empty space for about 1 s. Hold cut from 1.4 s to 1.2 s and zoom-out from 0.9 s to 0.8 s |
| D7 | 9:16 layout | page readable, not a small wide window | Fail at first: 1000 px wide window in a 1920 px tall frame. Fix: tall window (1000x1180), page covers its height, camera trails the cursor when not zoomed. Pass |
| D8 | No real data in any frame | made-up names only | Pass on the 16:9 and 9:16 contact sheets (1 frame per 2-3 s) |
| D9 | Render | both files, same length | Pass: 80.8 s each, about 7-8 MB |

Not done yet: frame-hash repeatability check, README GIF (`--gif`), music.

## Before touching this again

- Re-run `npm run demo`, then make contact sheets:
  `ffmpeg -i out/cfind-demo.mp4 -vf "fps=1/2,scale=320:-1,tile=7x6" -frames:v 1 sheet.png`
  and the same for the phone clip at 1 fps. Look for the home screen, cut text and
  zooms on empty space.
- If the dashboard markup changes, check the selectors in `record-web.mjs`
  (`.nav-item[data-page=...]`, `#session-q`, `#session-search button[type=submit]`,
  `tr[data-path]`, `#chat-list`, `.agent-card[data-agent=...]`, `.ask-option[data-label=...]`).
- If the iPhone UI changes, check `testDemo` in cfind-apple (texts "open a pull
  request", "release notes", ids `composer`, `send`).
- `still` renders take about 30 s each; render a few frames before a full render.
