# Demo video

Records cfind on made-up data and edits it into a product demo with
[Remotion](https://www.remotion.dev). Nothing here reads a real session: a
throwaway daemon (`harness.mjs`) serves made-up transcripts from its own HOME.

```sh
npm install
npm run demo              # record, then render out/cfind-demo.mp4 and out/cfind-demo-vertical.mp4
npm run record            # only record into public/
npm run render            # only render what is in public/
node demo.mjs --no-phone  # without Xcode: web part only
node demo.mjs --gif       # also out/cfind-demo.gif
npm run studio            # preview and tweak in the browser
```

Needs Node 22+, Google Chrome and ffmpeg. The iPhone part also needs Xcode, a
booted iPhone simulator and the `cfind-apple` repo next to this one (or
`CFIND_APPLE=<path>`, `CFIND_SIM=<udid>`).

How it fits together:

- `record-web.mjs` drives the dashboard in headless Chrome and saves
  `public/web.mp4` plus `public/web.json`: scene marks, mouse moves, clicks,
  typing and scrolls, timed against the video.
- `record-phone.mjs` records the simulator while `testDemo` in cfind-apple
  drives the app, and saves `public/phone.mp4` plus `public/phone.json`.
- `src/` is the edit. The camera zooms to each click and pans between close
  ones (`src/timing.ts`), the cursor is drawn by the edit, and each scene gets
  a title (`TITLES` in `src/parts.tsx`).

Remotion is free for individuals and companies of up to three people; see its
[license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
