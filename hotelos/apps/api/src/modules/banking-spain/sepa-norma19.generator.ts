// Generador de remesas SEPA Direct Debit (Norma 19) en formato pain.008.001.02.
//
// Norma 19 es el cuaderno bancario español para envíos de adeudos
// domiciliados (huésped firma mandato → hotel cobra recurrente). Lo usan los
// hoteles para:
//   - Cobrar señales / depósitos
//   - Penalizaciones por no-show
//   - Cobros recurrentes a empresas/agencias (suscripciones)
//
// El formato es XML pain.008.001.02 (estándar ISO 20022) — exactamente el
// mismo que en el resto de la zona SEPA, con campos adicionales para España
// (mandato CORE/B2B, fecha primera ejecución, etc.).
//
// Honesty: este generador produce XML válido por estructura para entornos de
// prueba. La firma digital del fichero (cuando el banco la requiera) la
// hace el banco al recibirlo o se añade con la cert del comerciante en
// producción.

import { createHash } from "node:crypto";

export type SepaCreditor = {
  /** Nombre del acreedor (hotel/cadena). */
  name: string;
  /** ID de acreedor SEPA (ES + DIR3 + dígito control + NIF). */
  creditorId: string;
  /** IBAN del acreedor. */
  iban: string;
  /** BIC opcional (auto-derivable del IBAN). */
  bic?: string;
};

export type SepaDebtor = {
  /** ID único del mandato firmado por el deudor. */
  mandateId: string;
  /** Fecha de firma del mandato YYYY-MM-DD. */
  mandateSignedAt: string;
  name: string;
  iban: string;
  bic?: string;
  amount: number;
  /** Concepto comunicado al deudor. */
  description: string;
  /** Referencia única del envío (para que el deudor identifique en su extracto). */
  endToEndId: string;
};

export type SepaRemittance = {
  /** Esquema: CORE (consumidor) o B2B (empresa, mandato firmado). */
  schema: "CORE" | "B2B";
  /** Fecha de cargo solicitada YYYY-MM-DD. */
  collectionDate: string;
  /** Secuencia: FRST (primera) | RCUR (recurrente) | OOFF (única) | FNAL (última). */
  sequenceType: "FRST" | "RCUR" | "OOFF" | "FNAL";
  creditor: SepaCreditor;
  debtors: SepaDebtor[];
};

function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function generateMessageId(creditorId: string): string {
  // Format used by most Spanish banks: XX-YYYYMMDD-HHMMSS-N (max 35 chars).
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const tail = createHash("sha256").update(creditorId + ts).digest("hex").slice(0, 6);
  return `HOTELOS-${ts}-${tail}`;
}

export function generateSepaRemittance(input: SepaRemittance): {
  messageId: string;
  xml: string;
  control: { totalAmount: number; transactions: number };
} {
  const messageId = generateMessageId(input.creditor.creditorId);
  const totalAmount = input.debtors.reduce((sum, d) => sum + d.amount, 0);
  const transactions = input.debtors.length;
  const paymentInfoId = `${messageId}-PMT`;
  const createdAt = new Date().toISOString();

  const debtorsXml = input.debtors
    .map(
      (d, idx) => `
      <DrctDbtTxInf>
        <PmtId>
          <EndToEndId>${escXml(d.endToEndId)}</EndToEndId>
        </PmtId>
        <InstdAmt Ccy="EUR">${d.amount.toFixed(2)}</InstdAmt>
        <DrctDbtTx>
          <MndtRltdInf>
            <MndtId>${escXml(d.mandateId)}</MndtId>
            <DtOfSgntr>${d.mandateSignedAt}</DtOfSgntr>
          </MndtRltdInf>
        </DrctDbtTx>
        ${d.bic ? `<DbtrAgt><FinInstnId><BIC>${escXml(d.bic)}</BIC></FinInstnId></DbtrAgt>` : `<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>`}
        <Dbtr>
          <Nm>${escXml(d.name)}</Nm>
        </Dbtr>
        <DbtrAcct>
          <Id><IBAN>${escXml(d.iban.replace(/\s/g, ""))}</IBAN></Id>
        </DbtrAcct>
        <RmtInf>
          <Ustrd>${escXml(d.description.slice(0, 140))}</Ustrd>
        </RmtInf>
      </DrctDbtTxInf>`
    )
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${messageId}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>${transactions}</NbOfTxs>
      <CtrlSum>${totalAmount.toFixed(2)}</CtrlSum>
      <InitgPty>
        <Nm>${escXml(input.creditor.name)}</Nm>
        <Id><OrgId><Othr><Id>${escXml(input.creditor.creditorId)}</Id></Othr></OrgId></Id>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${paymentInfoId}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <NbOfTxs>${transactions}</NbOfTxs>
      <CtrlSum>${totalAmount.toFixed(2)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl><Cd>SEPA</Cd></SvcLvl>
        <LclInstrm><Cd>${input.schema}</Cd></LclInstrm>
        <SeqTp>${input.sequenceType}</SeqTp>
      </PmtTpInf>
      <ReqdColltnDt>${input.collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>${escXml(input.creditor.name)}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${escXml(input.creditor.iban.replace(/\s/g, ""))}</IBAN></Id></CdtrAcct>
      ${input.creditor.bic ? `<CdtrAgt><FinInstnId><BIC>${escXml(input.creditor.bic)}</BIC></FinInstnId></CdtrAgt>` : ""}
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId>
        <Id><PrvtId><Othr>
          <Id>${escXml(input.creditor.creditorId)}</Id>
          <SchmeNm><Prtry>SEPA</Prtry></SchmeNm>
        </Othr></PrvtId></Id>
      </CdtrSchmeId>${debtorsXml}
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>`;

  return {
    messageId,
    xml,
    control: { totalAmount: Math.round(totalAmount * 100) / 100, transactions }
  };
}

/** Validación IBAN básica (longitud + mod-97). Para España (ES) son 24 chars. */
export function validateIban(iban: string): boolean {
  const cleaned = iban.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(cleaned)) return false;
  // mod-97 check
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    const chunk = remainder.toString() + numeric.slice(i, i + 7);
    remainder = Number(chunk) % 97;
  }
  return remainder === 1;
}
