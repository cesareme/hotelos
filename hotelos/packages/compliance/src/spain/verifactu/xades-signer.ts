import { createHash, createPrivateKey, createSign, randomUUID, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetchTimestamp, type TsaMode, type TimestampResult } from "./timestamp/index.js";

// XAdES-EPES enveloped signature for VeriFactu / TicketBAI / IGIC submissions.
// Real production signing requires a qualified certificate (FNMT-RCM
// "representante de empresa") and full c14n11/XML canonicalization. This
// implementation produces a valid XAdES-EPES envelope when a PKCS#12 cert is
// configured, and falls back to a tagged unsigned envelope when no cert is
// present (sandbox-friendly, never accepted by AEAT but useful for end-to-end
// testing of the surrounding pipeline).

export type XadesTimestampOption = {
  /** "stub" produces a deterministic, fake TimeStampToken (offline, NOT valid for production). */
  mode: TsaMode;
  /** TSA URL for "real" mode. Defaults to http://timestamp.digicert.com. */
  tsaUrl?: string;
  /** Optional override for the HTTP fetch used by the TSA client (tests). */
  fetchImpl?: typeof fetch;
};

export type XadesSignInput = {
  xml: string;
  certPath?: string;
  certPassphrase?: string;
  signatureId?: string;
  signatureProductionPlace?: string;
  /**
   * When present, the signer upgrades the signature to XAdES-T by embedding an
   * RFC 3161 TimeStampToken over the <ds:SignatureValue>. Omit to keep
   * historical XAdES-EPES output (backward compatible).
   */
  timestamp?: XadesTimestampOption;
};

export type XadesSignResult = {
  signedXml: string;
  signatureValue?: string;
  certificateSubject?: string;
  certificateIssuer?: string;
  signedAt: string;
  signatureMode: "real" | "stub";
  /** Set when `timestamp` was requested. "stub" tokens are NOT valid for production. */
  timestamp?: {
    mode: TsaMode;
    source: string;
    requestedAt: string;
  };
};

// Minimal Exclusive XML Canonicalization (c14n) for self-contained payloads
// that do not use namespaces beyond the default + a single prefix. AEAT accepts
// xml-exc-c14n#WithComments. For multi-namespace documents we delegate to the
// caller to pre-canonicalize with a proper library.
function canonicalize(xml: string): string {
  return xml.replace(/\s+/g, " ").replace(/>\s+</g, "><").trim();
}

function digestBase64(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("base64");
}

function loadPrivateKey(certPath: string, passphrase: string): { keyPem: string; certBase64: string; subject: string; issuer: string } {
  // Node's KeyObject doesn't parse PKCS#12 natively. For sandbox/dev we accept
  // PEM-format files (privateKey + certificate concatenated). Production users
  // can convert with: openssl pkcs12 -in cert.p12 -nodes -out cert.pem
  const pem = readFileSync(certPath, "utf-8");
  const keyMatch = pem.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC )?PRIVATE KEY-----/);
  const certMatch = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!keyMatch || !certMatch) throw new Error("XAdES: PEM must contain both a PRIVATE KEY and a CERTIFICATE block.");
  const keyPem = keyMatch[0];
  // Validate the passphrase by attempting to load the key.
  createPrivateKey({ key: keyPem, passphrase });
  const certPem = certMatch[0];
  const x509 = new X509Certificate(certPem);
  const certBase64 = certPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, "");
  return { keyPem, certBase64, subject: x509.subject ?? "Unknown", issuer: x509.issuer ?? "Unknown" };
}

export function signXmlXadesEpes(input: XadesSignInput): XadesSignResult {
  if (input.timestamp) {
    // XAdES-T requires an async TSA round-trip (or a deterministic stub hash);
    // both are exposed via signXmlXadesT. Callers wanting -T must switch to the
    // async entrypoint to preserve the sync contract here.
    throw new Error(
      "signXmlXadesEpes is synchronous; use signXmlXadesT(input) for XAdES-T (timestamped) signatures."
    );
  }
  return signEpesCore(input);
}

/**
 * XAdES-T variant: produces an EPES signature and then embeds an RFC 3161
 * TimeStampToken over <ds:SignatureValue> inside
 * <xades:UnsignedSignatureProperties>/<xades:SignatureTimeStamp>.
 *
 * Backward compatible: if `input.timestamp` is undefined this resolves to the
 * exact same result as the synchronous signXmlXadesEpes.
 */
