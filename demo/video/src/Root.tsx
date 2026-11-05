import { Composition, staticFile, type CalculateMetadataFunction } from "remotion";
import { Demo, length, type DemoProps } from "./Demo";

// The recordings decide the length, so they are read before rendering.
const load: CalculateMetadataFunction<DemoProps> = async ({ props }) => {
  const read = (name: string) => fetch(staticFile(name)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [web, phone] = await Promise.all([read("web.json"), read("phone.json")]);
  if (!web) throw new Error("No public/web.json. Run npm run record first.");
  return { durationInFrames: length(web, phone, 30), props: { ...props, web, phone } };
};

export const Root = () => (
  <>
    <Composition id="Demo" component={Demo} width={1920} height={1080} fps={30} durationInFrames={300}
      defaultProps={{ vertical: false, web: null, phone: null }} calculateMetadata={load} />
    <Composition id="DemoVertical" component={Demo} width={1080} height={1920} fps={30} durationInFrames={300}
      defaultProps={{ vertical: true, web: null, phone: null }} calculateMetadata={load} />
  </>
);
