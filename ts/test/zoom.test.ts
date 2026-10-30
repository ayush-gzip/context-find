import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capturePane, procStart, startInTmux, zoomPane } from "../src/live.ts";

const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

test(
  "Zoom fills the tmux window with a short pane, and Unzoom gives the keyboard back",
  { skip: !hasTmux && "tmux is not installed" },
  () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cfind-zoom-"))),
      socket = "cfind-zoom-" + process.pid,
      prior = process.env.CFIND_TMUX_BIN,
      tmux = join(dir, "tmux");
    // A scratch tmux server: the test never touches the default one.
    writeFileSync(tmux, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o700 });
    process.env.CFIND_TMUX_BIN = tmux;
    const t = (...args: string[]) =>
      spawnSync(tmux, args, { encoding: "utf8" }).stdout.trim();
    try {
      const { pane, pid } = startInTmux(dir, ["sleep", "60"]),
        r = {
          profile: "claude",
          sessionId: "s",
          pid,
          procStart: procStart(pid),
          tmux: pane,
          status: "waiting",
          updatedAt: Date.now(),
        },
        state = (p: string) =>
          t("display-message", "-p", "-t", p, "#{window_zoomed_flag} #{pane_active} #{pane_height}");
      assert.deepEqual(
        { split: capturePane(r).split, zoomed: capturePane(r).zoomed },
        { split: false, zoomed: false },
      );
      // The user's layout: the session's pane is 3 rows, another pane has the keyboard.
      const other = t("split-window", "-d", "-t", pane, "-P", "-F", "#{pane_id}", "sleep", "60");
      t("resize-pane", "-t", pane, "-y", "3");
      t("select-pane", "-t", other);
      assert.equal(state(pane), "0 0 3");
      assert.equal(capturePane(r).split, true);

      zoomPane(r, true);
      const [flag, active, rows] = state(pane).split(" ");
      assert.equal(`${flag} ${active}`, "1 1");
      assert.ok(Number(rows) > 30, `pane is ${rows} rows`);
      assert.equal(capturePane(r).zoomed, true);
      zoomPane(r, true);
      assert.equal(state(pane).split(" ")[0], "1", "a second Zoom keeps it zoomed");

      zoomPane(r, false);
      assert.equal(state(pane), "0 0 3");
      assert.equal(state(other).split(" ")[1], "1", "the keyboard is back on the other pane");

      // The other pane was zoomed by hand: it is zoomed again afterwards.
      t("resize-pane", "-Z", "-t", other);
      zoomPane(r, true);
      assert.equal(state(pane).split(" ").slice(0, 2).join(" "), "1 1");
      zoomPane(r, false);
      assert.equal(state(other).split(" ").slice(0, 2).join(" "), "1 1");
      t("resize-pane", "-Z", "-t", other);

      // A zoom done by hand: Unzoom undoes it and the keyboard stays.
      t("select-pane", "-t", pane);
      t("resize-pane", "-Z", "-t", pane);
      zoomPane(r, false);
      assert.equal(state(pane), "0 1 3");

      // A pane that no longer runs the session is left alone.
      assert.throws(
        () => zoomPane({ ...r, procStart: "Mon Jan 1 00:00:00 2001" }, true),
        /Could not confirm/,
      );
      assert.throws(() => zoomPane({ ...r, tmux: other }, true), /no longer runs/);
      assert.equal(state(other).split(" ")[0], "0");
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
      // tmux leaves the socket file behind when its server is killed.
      rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, socket), { force: true });
      if (prior === undefined) delete process.env.CFIND_TMUX_BIN;
      else process.env.CFIND_TMUX_BIN = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
