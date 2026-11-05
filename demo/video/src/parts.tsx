import type { FC } from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { cameraAt, cameraKeys, cursorAt, cursorTrail, presses, scenes, type Take } from "./timing";
import { BRAND, Cursor, INK, MUTED, Ripple, Window, Words } from "./ui";

const TITLES: Record<string, string> = {
  overview: "Every agent, at a glance.",
  search: "Search inside every reply.",
  chat: "Read any session as a chat.",
  ask: "An agent asks. You answer in one click.",
  sessions: "The chats that need you come first.",
  "phone-chat": "Chats that read like Messages.",
  "follow-up": "Send a follow-up from anywhere.",
  usage: "See what is left of your limit.",
};

/** One title per scene, each coming in on its scene mark. */
const SceneTitles: FC<{ take: Take; prefix?: string; style: React.CSSProperties }> = ({ take, prefix = "", style }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {scenes(take).map((s) => {
        const text = TITLES[prefix + s.id] ?? TITLES[s.id];
        const len = Math.max(1, Math.round((s.to - s.from) * fps));
        return text ? (
          <Sequence key={s.id + s.from} from={Math.round(s.from * fps)} durationInFrames={len} layout="none">
            <Words text={text} delay={4} exitAt={len} style={style} />
          </Sequence>
        ) : null;
      })}
    </>
  );
};

const Logo: FC<{ size: number; delay?: number }> = ({ size, delay = 0 }) => {
  const frame = useCurrentFrame(), { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.8 } });
  return (
    <Img
      src={staticFile("logo.png")}
      style={{ width: size, height: size, opacity: Math.min(1, s * 1.5), transform: `scale(${0.6 + 0.4 * s})`, filter: "drop-shadow(0 24px 50px rgba(120,90,255,0.35))" }}
    />
  );
};

export const Intro: FC<{ vertical: boolean }> = ({ vertical }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", color: INK }}>
    <Logo size={vertical ? 260 : 210} />
    <Words text="cfind" delay={8} style={{ fontSize: vertical ? 150 : 130, fontWeight: 700, letterSpacing: "-0.04em", margin: "28px 0 10px" }} />
    <Words
      text="Every Claude Code and Codex session. One place."
      delay={18}
      style={{ fontSize: vertical ? 56 : 46, color: MUTED, maxWidth: vertical ? 860 : 1400, lineHeight: 1.25 }}
    />
  </AbsoluteFill>
);

export const Outro: FC<{ vertical: boolean }> = ({ vertical }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center", color: INK }}>
    <Logo size={vertical ? 220 : 170} />
    <Words text="cfind" delay={6} style={{ fontSize: vertical ? 130 : 108, fontWeight: 700, letterSpacing: "-0.04em", margin: "24px 0 12px" }} />
    <Words
      text="Search, read and answer your agents. On your Mac, the web and your iPhone."
      delay={14}
      style={{ fontSize: vertical ? 50 : 40, color: MUTED, maxWidth: vertical ? 860 : 1100, lineHeight: 1.3, marginBottom: 40 }}
    />
    <Words text="github.com/ayush-gzip/context-find" delay={30} style={{ fontSize: vertical ? 44 : 34, fontWeight: 600, color: BRAND }} />
  </AbsoluteFill>
);

/** The dashboard in a window, with the camera following the clicks. In 9:16
 *  the window is tall, the page fills its height, and the camera trails the
 *  cursor when it is not zoomed in on a click. */
