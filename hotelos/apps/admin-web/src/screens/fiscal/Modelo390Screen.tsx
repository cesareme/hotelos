// Modelo 390 — /cumplimiento/modelos-aeat/390: tab of Modelos AEAT (ModelosAeatTabs) and the legacy standalone route /backoffice/fiscal/modelo-390.
//
// Cocoa 22 · ola 8 · lote 8-B. The annual IVA summary on the FiscalModelReport
// contract (GET /fiscal/models/390, «Descargar resumen» PDF) is painted by
// the shared FiscalModelScreen (screens/fiscal/FiscalModelReport.tsx); this
// file fixes the model code, the title and the standalone subtitle. Hosted
// in a tab container (useTabHost) the container paints eyebrow, title and
// subtitle, so none is repeated here.

import { useTabHost } from "../tabs/TabHost";
import { FiscalModelScreen } from "./FiscalModelReport";
import { MODEL_SUBTITLES } from "./fiscal-shared";

export function Modelo390Screen() {
  const hosted = useTabHost() !== null;
  return <FiscalModelScreen modelo="390" title="Modelo 390" subtitle={hosted ? undefined : MODEL_SUBTITLES["390"]} />;
}

export default Modelo390Screen;
