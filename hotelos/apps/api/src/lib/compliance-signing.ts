import {
  signXmlXadesEpes,
  signXmlXadesT,
  type TsaMode,
  type XadesSignInput,
  type XadesSignResult
} from "@hotelos/compliance";

/**
 * Reads the XAdES-T opt-in env vars used by all four submission services
 * (VeriFactu, TBAI, IGIC, SES Hospedajes). Centralised here so adding
 * per-property overrides later requires touching only one helper.
 *
 *   XADES_TIMESTAMP_ENABLED  "true" | "false"   (default "false")
 *   XADES_TIMESTAMP_MODE     "stub" | "real"    (default "stub")
 *   XADES_TIMESTAMP_TSA_URL  URL                (default DigiCert)
 *
 * When disabled, callers receive the byte-for-byte legacy XAdES-EPES output
 * (no <xades:SignatureTimeStamp> block). When enabled, the signer upgrades
 * the envelope to XAdES-T.
 */
export type XadesTimestampSettings =
  | { enabled: false }
  | { enabled: true; mode: TsaMode; tsaUrl: string };

const DEFAULT_TSA_URL = "http://timestamp.digicert.com";

export function readXadesTimestampSettings(env: NodeJS.ProcessEnv = process.env): XadesTimestampSettings {
  const enabledRaw = (env.XADES_TIMESTAMP_ENABLED ?? "false").trim().toLowerCase();
  const enabled = enabledRaw === "true" || enabledRaw === "1" || enabledRaw === "yes";
  if (!enabled) return { enabled: false };
  const modeRaw = (env.XADES_TIMESTAMP_MODE ?? "stub").trim().toLowerCase();
  const mode: TsaMode = modeRaw === "real" ? "real" : "stub";
  const tsaUrl = (env.XADES_TIMESTAMP_TSA_URL ?? DEFAULT_TSA_URL).trim() || DEFAULT_TSA_URL;
  return { enabled: true, mode, tsaUrl };
}

/**
 * Single signing entry point used by every submission service. Branches on the
 * env-driven flag: XAdES-EPES (sync semantics, async wrapper) by default,
 * XAdES-T when timestamping is enabled.
 *
 * The return type matches signXmlXadesT/Epes exactly so call sites only need
 * to add an `await`.
 */
export async function signSubmissionXml(input: XadesSignInput): Promise<XadesSignResult> {
  const settings = readXadesTimestampSettings();
  if (!settings.enabled) {
    return signXmlXadesEpes(input);
  }
  return signXmlXadesT({
    ...input,
    timestamp: { mode: settings.mode, tsaUrl: settings.tsaUrl }
  });
}