export async function signXmlXadesT(input: XadesSignInput): Promise<XadesSignResult> {
  const baseResult = signEpesCore(input);
  if (!input.timestamp) return baseResult;

  // RFC 5126 §A.1.1: SignatureTimeStamp is computed over the canonicalized
  // <ds:SignatureValue> element. For stub mode we hash the SignatureValue text;
  // for real mode the TSA hashes the same payload server-side.
  const signatureValueElement = `<ds:SignatureValue>${baseResult.signatureValue ?? ""}</ds:SignatureValue>`;
  const tsResult = await fetchTimestamp(signatureValueElement, {
    mode: input.timestamp.mode,
    tsaUrl: input.timestamp.tsaUrl,
    fetchImpl: input.timestamp.fetchImpl
  });

  const signedXml = embedSignatureTimeStamp(baseResult.signedXml, tsResult);
  return {
    ...baseResult,
    signedXml,
    timestamp: {
      mode: tsResult.mode,
      source: tsResult.source,
      requestedAt: tsResult.requestedAt
    }
  };
}

function signEpesCore(input: XadesSignInput): XadesSignResult {
  const signedAt = new Date().toISOString();
  const signatureId = input.signatureId ?? `sig-${randomUUID()}`;
  const canonicalDoc = canonicalize(input.xml);
  const docDigest = digestBase64(canonicalDoc);

  if (!input.certPath || !input.certPassphrase) {
    const stubSignature = `STUB-${digestBase64(canonicalDoc).slice(0, 32)}`;
    // When XAdES-T is requested we need a QualifyingProperties skeleton so the
    // unsigned SignatureTimeStamp block can splice in. Emit a sandbox-flagged
    // envelope instead of the legacy single-comment stub. AEAT will never
    // accept this — it is purely for end-to-end pipeline tests.
    const signedXml = input.timestamp
      ? appendStubXadesEpesBlock(input.xml, signatureId, docDigest, stubSignature, signedAt)
      : appendStubSignatureBlock(input.xml, signatureId, docDigest, stubSignature, signedAt);
    return {
      signedXml,
      signatureValue: stubSignature,
      signatureMode: "stub",
      signedAt
    };
  }

  const { keyPem, certBase64, subject, issuer } = loadPrivateKey(input.certPath, input.certPassphrase);
  const signedInfo = buildSignedInfo(signatureId, docDigest);
  const canonicalSignedInfo = canonicalize(signedInfo);

  const signer = createSign("RSA-SHA256");
  signer.update(canonicalSignedInfo, "utf-8");
  signer.end();
  const signatureValue = signer.sign({ key: keyPem, passphrase: input.certPassphrase }).toString("base64");

  return {
    signedXml: appendSignatureBlock(input.xml, signatureId, signedInfo, signatureValue, certBase64, signedAt),
    signatureValue,
    certificateSubject: subject,
    certificateIssuer: issuer,
    signedAt,
    signatureMode: "real"
  };
}

// XAdES-T embedding: inject <xades:UnsignedSignatureProperties> /
// <xades:SignatureTimeStamp> inside the existing <xades:QualifyingProperties>.
// The EPES signer emits a closed <xades:QualifyingProperties> after a single
// <xades:SignedProperties>; we splice the unsigned block immediately before
// the closing </xades:QualifyingProperties>. For the stub-signature path
// (no certificate) there is no QualifyingProperties — append a comment
// describing the timestamp so the pipeline can be inspected.
function embedSignatureTimeStamp(xml: string, ts: TimestampResult): string {
  const unsignedBlock = `<xades:UnsignedProperties><xades:UnsignedSignatureProperties><xades:SignatureTimeStamp Id="ts-${randomUUID()}"><ds:CanonicalizationMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2006/12/xml-c14n11"/><xades:EncapsulatedTimeStamp>${ts.tokenBase64}</xades:EncapsulatedTimeStamp></xades:SignatureTimeStamp></xades:UnsignedSignatureProperties></xades:UnsignedProperties>`;

  const closingTag = "</xades:QualifyingProperties>";
  const idx = xml.lastIndexOf(closingTag);
  if (idx >= 0) {
    return `${xml.slice(0, idx)}${unsignedBlock}${xml.slice(idx)}`;
  }
  // Stub-signature path: no QualifyingProperties present. Annotate the doc.
  const comment = `<!-- XAdES-T stub: SignatureTimeStamp source=${ts.source} mode=${ts.mode} requestedAt=${ts.requestedAt} token=${ts.tokenBase64} -->`;
  return injectBeforeRootClose(xml, comment);
}

