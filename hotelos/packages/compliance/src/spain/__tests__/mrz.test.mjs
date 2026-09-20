// Unit tests for the pure MRZ parser (ICAO 9303 TD1 / TD2 / TD3) and the
// synthetic generator (Tanda CHK · lote CHK-W1-B, diseño §2.2 y §4a paso 3).
//
// Oracles: the check-digit examples of ICAO Doc 9303 Part 3 Appendix A and the
// fictional "UTOPIA" specimens of Parts 4/5/6 (ERIKSSON ANNA MARIA is ICAO's
// own invented holder, not a real person). Spanish documents are synthetic:
// invented names (PRUEBA / ANNA) and the textbook example number 12345678Z.
// No real personal data anywhere in this file.
//
// Run from packages/compliance:
//   node --experimental-strip-types --import ./src/spain/verifactu/__tests__/register-ts-loader.mjs \
//     --test src/spain/__tests__/mrz.test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MRZ_MAX_LINE_LENGTH, buildMrz, mrzCheckDigit, parseMrz } from "../mrz.ts";

/** Fixed reference date so the century rule is deterministic (pivot = 27). */
const TODAY = new Date("2026-09-19T00:00:00.000Z");
const parse = (lines) => parseMrz(lines, { today: TODAY });

/** ICAO Doc 9303 Part 4 specimen (TD3, 2×44). */
const TD3_SPECIMEN = ["P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"];
/** ICAO Doc 9303 Part 5 specimen (TD1, 3×30). */
const TD1_SPECIMEN = ["I<UTOD231458907<<<<<<<<<<<<<<<", "7408122F1204159UTO<<<<<<<<<<<6", "ERIKSSON<<ANNA<MARIA<<<<<<<<<<"];
/** ICAO Doc 9303 Part 6 specimen (TD2, 2×36). */
const TD2_SPECIMEN = ["I<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<", "D231458907UTO7408122F1204159<<<<<<<6"];
/** Synthetic Spanish DNI: support number BAA000123 in 6-14, DNI number in the optional field of line 1. */
const DNI_SYNTHETIC = ["IDESPBAA000123312345678Z<<<<<<", "9001158F3101159ESP<<<<<<<<<<<5", "PRUEBA<MODELO<<ANNA<<<<<<<<<<<"];

describe("mrzCheckDigit — ICAO 9303 P3 Appendix A", () => {
  it("520727 → 3 and AB2134<<< → 5 (weights 7-3-1 mod 10, < = 0, A-Z = 10-35)", () => {
    assert.equal(mrzCheckDigit("520727"), 3);
    assert.equal(mrzCheckDigit("AB2134<<<"), 5);
  });

  it("MRZ_MAX_LINE_LENGTH is the TD3 line length", () => {
    assert.equal(MRZ_MAX_LINE_LENGTH, 44);
  });
});

describe("parseMrz — TD3 (passport)", () => {
  it("ICAO specimen → valid, 5 checks true, date / sex / nationality / names", () => {
    const result = parse(TD3_SPECIMEN);
    assert.equal(result.format, "TD3");
    assert.equal(result.valid, true);
    assert.deepEqual(result.checks, { document: true, birth: true, expiry: true, composite: true, personal: true });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.corrections, []);
    assert.equal(result.fields.documentType, "PASSPORT");
    assert.equal(result.fields.documentCode, "P<");
    assert.equal(result.fields.issuingCountry, "UTO");
    assert.equal(result.fields.documentNumber, "L898902C3");
    assert.equal(result.fields.documentSupportNumber, undefined);
    assert.equal(result.fields.surname1, "ERIKSSON");
    assert.equal(result.fields.surname2, undefined);
    assert.equal(result.fields.firstName, "ANNA MARIA");
    assert.equal(result.fields.dateOfBirth, "1974-08-12");
    assert.equal(result.fields.sex, "M", "ICAO F → SES M (mujer)");
    assert.equal(result.fields.expiryDate, "2012-04-15");
    assert.equal(result.fields.nationality, "UTO");
    assert.equal(result.fields.optional1, "ZE184226B");
  });

  it("one altered digit in the document number → valid:false with checks.document=false", () => {
    const altered = [TD3_SPECIMEN[0], TD3_SPECIMEN[1].replace("L898902C3", "L898902C4")];
    const result = parse(altered);
    assert.equal(result.format, "TD3");
    assert.equal(result.valid, false);
    assert.equal(result.checks.document, false);
    assert.equal(result.checks.composite, false, "the composite covers the document number too");
    assert.equal(result.checks.birth, true);
    assert.equal(result.checks.expiry, true);
    assert.ok(result.errors.some((e) => e.includes("document")), result.errors.join(" | "));
  });

  it("O in the birth field and in the composite check digit → corrected to 0 and annotated", () => {
    const line2 = TD3_SPECIMEN[1];
    const withLetters = `${line2.slice(0, 13)}74O812${line2.slice(19, 43)}O`;
    assert.equal(withLetters.length, 44);
    const result = parse([TD3_SPECIMEN[0], withLetters]);
    assert.equal(result.valid, true);
    assert.equal(result.fields.dateOfBirth, "1974-08-12");
    assert.equal(result.checks.birth, true);
    assert.equal(result.checks.composite, true);
    assert.equal(result.corrections.length, 2, result.corrections.join(" | "));
    assert.ok(result.corrections.every((c) => c.includes("'O' → '0'")), result.corrections.join(" | "));
    assert.ok(result.corrections.some((c) => c.includes("nacimiento")), result.corrections.join(" | "));
  });

  it("I in a date field → corrected to 1; letters in alphabetic fields are never touched", () => {
    const line2 = TD3_SPECIMEN[1];
    const withI = `${line2.slice(0, 21)}I20415${line2.slice(27)}`;
    const result = parse([TD3_SPECIMEN[0], withI]);
    assert.equal(result.valid, true);
    assert.equal(result.fields.expiryDate, "2012-04-15");
    assert.equal(result.corrections.length, 1);
    assert.equal(result.fields.documentNumber, "L898902C3", "document number keeps its letters");
  });
});

