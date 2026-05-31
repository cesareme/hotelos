// The Manual Setup Center has been folded into the unified Setup Center
// (Overview + All setup items tabs). This thin wrapper keeps the existing
// route/screen key working and opens directly on the full item index.
import { SetupCenter } from "../backoffice/SetupCenterScreen";

export function ManualSetupHubScreen() {
  return <SetupCenter initialTab="items" />;
}
