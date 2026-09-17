// Unit tests · Tanda 7b · L2 — parser de ficheros de ingresos de OPERA
// (apps/api/src/modules/pms-shadow/revenue-import.parser.ts). Sin base de datos.
// XML SINTÉTICO con los elementos literales de GEN_XMLBO_REVENUE (hotel RIAS,
// inventado) y ficheros findeptcodes / RESPONSYS_TRX inventados. Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/revenue-import-parser.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PMS_SHADOW_MAX_FILE_BYTES } from "@hotelos/shared";
import { HttpError } from "../../../lib/http-error.js";
import {
  FINDEPTCODES_DEFAULT_ELEMENTS,
  foldLabel,
  isSubtotalLabel,
  parseAmountFlexible,
  parseFeedDate,
  parseFindeptcodesDelimited,
  parseFindeptcodesXml,
  parseGenXmlboRevenue,
  parseResponsysTrx,
  parseRevenueFile,
  parseXmlAmount,
  revenueFileBytes,
  sniffRevenueSource
} from "../revenue-import.parser.js";

type Details = Record<string, unknown>;

function expectCode(fn: () => unknown, statusCode: number, code: string): Details {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof HttpError, `esperaba HttpError, llegó ${String(error)}`);
    assert.equal(error.statusCode, statusCode, `status de ${code}: ${error.message}`);
    const details = (error.details ?? {}) as Details;
    assert.equal(details.code, code, `details.code (${error.message})`);
    return details;
  }
  assert.fail(`esperaba ${statusCode} ${code}`);
}

/** XML sintético GEN_XMLBO_REVENUE del hotel RIAS, 2026-09-15: 7 transaction codes. */
export const XML_RIAS = `<?xml version="1.0" encoding="UTF-8"?>
<revenue hotel_code="RIAS" date="2026-09-15">
  <transaction_total transaction_type="REVENUE">
    <transaction_code>1000</transaction_code>
    <description>Lodging</description>
    <total_amount>1234.50</total_amount>
    <total_guest_ledger>1000.00</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>234.50</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
    <transaction_details>
      <transaction market_code="FIT" room_class="STD"><trx_amount>1000.00</trx_amount><trx_guest_ledger>1000.00</trx_guest_ledger></transaction>
      <transaction market_code="CORP" room_class="SUP"><trx_amount>234.50</trx_amount><trx_ar_ledger>234.50</trx_ar_ledger></transaction>
    </transaction_details>
  </transaction_total>
  <transaction_total transaction_type="REVENUE">
    <transaction_code>2000</transaction_code>
    <description>F&amp;B Restaurant</description>
    <total_amount>310.00</total_amount>
    <total_guest_ledger>310.00</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>0.00</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>
  <transaction_total transaction_type="REVENUE">
    <transaction_code>3000</transaction_code>
    <description>Minibar</description>
    <total_amount>25.00</total_amount>
    <total_guest_ledger>25.00</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>0.00</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>
  <transaction_total transaction_type="REVENUE">
    <transaction_code>8100</transaction_code>
    <description>IVA 10%</description>
    <total_amount>154.45</total_amount>
    <total_guest_ledger>131.00</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>23.45</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>
  <transaction_total transaction_type="REVENUE">
    <transaction_code>8200</transaction_code>
    <description>IVA 21%</description>
    <total_amount>5.25</total_amount>
    <total_guest_ledger>5.25</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>0.00</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>
  <transaction_total transaction_type="PAYMENT">
    <transaction_code>9000</transaction_code>
    <description>Cash</description>
    <total_amount>-900.00</total_amount>
    <total_guest_ledger>-900.00</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>0.00</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>
  <transaction_total transaction_type="PAID OUT">
    <transaction_code>9500</transaction_code>
    <description>Paid Out</description>
    <total_amount>40.00</total_amount>
    <total_guest_ledger>40.00</total_guest_ledger>
    <total_package_ledger>0.00</total_package_ledger>
    <total_ar_ledger>0.00</total_ar_ledger>
    <total_deposit_ledger>0.00</total_deposit_ledger>
  </transaction_total>
</revenue>
`;

/** Σ total_amount del XML: 1234.50 + 310.00 + 25.00 + 154.45 + 5.25 − 900.00 + 40.00. */
export const XML_RIAS_SUM = "869.20";