describe("parseMrz — TD1 (ID cards) and Spanish documents", () => {
  it("ICAO specimen → valid, 4 checks true (no personal check in TD1)", () => {
    const result = parse(TD1_SPECIMEN);
    assert.equal(result.format, "TD1");
    assert.equal(result.valid, true);
    assert.deepEqual(result.checks, { document: true, birth: true, expiry: true, composite: true });
    assert.equal(result.fields.documentType, "ID_CARD");
    assert.equal(result.fields.documentNumber, "D23145890");
    assert.equal(result.fields.dateOfBirth, "1974-08-12");
    assert.equal(result.fields.expiryDate, "2012-04-15");
    assert.equal(result.fields.surname1, "ERIKSSON");
    assert.equal(result.fields.firstName, "ANNA MARIA");
  });

  it("synthetic DNI → both candidates (support in 6-14, DNI in optional) and documentType DNI", () => {
    const result = parse(DNI_SYNTHETIC);
    assert.equal(result.format, "TD1");
    assert.equal(result.valid, true, result.errors.join(" | "));
    assert.deepEqual(result.checks, { document: true, birth: true, expiry: true, composite: true });
    assert.equal(result.fields.documentType, "DNI");
    assert.equal(result.fields.documentCode, "ID");
    assert.equal(result.fields.issuingCountry, "ESP");
    assert.equal(result.fields.documentSupportNumber, "BAA000123");
    assert.equal(result.fields.documentNumber, "12345678Z");
    assert.equal(result.fields.optional1, "12345678Z");
    assert.equal(result.fields.surname1, "PRUEBA");
    assert.equal(result.fields.surname2, "MODELO");
    assert.equal(result.fields.firstName, "ANNA");
    assert.equal(result.fields.dateOfBirth, "1990-01-15");
    assert.equal(result.fields.sex, "M");
    assert.equal(result.fields.expiryDate, "2031-01-15");
    assert.equal(result.fields.nationality, "ESP");
  });

  it("TIE (support E…) → TIE with the NIE as documentNumber; NIE-shaped optional without E support → NIE", () => {
    const tie = buildMrz({ format: "TD1", documentType: "TIE", issuingCountry: "ESP", documentNumber: "X1234567L", supportNumber: "E12345678", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1999-12-31", sex: "H", expiryDate: "2029-06-30", nationality: "UTO" });
    const tieResult = parse(tie);
    assert.equal(tieResult.valid, true);
    assert.equal(tieResult.fields.documentType, "TIE");
    assert.equal(tieResult.fields.documentNumber, "X1234567L");
    assert.equal(tieResult.fields.documentSupportNumber, "E12345678");
    assert.equal(tieResult.fields.sex, "H", "ICAO M → SES H (hombre)");

    const nie = buildMrz({ format: "TD1", documentType: "NIE", issuingCountry: "ESP", documentNumber: "Y7654321X", supportNumber: "CAA000321", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1999-12-31", sex: "O", expiryDate: "2029-06-30", nationality: "UTO" });
    const nieResult = parse(nie);
    assert.equal(nieResult.valid, true);
    assert.equal(nieResult.fields.documentType, "NIE");
    assert.equal(nieResult.fields.documentNumber, "Y7654321X");
    assert.equal(nieResult.fields.documentSupportNumber, "CAA000321");
    assert.equal(nieResult.fields.sex, "O", "ICAO < → SES O");
  });

  it("extended document number (check digit 15 = <, number continues in the optional field, P5 §4.2.2)", () => {
    const number = "ABCDEFGHIJK";
    const line1 = `I<UTO${number.slice(0, 9)}<${number.slice(9)}${mrzCheckDigit(number)}`.padEnd(30, "<");
    const line2Body = "7408122F1204159UTO<<<<<<<<<<<";
    const composite = mrzCheckDigit(line1.slice(5, 30) + line2Body.slice(0, 7) + line2Body.slice(8, 15) + line2Body.slice(18, 29));
    const result = parse([line1, `${line2Body}${composite}`, "PRUEBA<<ANNA<<<<<<<<<<<<<<<<<<"]);
    assert.equal(result.valid, true, result.errors.join(" | "));
    assert.equal(result.fields.documentNumber, number);
    assert.equal(result.fields.optional1, undefined);
  });
});

describe("parseMrz — TD2", () => {
  it("ICAO specimen → valid, 4 checks true", () => {
    const result = parse(TD2_SPECIMEN);
    assert.equal(result.format, "TD2");
    assert.equal(result.valid, true);
    assert.deepEqual(result.checks, { document: true, birth: true, expiry: true, composite: true });
    assert.equal(result.fields.documentNumber, "D23145890");
    assert.equal(result.fields.nationality, "UTO");
    assert.equal(result.fields.dateOfBirth, "1974-08-12");
    assert.equal(result.fields.sex, "M");
    assert.equal(result.fields.surname1, "ERIKSSON");
    assert.equal(result.fields.firstName, "ANNA MARIA");
    assert.equal(result.fields.optional1, undefined);
  });
});

describe("parseMrz — input normalisation", () => {
  it("lower case, spaces, « » and CRLF are normalised; a 90-character reader string is split into 3×30", () => {
    const messy = `${TD1_SPECIMEN[0].toLowerCase().replace(/</g, "«")}\r\n ${TD1_SPECIMEN[1].slice(0, 10)} ${TD1_SPECIMEN[1].slice(10)} \r\n${TD1_SPECIMEN[2]}`;
    assert.equal(parse(messy).valid, true);
    assert.equal(parse(TD1_SPECIMEN.join("")).format, "TD1");
    assert.equal(parse(TD1_SPECIMEN.join("")).valid, true);
    assert.equal(parse(TD3_SPECIMEN.join("")).format, "TD3");
    assert.equal(parse(TD2_SPECIMEN.join("")).format, "TD2");
  });

  it("1 line, odd lengths, empty or garbage input → format:null, errors non-empty, no exception", () => {
    for (const input of ["P<UTOPRUEBA<<ANNA", ["ABC", "DEF"], "", [], ["A".repeat(30), "B".repeat(30), "C".repeat(29)], ["A".repeat(40), "B".repeat(40)], undefined]) {
      let result;
      assert.doesNotThrow(() => {
        result = parse(input);
      });
      assert.equal(result.format, null, JSON.stringify(input));
      assert.equal(result.valid, false);
      assert.equal(result.fields, null);
      assert.ok(result.errors.length > 0, JSON.stringify(input));
      assert.deepEqual(result.checks, { document: false, birth: false, expiry: false, composite: false });
    }
  });

  it("characters outside [A-Z0-9<] are reported and every check fails, still without throwing", () => {
    const result = parse(["%".repeat(44), "%".repeat(44)]);
    assert.equal(result.format, "TD3");
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("fuera de [A-Z0-9<]")), result.errors.join(" | "));
    assert.equal(result.fields.dateOfBirth, "");
    assert.equal(result.fields.expiryDate, "");
  });
});

describe("parseMrz — century rule", () => {
  it("expiry 26 → 2026; birth 99 → 1999; birth 27 → 2027 and 28 → 1928 with today = 2026 (pivot = year + 1)", () => {
    const lines = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1999-02-28", sex: "M", expiryDate: "2026-11-05", nationality: "UTO" });
    const result = parse(lines);
    assert.equal(result.valid, true);
    assert.equal(result.fields.dateOfBirth, "1999-02-28");
    assert.equal(result.fields.expiryDate, "2026-11-05");

    const born2027 = parse(buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Prueba", givenNames: "Anna", dateOfBirth: "2027-01-01", sex: "M", expiryDate: "2036-01-01", nationality: "UTO" }));
    assert.equal(born2027.fields.dateOfBirth, "2027-01-01");
    assert.equal(born2027.fields.expiryDate, "2036-01-01");

    const born1928 = parse(buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1928-01-01", sex: "M", expiryDate: "2036-01-01", nationality: "UTO" }));
    assert.equal(born1928.fields.dateOfBirth, "1928-01-01");
  });

  it("impossible dates (month 13, 31 February) → empty field with an error, no exception", () => {
    const line2 = TD3_SPECIMEN[1];
    const badMonth = parse([TD3_SPECIMEN[0], `${line2.slice(0, 13)}741312${line2.slice(19)}`]);
    assert.equal(badMonth.fields.dateOfBirth, "");
    assert.ok(badMonth.errors.some((e) => e.includes("nacimiento")), badMonth.errors.join(" | "));
    const badDay = parse([TD3_SPECIMEN[0], `${line2.slice(0, 13)}740231${line2.slice(19)}`]);
    assert.equal(badDay.fields.dateOfBirth, "");
    assert.equal(badDay.valid, false);
  });
});

describe("buildMrz ∘ parseMrz — identity", () => {
  const cases = [
    { format: "TD1", documentType: "DNI", issuingCountry: "ESP", documentNumber: "12345678Z", supportNumber: "BAA000123", surname: "Prueba Modelo", givenNames: "Anna", dateOfBirth: "1990-01-15", sex: "M", expiryDate: "2031-01-15", nationality: "ESP" },
    { format: "TD1", documentType: "ID_CARD", issuingCountry: "UTO", documentNumber: "D23145890", surname: "Prueba", givenNames: "Anna Maria", dateOfBirth: "1974-08-12", sex: "H", expiryDate: "2030-04-15", nationality: "UTO" },
    { format: "TD2", documentType: "ID_CARD", issuingCountry: "UTO", documentNumber: "AB123456", surname: "Prueba", givenNames: "Anna", dateOfBirth: "2005-07-04", sex: "M", expiryDate: "2030-07-04", nationality: "UTO" },
    { format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Prueba", givenNames: "Anna Maria", dateOfBirth: "1999-02-28", sex: "O", expiryDate: "2026-11-05", nationality: "UTO" }
  ];

  for (const input of cases) {
    it(`${input.format} ${input.documentType}: line lengths, all checks true and every field round-trips`, () => {
      const lines = buildMrz(input);
      const expectedLength = input.format === "TD1" ? 30 : input.format === "TD2" ? 36 : 44;
      assert.equal(lines.length, input.format === "TD1" ? 3 : 2);
      for (const line of lines) {
        assert.equal(line.length, expectedLength, line);
        assert.match(line, /^[A-Z0-9<]+$/);
      }
      const result = parse(lines);
      assert.equal(result.format, input.format);
      assert.equal(result.valid, true, result.errors.join(" | "));
      assert.ok(Object.values(result.checks).every(Boolean));
      assert.deepEqual(result.corrections, []);
      const [surname1, ...rest] = input.surname.toUpperCase().split(" ");
      assert.equal(result.fields.documentType, input.documentType);
      assert.equal(result.fields.issuingCountry, input.issuingCountry);
      assert.equal(result.fields.documentNumber, input.documentNumber);
      assert.equal(result.fields.documentSupportNumber, input.supportNumber);
      assert.equal(result.fields.surname1, surname1);
      assert.equal(result.fields.surname2, rest.length ? rest.join(" ") : undefined);
      assert.equal(result.fields.firstName, input.givenNames.toUpperCase());
      assert.equal(result.fields.dateOfBirth, input.dateOfBirth);
      assert.equal(result.fields.sex, input.sex);
      assert.equal(result.fields.expiryDate, input.expiryDate);
      assert.equal(result.fields.nationality, input.nationality);
    });
  }

  it("transliterates diacritics and rejects impossible inputs instead of emitting a broken MRZ", () => {
    const lines = buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Núñez-Prueba", givenNames: "Añña", dateOfBirth: "1999-02-28", sex: "M", expiryDate: "2026-11-05", nationality: "UTO" });
    assert.ok(lines[0].startsWith("P<UTONUNEZ<PRUEBA<<ANNA<"), lines[0]);
    assert.equal(parse(lines).valid, true);
    assert.throws(() => buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "TOOLONG123456", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1999-02-28", sex: "M", expiryDate: "2026-11-05", nationality: "UTO" }), /supera 9 caracteres/);
    assert.throws(() => buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Prueba", givenNames: "Anna", dateOfBirth: "28/02/1999", sex: "M", expiryDate: "2026-11-05", nationality: "UTO" }), /YYYY-MM-DD/);
    assert.throws(() => buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", supportNumber: "BAA000123", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1999-02-28", sex: "M", expiryDate: "2026-11-05", nationality: "UTO" }), /supportNumber solo aplica a TD1/);
    assert.throws(() => buildMrz({ format: "TD3", documentType: "PASSPORT", issuingCountry: "UTO", documentNumber: "XA1234567", surname: "Prueba", givenNames: "Anna", dateOfBirth: "1999-02-28", sex: "F", expiryDate: "2026-11-05", nationality: "UTO" }), /fuera de H\|M\|O/);
  });
});
