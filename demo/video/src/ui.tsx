import type { CSSProperties, FC, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const FONT = '-apple-system, "SF Pro Display", system-ui, sans-serif';
export const INK = "#1d1d1f", MUTED = "#6e6e80", BRAND = "#7c5cff";

/** A soft light gradient that drifts slowly, behind every scene. */
export const Background: FC = () => {
  const t = useCurrentFrame() / 30;
  const dx = Math.sin(t / 6) * 6, dy = Math.cos(t / 7) * 5;
  return (
    <AbsoluteFill style={{ background: "#f5f4fa", overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          inset: "-15%",
          transform: `translate(${dx}%, ${dy}%)`,
          background: [
            "radial-gradient(40% 45% at 18% 22%, rgba(171,150,255,0.40), transparent 70%)",
            "radial-gradient(38% 42% at 85% 18%, rgba(140,200,255,0.35), transparent 70%)",
            "radial-gradient(45% 50% at 75% 88%, rgba(255,190,170,0.30), transparent 70%)",
            "radial-gradient(40% 40% at 15% 85%, rgba(160,230,210,0.25), transparent 70%)",
          ].join(","),
        }}
      />
    </AbsoluteFill>
  );
};

/** Text that comes in word by word, each word rising out of a blur. */
export const Words: FC<{ text: string; delay?: number; exitAt?: number; style?: CSSProperties }> = ({
  text,
  delay = 0,
  exitAt,
  style,
}) => {
  const frame = useCurrentFrame(), { fps } = useVideoConfig();
  const out = exitAt === undefined ? 0 : interpolate(frame, [exitAt - 9, exitAt], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={style}>
      {text.split(" ").map((w, i) => {
        const s = spring({ frame: frame - delay - i * 3, fps, config: { damping: 200 }, durationInFrames: 20 });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: s * (1 - out),
              filter: `blur(${(1 - s) * 10 + out * 8}px)`,
              transform: `translateY(${(1 - s) * 18 - out * 10}px)`,
            }}
          >
            {w + " "}
          </span>
        );
      })}
    </div>
  );
};

/** A browser window: rounded, with a soft shadow and a plain title bar. */
export const Window: FC<{ width: number; height: number; bar: number; children: ReactNode; style?: CSSProperties }> = ({
  width,
  height,
  bar,
  children,
  style,
}) => (
  <div
    style={{
      position: "absolute",
      width,
      height: height + bar,
      borderRadius: 18,
      overflow: "hidden",
      background: "#fff",
      boxShadow: "0 50px 100px -20px rgba(50,40,110,0.28), 0 30px 60px -30px rgba(0,0,0,0.30), 0 0 0 1px rgba(0,0,0,0.06)",
      ...style,
    }}
  >
    <div style={{ height: bar, background: "#f3f2f7", borderBottom: "1px solid rgba(0,0,0,0.07)", display: "flex", alignItems: "center", padding: "0 18px", gap: 8 }}>
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <i key={c} style={{ width: 12, height: 12, borderRadius: 6, background: c }} />
      ))}
      <div style={{ margin: "0 auto", transform: "translateX(-30px)", fontSize: 14, color: MUTED, background: "#fff", borderRadius: 8, padding: "4px 60px", border: "1px solid rgba(0,0,0,0.06)" }}>
        cfind
      </div>
    </div>
    <div style={{ position: "relative", width, height, overflow: "hidden" }}>{children}</div>
  </div>
);

/** A macOS-style arrow, drawn by the edit because headless Chrome shows none. */
export const Cursor: FC<{ x: number; y: number; press: number; size: number }> = ({ x, y, press, size }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    style={{
      position: "absolute",
      left: x - size * 0.21,
      top: y - size * 0.12,
      transform: `scale(${1 - press * 0.18})`,
      transformOrigin: "21% 12%",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.30))",
    }}
  >
    <path d="M5 3 L5 20.5 L9.6 16.2 L12.6 22.6 L15.3 21.4 L12.4 15.2 L18.6 15.2 Z" fill="#111" stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
  </svg>
);

/** A ring that grows and fades where a click or tap lands. */
export const Ripple: FC<{ x: number; y: number; age: number; radius: number; color: string; fill?: string }> = ({
  x,
  y,
  age,
  radius,
  color,
  fill = "transparent",
}) => {
  const r = radius * (0.35 + 0.65 * Math.sin((age * Math.PI) / 2));
  return (
    <div
      style={{
        position: "absolute",
        left: x - r,
        top: y - r,
        width: r * 2,
        height: r * 2,
        borderRadius: r,
        border: `2px solid ${color}`,
        background: fill,
        opacity: 1 - age,
      }}
    />
  );
};