describe("parseGenXmlboRevenue · XML sintético RIAS", () => {
  it("hotel_code, date, 7 líneas con tipo, importe y ledgers; Σ total_amount", () => {
    const parsed = parseGenXmlboRevenue(XML_RIAS);
    assert.equal(parsed.source, "xml_revenue");
    assert.equal(parsed.hotelCode, "RIAS");
    assert.equal(parsed.businessDate, "2026-09-15");
    assert.equal(parsed.lines.length, 7);
    assert.deepEqual(
      parsed.lines.map((line) => [line.code, line.transactionType, line.amount]),
      [
        ["1000", "REVENUE", "1234.50"],
        ["2000", "REVENUE", "310.00"],
        ["3000", "REVENUE", "25.00"],
        ["8100", "REVENUE", "154.45"],
        ["8200", "REVENUE", "5.25"],
        ["9000", "PAYMENT", "-900.00"],
        ["9500", "PAID OUT", "40.00"]
      ]
    );
    assert.equal(parsed.lines[0]!.description, "Lodging");
    assert.equal(parsed.lines[1]!.description, "F&B Restaurant", "entidad &amp; decodificada");
    assert.deepEqual(parsed.lines[0]!.ledgers, { guest: "1000.00", package: "0.00", ar: "234.50", deposit: "0.00" });
    assert.deepEqual(parsed.lines[5]!.ledgers, { guest: "-900.00", package: "0.00", ar: "0.00", deposit: "0.00" });
    assert.equal(parsed.sumTotalAmount, XML_RIAS_SUM);
    assert.deepEqual(parsed.warnings, [], "el detalle por market code cuadra con total_amount");
  });

  it("bytes con BOM, prefijo de namespace y hotel_code / date como elementos hijos", () => {
    const xml = `<?xml version="1.0"?><o:revenue xmlns:o="urn:x"><hotel_code>RIAS</hotel_code><date>2026-09-15</date>
      <transaction_total><transaction_type>REVENUE</transaction_type><transaction_code>1000</transaction_code><description>Lodging</description><total_amount>10.00</total_amount></transaction_total>
    </o:revenue>`;
    const parsed = parseGenXmlboRevenue(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(xml, "utf8")]));
    assert.equal(parsed.hotelCode, "RIAS");
    assert.equal(parsed.businessDate, "2026-09-15");
    assert.equal(parsed.lines.length, 1);
    assert.deepEqual(parsed.lines[0]!.ledgers, { guest: "0.00", package: "0.00", ar: "0.00", deposit: "0.00" }, "ledgers ausentes → 0");
  });

  it("código repetido se suma con aviso; detalle que no cuadra avisa; tipo desconocido avisa; sin tipo → REVENUE", () => {
    const xml = `<revenue hotel_code="RIAS" date="2026-09-15">
      <transaction_total transaction_type="REVENUE"><transaction_code>1000</transaction_code><description>A</description><total_amount>10.00</total_amount>
        <transaction_details><transaction market_code="FIT"><trx_amount>4.00</trx_amount></transaction></transaction_details></transaction_total>
      <transaction_total transaction_type="REVENUE"><transaction_code>1000</transaction_code><description>A</description><total_amount>5.00</total_amount></transaction_total>
      <transaction_total transaction_type="WRAPPER"><transaction_code>7000</transaction_code><description>Pack</description><total_amount>1.00</total_amount></transaction_total>
      <transaction_total><transaction_code>7100</transaction_code><description>Sin tipo</description><total_amount>2.00</total_amount></transaction_total>
    </revenue>`;
    const parsed = parseGenXmlboRevenue(xml);
    assert.equal(parsed.lines.length, 3);
    assert.equal(parsed.lines[0]!.amount, "15.00");
    assert.equal(parsed.lines[1]!.transactionType, "WRAPPER");
    assert.equal(parsed.lines[2]!.transactionType, "REVENUE");
    assert.ok(parsed.warnings.some((w) => w.includes("aparece 2 veces")));
    assert.ok(parsed.warnings.some((w) => w.includes("Σ trx_amount")));
    assert.ok(parsed.warnings.some((w) => w.includes("WRAPPER")));
    assert.ok(parsed.warnings.some((w) => w.includes("7100") && w.includes("REVENUE")));
    assert.equal(parsed.sumTotalAmount, "18.00");
  });

  it("errores: XML roto, sin <revenue>, fecha mala, importe malo, sin códigos, DOCTYPE", () => {
    assert.equal(expectCode(() => parseGenXmlboRevenue("<revenue><transaction_total>"), 400, "PMS_SHADOW_FILE_UNREADABLE").reason, "XML_LITE_MALFORMED");
    assert.equal(expectCode(() => parseGenXmlboRevenue("<ingresos/>"), 400, "PMS_SHADOW_FILE_UNREADABLE").reason, "no_revenue_element");
    assert.equal(expectCode(() => parseGenXmlboRevenue('<revenue hotel_code="RIAS" date="15/09/2026x"><transaction_total transaction_type="REVENUE"><transaction_code>1</transaction_code><total_amount>1.00</total_amount></transaction_total></revenue>'), 400, "PMS_SHADOW_FILE_UNREADABLE").reason, "bad_date");
    assert.equal(expectCode(() => parseGenXmlboRevenue('<revenue hotel_code="RIAS" date="2026-09-15"><transaction_total transaction_type="REVENUE"><transaction_code>1</transaction_code><total_amount>1.234,50</total_amount></transaction_total></revenue>'), 400, "PMS_SHADOW_FILE_UNREADABLE").reason, "bad_amount");
    expectCode(() => parseGenXmlboRevenue('<revenue hotel_code="RIAS" date="2026-09-15"><transaction_total transaction_type="REVENUE"><description>sin código</description></transaction_total></revenue>'), 400, "PMS_SHADOW_REVENUE_EMPTY");
    const details = expectCode(() => parseGenXmlboRevenue('<!DOCTYPE revenue [<!ENTITY x "y">]><revenue hotel_code="RIAS" date="2026-09-15"><transaction_total transaction_type="REVENUE"><transaction_code>1</transaction_code><total_amount>&x;</total_amount></transaction_total></revenue>'), 400, "PMS_SHADOW_FILE_UNREADABLE");
    assert.equal(details.reason, "XML_LITE_DOCTYPE_REJECTED");
  });

  it("> 5 MiB → PMS_SHADOW_FILE_TOO_LARGE", () => {
    const details = expectCode(() => parseGenXmlboRevenue(new Uint8Array(PMS_SHADOW_MAX_FILE_BYTES + 1)), 400, "PMS_SHADOW_FILE_TOO_LARGE");
    assert.equal(details.max, PMS_SHADOW_MAX_FILE_BYTES);
    expectCode(() => revenueFileBytes({ contentBase64: Buffer.alloc(PMS_SHADOW_MAX_FILE_BYTES + 1, 0x41).toString("base64") }), 400, "PMS_SHADOW_FILE_TOO_LARGE");
    expectCode(() => parseFindeptcodesDelimited("x".repeat(PMS_SHADOW_MAX_FILE_BYTES + 1)), 400, "PMS_SHADOW_FILE_TOO_LARGE");
  });
});