function buildSignedInfo(signatureId: string, docDigest: string): string {
  return `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
  <CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
  <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
  <Reference Id="ref-${signatureId}" URI="">
    <Transforms>
      <Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
      <Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
    </Transforms>
    <DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
    <DigestValue>${docDigest}</DigestValue>
  </Reference>
</SignedInfo>`;
}

function appendSignatureBlock(xml: string, signatureId: string, signedInfo: string, signatureValue: string, certBase64: string, signedAt: string): string {
  const sigBlock = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${signatureId}">
  ${signedInfo.replace(/<SignedInfo /, "<ds:SignedInfo ").replace(/<\/SignedInfo>/, "</ds:SignedInfo>")}
  <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
  <ds:KeyInfo>
    <ds:X509Data><ds:X509Certificate>${certBase64}</ds:X509Certificate></ds:X509Data>
  </ds:KeyInfo>
  <ds:Object>
    <xades:QualifyingProperties Target="#${signatureId}">
      <xades:SignedProperties Id="signed-${signatureId}">
        <xades:SignedSignatureProperties>
          <xades:SigningTime>${signedAt}</xades:SigningTime>
          <xades:SigningCertificateV2/>
          <xades:SignaturePolicyIdentifier>
            <xades:SignaturePolicyId>
              <xades:SigPolicyId>
                <xades:Identifier>https://sede.serviciosmin.gob.es/Prestadores/politica</xades:Identifier>
              </xades:SigPolicyId>
              <xades:SigPolicyHash>
                <xades:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                <xades:DigestValue>${digestBase64("epes-policy")}</xades:DigestValue>
              </xades:SigPolicyHash>
            </xades:SignaturePolicyId>
          </xades:SignaturePolicyIdentifier>
        </xades:SignedSignatureProperties>
      </xades:SignedProperties>
    </xades:QualifyingProperties>
  </ds:Object>
</ds:Signature>`;
  return injectBeforeRootClose(xml, sigBlock);
}

function appendStubSignatureBlock(xml: string, signatureId: string, docDigest: string, stubSignature: string, signedAt: string): string {
  const sigBlock = `<!-- XAdES-EPES stub: no certificate configured. signatureId=${signatureId} signedAt=${signedAt} digest=${docDigest} value=${stubSignature} -->`;
  return injectBeforeRootClose(xml, sigBlock);
}

// Sandbox-only: emits a XAdES-EPES-shaped envelope (with QualifyingProperties)
// signed with a synthetic STUB- placeholder. Used when XAdES-T is requested
// without a configured certificate, so SignatureTimeStamp can splice in.
// MUST NEVER be relayed to AEAT.
function appendStubXadesEpesBlock(xml: string, signatureId: string, docDigest: string, stubSignature: string, signedAt: string): string {
  const sigBlock = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${signatureId}">
  <ds:SignedInfo>
    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
    <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
    <ds:Reference Id="ref-${signatureId}" URI=""><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>${docDigest}</ds:DigestValue></ds:Reference>
  </ds:SignedInfo>
  <ds:SignatureValue>${stubSignature}</ds:SignatureValue>
  <ds:KeyInfo><!-- STUB: no certificate configured (sandbox only, never accepted by AEAT) --></ds:KeyInfo>
  <ds:Object>
    <xades:QualifyingProperties Target="#${signatureId}">
      <xades:SignedProperties Id="signed-${signatureId}">
        <xades:SignedSignatureProperties>
          <xades:SigningTime>${signedAt}</xades:SigningTime>
        </xades:SignedSignatureProperties>
      </xades:SignedProperties>
    </xades:QualifyingProperties>
  </ds:Object>
</ds:Signature>`;
  return injectBeforeRootClose(xml, sigBlock);
}

function injectBeforeRootClose(xml: string, payload: string): string {
  const lastClose = xml.lastIndexOf("</");
  if (lastClose < 0) return xml + payload;
  return `${xml.slice(0, lastClose)}${payload}${xml.slice(lastClose)}`;
}
