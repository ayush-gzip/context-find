import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill } from "remotion";
import { Intro, Outro, PhonePart, WebPart } from "./parts";
import { FADE, INTRO, OUTRO, type Take } from "./timing";
import { Background, FONT } from "./ui";

export type DemoProps = { vertical: boolean; web: Take | null; phone: Take | null };

const parts = (web: Take, phone: Take | null) => [INTRO, web.duration, ...(phone ? [phone.duration] : []), OUTRO];

export const length = (web: Take, phone: Take | null, fps: number) => {
  const p = parts(web, phone);
  return p.reduce((n, s) => n + Math.round(s * fps), 0) - (p.length - 1) * Math.round(FADE * fps);
};

export const Demo = ({ vertical, web, phone }: DemoProps) => {
  if (!web) return null;
  const f = (s: number) => Math.round(s * 30);
  const scenes = [
    <Intro vertical={vertical} />,
    <WebPart take={web} vertical={vertical} />,
    ...(phone ? [<PhonePart take={phone} vertical={vertical} />] : []),
    <Outro vertical={vertical} />,
  ];
  const lengths = parts(web, phone);
  return (
    <AbsoluteFill style={{ fontFamily: FONT, WebkitFontSmoothing: "antialiased" }}>
      <Background />
      <TransitionSeries>
        {scenes.flatMap((scene, i) => [
          ...(i ? [<TransitionSeries.Transition key={"x" + i} presentation={fade()} timing={linearTiming({ durationInFrames: f(FADE) })} />] : []),
          <TransitionSeries.Sequence key={"s" + i} durationInFrames={f(lengths[i])}>
            {scene}
          </TransitionSeries.Sequence>,
        ])}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