const FINDEPT_CSV = [
  "Trn. Code;Description;Day Gross;Day Net;Month Gross;Month Net;Year Gross;Year Net",
  "1000;Lodging;1.358,03;1.234,50;30.000,00;27.272,73;300.000,00;272.727,27",
  ";Subtotal Lodging;1.358,03;1.234,50;30.000,00;27.272,73;300.000,00;272.727,27",
  "2000;Restaurant;341,00;310,00;9.000,00;8.181,82;90.000,00;81.818,18",
  "3000;Minibar;27,50;25,00;500,00;454,55;5.000,00;4.545,45",
  ";Subtotal F&B;368,50;335,00;9.500,00;8.636,37;95.000,00;86.363,63",
  "9000;Cash;-900,00;-900,00;-20.000,00;-20.000,00;-200.000,00;-200.000,00",
  "Total;Grand Total;826,53;669,50;19.500,00;15.909,10;195.000,00;159.090,90",
  ""
].join("\r\n");

describe("parseFindeptcodesDelimited · Delimited Data con subtotales", () => {
  it("usa Day Net, descarta subtotales y Grand Total, sin business date", () => {
    const parsed = parseFindeptcodesDelimited(FINDEPT_CSV);
    assert.equal(parsed.source, "findeptcodes_csv");
    assert.equal(parsed.hotelCode, null);
    assert.equal(parsed.businessDate, null);
    assert.deepEqual(
      parsed.lines.map((line) => [line.code, line.description, line.transactionType, line.amount]),
      [
        ["1000", "Lodging", "", "1234.50"],
        ["2000", "Restaurant", "", "310.00"],
        ["3000", "Minibar", "", "25.00"],
        ["9000", "Cash", "", "-900.00"]
      ]
    );
    assert.equal(parsed.sumTotalAmount, "669.50");
    assert.ok(parsed.warnings.some((w) => w.includes("3 fila(s) de subtotal")));
    assert.ok(parsed.warnings.some((w) => w.includes("business date")));
    assert.ok(!parsed.warnings.some((w) => w.includes("group-by")), "sin códigos repetidos no avisa de group-by");
  });

  it("filas duplicadas por el group-by → aviso y suma; sin Day Net usa Day Gross; cabecera ausente → ilegible", () => {
    const dup = "Trn. Code,Description,Day Gross,Day Net\n1000,Lodging,110.00,100.00\n1000,Lodging,110.00,100.00\n";
    const parsed = parseFindeptcodesDelimited(dup);
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.lines[0]!.amount, "200.00");
    assert.ok(parsed.warnings.some((w) => w.includes("group-by")));
    const gross = parseFindeptcodesDelimited("Trn. Code;Description;Day Gross\n1000;Lodging;110,00\n");
    assert.equal(gross.lines[0]!.amount, "110.00");
    assert.ok(gross.warnings.some((w) => w.includes("Day Gross")));
    assert.equal(expectCode(() => parseFindeptcodesDelimited("Codigo;Importe\n1;2\n"), 400, "PMS_SHADOW_FILE_UNREADABLE").reason, "missing_columns");
    expectCode(() => parseFindeptcodesDelimited("Trn. Code;Description;Day Net\n;Subtotal;1,00\nTotal;Grand Total;1,00\n"), 400, "PMS_SHADOW_REVENUE_EMPTY");
    expectCode(() => parseFindeptcodesDelimited("   "), 400, "PMS_SHADOW_REVENUE_EMPTY");
  });
});

