// Modelo 347 — /cumplimiento/modelos-aeat/347: tab of Modelos AEAT (ModelosAeatTabs); new in Tanda 6.
//
// Cocoa 22 · ola 8 · lote 8-B. The annual third-party operations declaration on the FiscalModelReport
// contract (GET /fiscal/models/347, «Descargar resumen» PDF) is painted by
// the shared FiscalModelScreen (screens/fiscal/FiscalModelReport.tsx); this
// file fixes the model code, the title and the standalone subtitle. Hosted
// in a tab container (useTabHost) the container paints eyebrow, title and
// subtitle, so none is repeated here.

import { useTabHost } from "../tabs/TabHost";
import { FiscalModelScreen } from "./FiscalModelReport";
import { MODEL_SUBTITLES } from "./fiscal-shared";

export function Modelo347Screen() {
  const hosted = useTabHost() !== null;
  return <FiscalModelScreen modelo="347" title="Modelo 347" subtitle={hosted ? undefined : MODEL_SUBTITLES["347"]} />;
}

export default Modelo347Screen;
