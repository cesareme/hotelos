// Modelo 303 — /cumplimiento/modelos-aeat: base tab of Modelos AEAT (ModelosAeatTabs) and the legacy standalone route /backoffice/fiscal/modelo-303.
//
// Cocoa 22 · ola 8 · lote 8-B. The quarterly (or monthly) IVA return on the FiscalModelReport
// contract (GET /fiscal/models/303, «Descargar resumen» PDF) is painted by
// the shared FiscalModelScreen (screens/fiscal/FiscalModelReport.tsx); this
// file fixes the model code, the title and the standalone subtitle. Hosted
// in a tab container (useTabHost) the container paints eyebrow, title and
// subtitle, so none is repeated here.

import { useTabHost } from "../tabs/TabHost";
import { FiscalModelScreen } from "./FiscalModelReport";
import { MODEL_SUBTITLES } from "./fiscal-shared";

export function Modelo303Screen() {
  const hosted = useTabHost() !== null;
  return <FiscalModelScreen modelo="303" title="Modelo 303" subtitle={hosted ? undefined : MODEL_SUBTITLES["303"]} />;
}

export default Modelo303Screen;