describe("parseFindeptcodesXml · modelo de datos BI Publisher [S]", () => {
  const xml = `<?xml version="1.0"?><DATA_DS><P_BUSINESS_DATE>2026-09-15</P_BUSINESS_DATE><BUSINESS_DATE>2026-09-15</BUSINESS_DATE>
    <LIST_G_GROUP><G_GROUP><TRX_GROUP>ROOMS</TRX_GROUP>
      <LIST_G_CODE>
        <G_CODE><TRN_CODE>1000</TRN_CODE><DESCRIPTION>Lodging</DESCRIPTION><DAY_GROSS>1358.03</DAY_GROSS><DAY_NET>1234.50</DAY_NET><MONTH_NET>27272.73</MONTH_NET><YEAR_NET>272727.27</YEAR_NET></G_CODE>
        <G_CODE><TRN_CODE>1001</TRN_CODE><DESCRIPTION>Total Rooms Package</DESCRIPTION><DAY_NET>9.99</DAY_NET></G_CODE>
        <G_CODE><TRN_CODE>Total</TRN_CODE><DESCRIPTION>Total Rooms</DESCRIPTION><DAY_NET>1244.49</DAY_NET></G_CODE>
        <G_CODE><trn_code>2000</trn_code><description>Restaurant</description><day_gross>341.00</day_gross><day_net></day_net></G_CODE>
      </LIST_G_CODE>
      <SUM_DAY_NET>1234.50</SUM_DAY_NET></G_GROUP></LIST_G_GROUP></DATA_DS>`;

  it("filas por TRN_CODE (insensible a mayúsculas), Day Net, subtotal descartado SOLO por la columna de código (SC-10: «1001 · Total Rooms Package» se conserva), Day Gross de respaldo, business date", () => {
    const parsed = parseFindeptcodesXml(xml);
    assert.equal(parsed.source, "findeptcodes_xml");
    assert.equal(parsed.businessDate, "2026-09-15");
    assert.deepEqual(parsed.lines.map((line) => [line.code, line.amount]), [["1000", "1234.50"], ["1001", "9.99"], ["2000", "341.00"]]);
    assert.ok(parsed.warnings.some((w) => w.includes("1 fila(s) de subtotal")));
    assert.ok(parsed.warnings.some((w) => w.includes("DAY_GROSS")));
    assert.equal(parsed.sumTotalAmount, "1585.49");
    assert.equal(FINDEPTCODES_DEFAULT_ELEMENTS.code, "TRN_CODE");
  });

  it("mapa de nombres opcional y XML sin filas", () => {
    const parsed = parseFindeptcodesXml("<r><row><CODIGO>1000</CODIGO><TEXTO>Lodging</TEXTO><NETO_DIA>1.00</NETO_DIA></row></r>", { code: "CODIGO", description: "TEXTO", dayNet: "NETO_DIA" });
    assert.deepEqual(parsed.lines.map((line) => [line.code, line.description, line.amount]), [["1000", "Lodging", "1.00"]]);
    assert.equal(expectCode(() => parseFindeptcodesXml("<r><x>1</x></r>"), 400, "PMS_SHADOW_FILE_UNREADABLE").reason, "no_rows");
  });
});

