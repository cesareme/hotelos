// Generador de remesas SEPA Direct Debit (Cuaderno 19) en pain.008.001.02.
//
// Norma 19 es el cuaderno AEB para adeudos domiciliados (el deudor firma un
// mandato → el acreedor cobra): señales y depósitos, penalizaciones por
// no-show, cobros recurrentes a empresas/agencias. Esquemas CORE (consumidor)
// y B2B (empresa). Este generador produce el XML estructuralmente válido que
// el banco acepta por su banca electrónica; la firma, cuando la entidad la
// exige, la aplica el banco o el certificado del comerciante en producción.
//
// Importes: la suma de control se calcula en céntimos enteros (nunca float) y
// `InstdAmt` se escribe con dos decimales exactos.

import { createHash } from "node:crypto";
import { dec, fromCents, money, toCents, type Dec } from "../treasury/money.js";

export type SepaCreditor = {
  /** Nombre del acreedor (hotel/cadena), máx. 70 caracteres. */
  name: string;
  /** Identificador de acreedor SEPA (ES + 2 dígitos de control + sufijo 3 + NIF). */
  creditorId: string;
  iban: string;
  bic?: string;
};

export type SepaDebtor = {
  /** Referencia única del mandato firmado por el deudor (máx. 35). */
  mandateId: string;
  /** Fecha de firma del mandato YYYY-MM-DD. */
  mandateSignedAt: string;
  name: string;
  iban: string;
  bic?: string;
  /** Importe en euros (número o cadena decimal). */
  amount: number | string;
  /** Concepto comunicado al deudor (máx. 140). */
  description: string;
  /** Referencia única del adeudo (máx. 35) que el deudor ve en su extracto. */
  endToEndId: string;
};

export type SepaRemittance = {
  schema: "CORE" | "B2B";
  /** Fecha de cargo solicitada YYYY-MM-DD. */
  collectionDate: string;
  /** FRST primera · RCUR recurrente · OOFF única · FNAL última. */
  sequenceType: "FRST" | "RCUR" | "OOFF" | "FNAL";
  creditor: SepaCreditor;
  debtors: SepaDebtor[];
};

export function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** SEPA character set (EPC217-08): letters, digits, / - ? : ( ) . , ' + space. */
export function sepaText(value: string, max: number): string {
  const normalised = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9/\-?:().,'+ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalised.slice(0, max);
}

export function sepaId(value: string, max = 35): string {
  return sepaText(value, max).replace(/\s/g, "-");
}

export function generateMessageId(seed: string, now: Date = new Date()): string {
  // Format used by most Spanish banks: PREFIX-YYYYMMDDHHMMSS-hash (max 35 chars).
  const ts = now.toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const tail = createHash("sha256").update(seed + ts).digest("hex").slice(0, 6).toUpperCase();
  return `HOTELOS-${ts}-${tail}`;
}

export type SepaGeneration = {
  messageId: string;
  xml: string;
  control: { totalAmount: number; totalAmountCents: number; transactions: number };
};

