import { RevenueSelectorPrimitive } from "./revenuePrimitives.js";

export function RevenueSavedViewSelector(props: { views: string[]; activeView?: string }) {
  return <RevenueSelectorPrimitive label="Saved view" value={props.activeView ?? "Default visual dashboard"} options={props.views} />;
}