describe("parseResponsysTrx · export agregado por REVENUE_TYPES", () => {
  const csv = [
    "TRANSACTION_DATE,TRANSACTION_ID,RESERVATION_ID,REVENUE_TYPES,REVENUE_AMOUNTS,CURRENCY",
    "20260915,T1,R1,ROOM,100.00,EUR",
    "20260915,T2,R1,ROOM,50.00,EUR",
    "20260915,T3,R2,FB,20.00,EUR",
    "20260915,T4,R3,\"ROOM|FB\",\"30.00|5.00\",EUR",
    ""
  ].join("\n");

  it("agrega por tipo (REVENUE), fecha única YYYYMMDD, sin ids persistidos", () => {
    const parsed = parseResponsysTrx(csv);
    assert.equal(parsed.source, "responsys_trx");
    assert.equal(parsed.businessDate, "2026-09-15");
    assert.deepEqual(parsed.lines.map((line) => [line.code, line.transactionType, line.amount]), [["FB", "REVENUE", "25.00"], ["ROOM", "REVENUE", "180.00"]]);
    assert.equal(parsed.sumTotalAmount, "205.00");
    assert.ok(!JSON.stringify(parsed).includes("R1"), "RESERVATION_ID no aparece en la salida");
  });

  it("dos fechas → 400 PMS_SHADOW_REVENUE_DAY_MISMATCH; sin columnas → ilegible; moneda distinta avisa", () => {
    const details = expectCode(() => parseResponsysTrx("TRANSACTION_DATE,REVENUE_TYPES,REVENUE_AMOUNTS\n2026-09-15,ROOM,1.00\n2026-09-16,ROOM,1.00\n"), 400, "PMS_SHADOW_REVENUE_DAY_MISMATCH");
    assert.deepEqual(details.dates, ["2026-09-15", "2026-09-16"]);
    expectCode(() => parseResponsysTrx("A,B\n1,2\n"), 400, "PMS_SHADOW_FILE_UNREADABLE");
    const parsed = parseResponsysTrx("TRANSACTION_DATE,REVENUE_TYPES,REVENUE_AMOUNTS,CURRENCY\n15/09/2026,ROOM,1.00,USD\n");
    assert.equal(parsed.businessDate, "2026-09-15");
    assert.ok(parsed.warnings.some((w) => w.includes("USD")));
  });
});

