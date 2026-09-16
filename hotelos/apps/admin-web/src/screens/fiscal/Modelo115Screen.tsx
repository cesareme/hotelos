// Modelo 115 — /cumplimiento/modelos-aeat/115: tab of Modelos AEAT (ModelosAeatTabs) and the legacy standalone route /backoffice/fiscal/modelo-115.
//
// Cocoa 22 · ola 8 · lote 8-B. The quarterly withholdings on urban leases on the FiscalModelReport
// contract (GET /fiscal/models/115, «Descargar resumen» PDF) is painted by
// the shared FiscalModelScreen (screens/fiscal/FiscalModelReport.tsx); this
// file fixes the model code, the title and the standalone subtitle. Hosted
// in a tab container (useTabHost) the container paints eyebrow, title and
// subtitle, so none is repeated here.

import { useTabHost } from "../tabs/TabHost";
import { FiscalModelScreen } from "./FiscalModelReport";
import { MODEL_SUBTITLES } from "./fiscal-shared";

export function Modelo115Screen() {
  const hosted = useTabHost() !== null;
  return <FiscalModelScreen modelo="115" title="Modelo 115" subtitle={hosted ? undefined : MODEL_SUBTITLES["115"]} />;
}

export default Modelo115Screen;
