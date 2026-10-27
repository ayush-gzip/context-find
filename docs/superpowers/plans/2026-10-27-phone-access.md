# cfind for iPhone: plan

Status: proposal, waiting for approval. Date: 2026-10-27.
Decision so far (user): a native Swift app, installed only on the user's own iPhone. No
App Store.

## Goal

From the iPhone, while the Mac runs the dashboard daemon: see sessions and agents, read
chats live, send messages and images, answer approval and question cards, stop agents,
start a new agent. The same things the browser dashboard does now.

## What is true today

- The daemon listens on `127.0.0.1:4319` only. Every request checks the Host header and
  a per-run token in the URL (`?t=`). Nothing outside the Mac can reach it.
- The daemon already has a JSON and live-event API that the browser uses:
  `/api/events` (live snapshot), `/api/conversation`, `/api/agent` (create, send,
  live-send, respond, cancel, unqueue, takeover, dismiss), `/api/upload`. The iPhone app
  is a second client of this API. No agent logic moves to the phone.
- This Mac: Xcode 27.1 with iOS 27 simulators. `xcode-select` points at the command line
  tools, so builds use `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
  Tailscale is not installed. No iPhone is connected now.
- Risk: whoever can use this API can run agents that run shell commands on the Mac. The
  phone is a remote control for the Mac. Design for that.

## Design

### 1. Network: Tailscale

- `tailscale serve --bg 4319` gives `https://<mac>.<tailnet>.ts.net` with a real TLS
  certificate and forwards to `127.0.0.1:4319`. Only devices in your tailnet reach it.
  No port opens on Wi-Fi or the internet. The daemon still binds to 127.0.0.1 only.
- Works at home and away. A real certificate means no iOS security exceptions in the app.
- Rejected: home Wi-Fi only with Bonjour. It needs self-signed TLS with pinning, opens a
  port on the LAN, and fails away from home.
- The daemon accepts exactly one extra host name (saved when you turn phone access on).
- To verify before building: the Host header `serve` forwards, and its identity header
  (`Tailscale-User-Login`) as an extra check.

### 2. Pairing and auth

- Mac dashboard, Connections > iPhone > "Pair": shows a link
  `cfind://pair?host=<ts.net name>&code=<one-time code>`. Single use, expires in 5 min.
- iPhone: open the app, tap "Paste pairing link" (Universal Clipboard brings it over
  from the Mac), or type the host and the 6-digit code.
- The app trades the code for a device token. The token lives in the iPhone Keychain and
  goes in an `Authorization: Bearer` header. The daemon keeps only a hash in
  `~/.context-find/dashboard/devices.json` (0600) with name, created, last seen.
- Mac dashboard lists paired devices with Revoke. Lost phone: revoke here and remove it
  from Tailscale.
- Pairing attempts are rate limited. The per-run URL token works on 127.0.0.1 only.
- QR scan instead of paste: possible later (needs a QR encoder on the Mac side).

### 3. The app (SwiftUI)

- Folder `ios/` in this repo. One app target, iOS 17 or later. No third-party packages.
- Project file: minimal hand-written `.xcodeproj` that uses a folder-synced group, so
  new Swift files are picked up without editing the project. No XcodeGen install.
- Screens:
  - Sessions: needs-input and running first, then recent; search; profile filter.
  - Chat: agent left, you right; Markdown (inline with `AttributedString`, code blocks
    with copy); tool rows that expand; images; approval and question cards with buttons;
    message box with photo picker and camera; Send, Stop, Take over, queue edits.
  - Agents: dashboard agents and their state; New agent (profile, folder, prompt).
  - Limits: session and weekly remaining per profile.
  - Settings: paired Mac, unpair.
- Live updates: one `/api/events` stream with reconnect and backoff. The daemon already
  sends a full snapshot on reconnect.
- Sends carry a client id, so a retry after a network drop does not send twice.
- Light and dark follow the phone. Style: native iOS (system fonts, lists, sheets).

### 4. Notifications (phase 2, needs a paid account)

- "Needs approval", "Reply finished", "Agent failed". iOS suspends apps in the
  background, so these need Apple push (APNs). The daemon would send them itself with an
  APNs key from your developer account. Not possible with a free Apple ID.

## Apple account: free vs paid

| | Free Apple ID | Paid developer ($99/yr) |
| --- | --- | --- |
| Install on your iPhone from Xcode | yes | yes |
| App keeps working | 7 days, then reinstall from Xcode | 1 year |
| Push notifications | no | yes |

## Failure modes

- Mac asleep: phone cannot reach it. Fix with macOS settings (prevent sleep on power
  adapter). The app says "Mac is not reachable", not a blank screen.
- Tailscale off on either side: same message.
- Network drop mid-send: client id makes the retry safe.
- Daemon restart: the device token still works.
- API change on the Mac breaks the app: a contract test in the Node suite pins the JSON
  shapes the app reads.

## Build steps (after approval)

1. Notion test plan, section K, on the context-find plan page.
2. Server: tailnet host, device store, pairing, bearer auth, rate limit, revoke, client
   ids. Tests first (wrong host refused, URL token refused off 127.0.0.1, code single use
   and expiry, revoked device refused, contract shapes).
3. App: pairing, sessions, chat, composer, cards, agents, limits.
4. Test in the iOS simulator against the real daemon with XCUITest (pair, send, answer an
   approval, image). I can run all of this myself.
5. Real iPhone: you install Tailscale on Mac and iPhone, sign in to Xcode with your Apple
   ID, connect the iPhone once by cable, turn on Developer Mode. I build and install.
6. Phase 2 push, only with a paid account.
