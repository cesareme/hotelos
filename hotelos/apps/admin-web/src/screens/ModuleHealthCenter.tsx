import { ScreenScaffold } from "./ScreenScaffold";

export function ModuleHealthCenter() {
  return (
    <ScreenScaffold
      eyebrow="Health checks"
      title="Module Health Center"
      summary="Track configuration status, health checks, last errors, blockers and recommendations for each module."
      cards={[
        { title: "PMS Core", status: "ok", body: "Room inventory exists and core routes are available." },
        { title: "AI Check-in", status: "error", body: "OCR provider and guest register signature template are still missing." }
      ]}
    />
  );
}