describe("sniffRevenueSource y parseRevenueFile", () => {
  it("xml con <revenue> → xml_revenue; xml con trn_code → findeptcodes_xml; csv «Trn. Code» → findeptcodes_csv; csv TRANSACTION_ID → responsys_trx", () => {
    assert.equal(sniffRevenueSource("x.xml", XML_RIAS.slice(0, 200)), "xml_revenue");
    assert.equal(sniffRevenueSource("findeptcodes.xml", "<DATA_DS><G><TRN_CODE>1</TRN_CODE></G></DATA_DS>"), "findeptcodes_xml");
    assert.equal(sniffRevenueSource(null, "<?xml version=\"1.0\"?><ns:revenue>"), "xml_revenue");
    assert.equal(sniffRevenueSource("findeptcodes.txt", FINDEPT_CSV.slice(0, 120)), "findeptcodes_csv");
    assert.equal(sniffRevenueSource("RESPONSYS_TRX_AUTO.csv", "TRANSACTION_DATE,TRANSACTION_ID,RESERVATION_ID,REVENUE_TYPES,REVENUE_AMOUNTS,CURRENCY\n"), "responsys_trx");
    assert.equal(sniffRevenueSource("otro.csv", "a,b\n1,2\n"), null);
    assert.equal(sniffRevenueSource("otro.xml", "<a/>"), null);
  });

  it("parseRevenueFile despacha por sniff, respeta source explícito y rechaza lo desconocido", () => {
    const auto = parseRevenueFile({ fileName: "GEN_XMLBO_REVENUE_RIAS.xml", content: XML_RIAS });
    assert.equal(auto.source, "xml_revenue");
    assert.equal(auto.parsed.lines.length, 7);
    assert.equal(auto.bytes.length, Buffer.byteLength(XML_RIAS, "utf8"));
    const explicit = parseRevenueFile({ source: "findeptcodes_csv", contentBase64: Buffer.from(FINDEPT_CSV, "utf8").toString("base64") });
    assert.equal(explicit.parsed.lines.length, 4);
    expectCode(() => parseRevenueFile({ content: "a,b\n1,2\n" }), 400, "PMS_SHADOW_FEED_UNKNOWN");
    expectCode(() => parseRevenueFile({}), 400, "PMS_SHADOW_REVENUE_EMPTY");
    const latin1 = parseRevenueFile({ source: "findeptcodes_csv", contentBase64: Buffer.concat([Buffer.from("Trn. Code;Description;Day Net\n1000;Alojamiento caf", "latin1"), Buffer.from([0xe9]), Buffer.from(";1,00\n", "latin1")]).toString("base64") });
    assert.equal(latin1.parsed.lines[0]!.description, "Alojamiento café");
    assert.ok(latin1.parsed.warnings.some((w) => w.includes("Windows-1252")));
  });
});

describe("helpers", () => {
  it("foldLabel, isSubtotalLabel, parseXmlAmount, parseAmountFlexible, parseFeedDate", () => {
    assert.equal(foldLabel("Trn. Code"), "trn_code");
    assert.equal(foldLabel("  Día Neto (€) "), "dia_neto");
    assert.ok(isSubtotalLabel("Subtotal Lodging"));
    assert.ok(isSubtotalLabel("GRAND TOTAL"));
    assert.ok(isSubtotalLabel("Total"));
    assert.ok(!isSubtotalLabel("Totales varios"));
    assert.ok(!isSubtotalLabel("Lodging"));
    assert.equal(parseXmlAmount("-900.00")!.toFixed(2), "-900.00");
    assert.equal(parseXmlAmount("−12.5")!.toFixed(2), "-12.50");
    assert.equal(parseXmlAmount("1,00"), null);
    assert.equal(parseAmountFlexible("1.234,56")!.toFixed(2), "1234.56");
    assert.equal(parseAmountFlexible("1,234.56")!.toFixed(2), "1234.56");
    assert.equal(parseAmountFlexible("(900,00)")!.toFixed(2), "-900.00");
    assert.equal(parseAmountFlexible("900,00-")!.toFixed(2), "-900.00");
    assert.equal(parseAmountFlexible("1234.5")!.toFixed(2), "1234.50");
    assert.equal(parseAmountFlexible("abc"), null);
    assert.equal(parseFeedDate("2026-09-15"), "2026-09-15");
    assert.equal(parseFeedDate("2026-09-15T00:00:00Z"), "2026-09-15");
    assert.equal(parseFeedDate("20260915"), "2026-09-15");
    assert.equal(parseFeedDate("15/09/2026"), "2026-09-15");
    assert.equal(parseFeedDate("2026-02-30"), null);
    assert.equal(parseFeedDate("hoy"), null);
  });
});
