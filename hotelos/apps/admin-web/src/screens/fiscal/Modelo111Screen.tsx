// Modelo 111 — /cumplimiento/modelos-aeat/111: tab of Modelos AEAT (ModelosAeatTabs) and the legacy standalone route /backoffice/fiscal/modelo-111.
//
// Cocoa 22 · ola 8 · lote 8-B. The quarterly IRPF withholdings on the FiscalModelReport
// contract (GET /fiscal/models/111, «Descargar resumen» PDF) is painted by
// the shared FiscalModelScreen (screens/fiscal/FiscalModelReport.tsx); this
// file fixes the model code, the title and the standalone subtitle. Hosted
// in a tab container (useTabHost) the container paints eyebrow, title and
// subtitle, so none is repeated here.

import { useTabHost } from "../tabs/TabHost";
import { FiscalModelScreen } from "./FiscalModelReport";
import { MODEL_SUBTITLES } from "./fiscal-shared";

export function Modelo111Screen() {
  const hosted = useTabHost() !== null;
  return <FiscalModelScreen modelo="111" title="Modelo 111" subtitle={hosted ? undefined : MODEL_SUBTITLES["111"]} />;
}

export default Modelo111Screen;