export const WebPart: FC<{ take: Take; vertical: boolean }> = ({ take, vertical }) => {
  const frame = useCurrentFrame(), { fps, width: W } = useVideoConfig();
  const t = frame / fps;
  const w = vertical ? 1000 : 1500, h = vertical ? 1180 : (w * take.height) / take.width, bar = vertical ? 38 : 44;
  const scale = Math.max(w / take.width, h / take.height), cw = take.width * scale, ch = take.height * scale;
  const zoom = vertical ? 1.35 : 1.55;
  const cam = cameraAt(cameraKeys(take, zoom), t), trail = cursorTrail(take, t), cur = cursorAt(take, t);
  // Zoomed in, the camera holds the click; zoomed out, it trails the cursor.
  const held = Math.log(cam.z) / Math.log(zoom);
  const halfX = w / (2 * cw * cam.z), halfY = h / (2 * ch * cam.z);
  const x = Math.min(1 - halfX, Math.max(halfX, held * cam.x + (1 - held) * trail.x));
  const y = Math.min(1 - halfY, Math.max(halfY, held * cam.y + (1 - held) * trail.y));
  const press = Math.max(0, ...presses(take, t, 0.25).map((p) => Math.sin(p.age * Math.PI)));
  return (
    <AbsoluteFill>
      <SceneTitles
        take={take}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: vertical ? 330 : 46,
          textAlign: "center",
          fontSize: vertical ? 66 : 54,
          fontWeight: 650,
          letterSpacing: "-0.025em",
          color: INK,
          padding: "0 80px",
        }}
      />
      <Window width={w} height={h} bar={bar} style={{ left: (W - w) / 2, top: vertical ? 560 : 150 }}>
        <div
          style={{
            position: "absolute",
            width: cw,
            height: ch,
            transformOrigin: "0 0",
            transform: `translate(${w / 2}px, ${h / 2}px) scale(${cam.z}) translate(${-x * cw}px, ${-y * ch}px)`,
          }}
        >
          <OffthreadVideo src={staticFile("web.mp4")} muted style={{ width: cw, height: ch }} />
          {presses(take, t, 0.5).map((p) => (
            <Ripple key={p.t} x={p.x * cw} y={p.y * ch} age={p.age} radius={30} color={BRAND} />
          ))}
          <Cursor x={cur.x * cw} y={cur.y * ch} press={press} size={26} />
        </div>
      </Window>
    </AbsoluteFill>
  );
};

/** The iPhone app in a phone frame, tilted a little, with its taps shown. */
export const PhonePart: FC<{ take: Take; vertical: boolean }> = ({ take, vertical }) => {
  const frame = useCurrentFrame(), { fps, width: W, height: H } = useVideoConfig();
  const t = frame / fps;
  const sh = vertical ? 1240 : 900, sw = (sh * take.width) / take.height, bezel = vertical ? 16 : 14;
  const fw = sw + bezel * 2, fh = sh + bezel * 2;
  const enter = spring({ frame: frame - 4, fps, config: { damping: 18, mass: 1.1 } });
  const drift = t / take.duration;
  const turn = vertical ? -5 * (1 - enter) - 2 * (1 - drift) : -18 * (1 - enter) - 8 + 5 * drift;
  const left = vertical ? (W - fw) / 2 : 1300 - fw / 2, top = vertical ? H - fh - 110 : (H - fh) / 2;
  return (
    <AbsoluteFill style={{ perspective: 2400 }}>
      <div style={{ position: "absolute", left: vertical ? 80 : 170, right: vertical ? 80 : 960, top: vertical ? 150 : 330, textAlign: vertical ? "center" : "left" }}>
        <Words text="cfind for iPhone" delay={6} style={{ fontSize: vertical ? 40 : 34, fontWeight: 600, color: BRAND, marginBottom: 18 }} />
        <SceneTitles
          take={take}
          prefix="phone-"
          style={{ position: "absolute", left: 0, right: 0, fontSize: vertical ? 72 : 80, lineHeight: 1.06, fontWeight: 700, letterSpacing: "-0.035em", color: INK }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: fw,
          height: fh,
          borderRadius: (vertical ? 76 : 66) + bezel,
          background: "#141418",
          padding: bezel,
          boxShadow: "0 60px 120px -20px rgba(40,20,90,0.35), 0 0 0 2px #3a3a42 inset",
          opacity: Math.min(1, enter * 1.4),
          transform: `translateY(${(1 - enter) * 160}px) rotateY(${turn}deg) rotateX(${vertical ? 0 : 3}deg)`,
        }}
      >
        <div style={{ position: "relative", width: sw, height: sh, borderRadius: vertical ? 76 : 56, overflow: "hidden", background: "#fff" }}>
          <OffthreadVideo src={staticFile("phone.mp4")} muted style={{ width: sw, height: sh }} />
          {presses(take, t, 0.45).map((p) => (
            <Ripple key={p.t} x={p.x * sw} y={p.y * sh} age={p.age} radius={vertical ? 40 : 30} color="rgba(0,0,0,0.22)" fill="rgba(0,0,0,0.10)" />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