export function generateSepaRemittance(input: SepaRemittance, options: { now?: Date; messageId?: string } = {}): SepaGeneration {
  const now = options.now ?? new Date();
  const messageId = options.messageId ?? generateMessageId(input.creditor.creditorId, now);
  let totalCents = 0;
  for (const d of input.debtors) totalCents += toCents(dec(d.amount));
  const total: Dec = fromCents(totalCents);
  const transactions = input.debtors.length;
  const paymentInfoId = sepaId(`${messageId}-PMT`);
  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, "");

  const debtorsXml = input.debtors
    .map(
      (d) => `
      <DrctDbtTxInf>
        <PmtId>
          <EndToEndId>${escXml(sepaId(d.endToEndId))}</EndToEndId>
        </PmtId>
        <InstdAmt Ccy="EUR">${money(d.amount)}</InstdAmt>
        <DrctDbtTx>
          <MndtRltdInf>
            <MndtId>${escXml(sepaId(d.mandateId))}</MndtId>
            <DtOfSgntr>${d.mandateSignedAt}</DtOfSgntr>
          </MndtRltdInf>
        </DrctDbtTx>
        ${d.bic ? `<DbtrAgt><FinInstnId><BIC>${escXml(d.bic.trim().toUpperCase())}</BIC></FinInstnId></DbtrAgt>` : `<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>`}
        <Dbtr>
          <Nm>${escXml(sepaText(d.name, 70))}</Nm>
        </Dbtr>
        <DbtrAcct>
          <Id><IBAN>${escXml(d.iban.replace(/\s/g, "").toUpperCase())}</IBAN></Id>
        </DbtrAcct>
        <RmtInf>
          <Ustrd>${escXml(sepaText(d.description, 140))}</Ustrd>
        </RmtInf>
      </DrctDbtTxInf>`
    )
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.008.001.02">
  <CstmrDrctDbtInitn>
    <GrpHdr>
      <MsgId>${escXml(messageId)}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>${transactions}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <InitgPty>
        <Nm>${escXml(sepaText(input.creditor.name, 70))}</Nm>
        <Id><OrgId><Othr><Id>${escXml(sepaId(input.creditor.creditorId))}</Id></Othr></OrgId></Id>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${escXml(paymentInfoId)}</PmtInfId>
      <PmtMtd>DD</PmtMtd>
      <NbOfTxs>${transactions}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <PmtTpInf>
        <SvcLvl><Cd>SEPA</Cd></SvcLvl>
        <LclInstrm><Cd>${input.schema}</Cd></LclInstrm>
        <SeqTp>${input.sequenceType}</SeqTp>
      </PmtTpInf>
      <ReqdColltnDt>${input.collectionDate}</ReqdColltnDt>
      <Cdtr><Nm>${escXml(sepaText(input.creditor.name, 70))}</Nm></Cdtr>
      <CdtrAcct><Id><IBAN>${escXml(input.creditor.iban.replace(/\s/g, "").toUpperCase())}</IBAN></Id></CdtrAcct>
      ${input.creditor.bic ? `<CdtrAgt><FinInstnId><BIC>${escXml(input.creditor.bic.trim().toUpperCase())}</BIC></FinInstnId></CdtrAgt>` : "<CdtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></CdtrAgt>"}
      <ChrgBr>SLEV</ChrgBr>
      <CdtrSchmeId>
        <Id><PrvtId><Othr>
          <Id>${escXml(sepaId(input.creditor.creditorId))}</Id>
          <SchmeNm><Prtry>SEPA</Prtry></SchmeNm>
        </Othr></PrvtId></Id>
      </CdtrSchmeId>${debtorsXml}
    </PmtInf>
  </CstmrDrctDbtInitn>
</Document>`;

  return { messageId, xml, control: { totalAmount: Number(money(total)), totalAmountCents: totalCents, transactions } };
}

/** Validación IBAN (longitud por país para ES = 24 + mod-97). */
export function validateIban(iban: string): boolean {
  if (typeof iban !== "string") return false;
  const cleaned = iban.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(cleaned)) return false;
  if (cleaned.startsWith("ES") && cleaned.length !== 24) return false;
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(`${remainder}${numeric.slice(i, i + 7)}`) % 97;
  }
  return remainder === 1;
}

/** Identificador de acreedor SEPA español: ES + 2 dígitos de control + sufijo (3) + NIF (9). */
export function validateCreditorId(creditorId: string): boolean {
  const cleaned = creditorId.replace(/\s/g, "").toUpperCase();
  if (!/^ES\d{2}[A-Z0-9]{3}[A-Z0-9]{9}$/.test(cleaned)) return false;
  // Check digits: mod-97 over NIF + "ES00" (the suffix is excluded from the check).
  const nif = cleaned.slice(7);
  const rearranged = `${nif}ES00`;
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(`${remainder}${numeric.slice(i, i + 7)}`) % 97;
  }
  return String(98 - remainder).padStart(2, "0") === cleaned.slice(2, 4);
}
