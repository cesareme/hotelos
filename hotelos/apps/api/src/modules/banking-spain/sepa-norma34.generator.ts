// Generador de remesas SEPA de transferencias (Cuaderno 34-14) en
// pain.001.001.03: pagos a proveedores y nóminas ordenados por el hotel.
//
// El deudor es el hotel (cuenta ordenante); cada `creditor` es un beneficiario
// (proveedor, empleado) con su IBAN. Sumas de control en céntimos enteros.
// Igual que en Norma 19, el XML es estructuralmente válido para la banca
// electrónica; la firma la aporta el banco o el certificado del ordenante.

import { dec, fromCents, money, toCents } from "../treasury/money.js";
import { escXml, generateMessageId, sepaId, sepaText } from "./sepa-norma19.generator.js";

export type SepaTransferDebtor = {
  /** Ordenante (hotel), máx. 70. */
  name: string;
  /** NIF del ordenante (identificación OrgId/Othr). */
  taxId: string;
  iban: string;
  bic?: string;
};

export type SepaTransferCreditor = {
  name: string;
  iban: string;
  bic?: string;
  amount: number | string;
  /** Concepto para el beneficiario (máx. 140). */
  description: string;
  /** Referencia única (máx. 35). */
  endToEndId: string;
  /** Categoría: SUPP proveedores · SALA nóminas · OTHR. */
  category?: "SUPP" | "SALA" | "OTHR";
};

export type SepaTransferRemittance = {
  /** Fecha de ejecución solicitada YYYY-MM-DD. */
  executionDate: string;
  debtor: SepaTransferDebtor;
  creditors: SepaTransferCreditor[];
  /** true → el banco procesa cada transferencia individualmente (BtchBookg=false). */
  batchBooking?: boolean;
};

export type SepaTransferGeneration = {
  messageId: string;
  xml: string;
  control: { totalAmount: number; totalAmountCents: number; transactions: number };
};

export function generateSepaTransferRemittance(input: SepaTransferRemittance, options: { now?: Date; messageId?: string } = {}): SepaTransferGeneration {
  const now = options.now ?? new Date();
  const messageId = options.messageId ?? generateMessageId(input.debtor.taxId, now);
  let totalCents = 0;
  for (const c of input.creditors) totalCents += toCents(dec(c.amount));
  const total = fromCents(totalCents);
  const transactions = input.creditors.length;
  const paymentInfoId = sepaId(`${messageId}-PMT`);
  const createdAt = now.toISOString().replace(/\.\d{3}Z$/, "");
  const debtorAgent = input.debtor.bic ? `<DbtrAgt><FinInstnId><BIC>${escXml(input.debtor.bic.trim().toUpperCase())}</BIC></FinInstnId></DbtrAgt>` : "<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED</Id></Othr></FinInstnId></DbtrAgt>";

  const creditorsXml = input.creditors
    .map(
      (c) => `
      <CdtTrfTxInf>
        <PmtId>
          <EndToEndId>${escXml(sepaId(c.endToEndId))}</EndToEndId>
        </PmtId>
        ${c.category ? `<PmtTpInf><CtgyPurp><Cd>${c.category}</Cd></CtgyPurp></PmtTpInf>` : ""}
        <Amt><InstdAmt Ccy="EUR">${money(c.amount)}</InstdAmt></Amt>
        ${c.bic ? `<CdtrAgt><FinInstnId><BIC>${escXml(c.bic.trim().toUpperCase())}</BIC></FinInstnId></CdtrAgt>` : ""}
        <Cdtr><Nm>${escXml(sepaText(c.name, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${escXml(c.iban.replace(/\s/g, "").toUpperCase())}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${escXml(sepaText(c.description, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`
    )
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${escXml(messageId)}</MsgId>
      <CreDtTm>${createdAt}</CreDtTm>
      <NbOfTxs>${transactions}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <InitgPty>
        <Nm>${escXml(sepaText(input.debtor.name, 70))}</Nm>
        <Id><OrgId><Othr><Id>${escXml(sepaId(input.debtor.taxId))}</Id></Othr></OrgId></Id>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${escXml(paymentInfoId)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <BtchBookg>${input.batchBooking === false ? "false" : "true"}</BtchBookg>
      <NbOfTxs>${transactions}</NbOfTxs>
      <CtrlSum>${money(total)}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${input.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${escXml(sepaText(input.debtor.name, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${escXml(input.debtor.iban.replace(/\s/g, "").toUpperCase())}</IBAN></Id></DbtrAcct>
      ${debtorAgent}
      <ChrgBr>SLEV</ChrgBr>${creditorsXml}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;

  return { messageId, xml, control: { totalAmount: Number(money(total)), totalAmountCents: totalCents, transactions } };
}
