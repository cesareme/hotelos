import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyDocument,
  extractEntities,
  generateMappings,
  summariseMappings
} from "@hotelos/ai-tools";

describe("extraction engine — CSV room list", () => {
  it("parses a CSV room list into typed room entities with expected fields", () => {
    const content = [
      "Room,Type,Floor,Building,Status",
      "101,DBL,1,Main,clean",
      "102,TWIN,1,Main,clean",
      "201,SUITE,2,Main,dirty"
    ].join("\n");

    const result = extractEntities({
      fileName: "room_list.csv",
      fileType: "text/csv",
      content,
      detectedDocumentType: "room_list"
    });

    assert.equal(result.entities.length, 3);
    for (const entity of result.entities) {
      assert.equal(entity.entityType, "room");
    }
    const first = result.entities[0]!;
    assert.equal(first.fields.roomNumber, "101");
    assert.equal(first.fields.roomType, "DBL");
    assert.equal(first.fields.floor, "1");
    assert.equal(first.fields.building, "Main");
    assert.equal(first.fields.status, "clean");
    assert.equal(first.warnings.length, 0);
    // All 5 expected fields matched -> full confidence.
    assert.equal(first.confidence, 1);
    assert.equal(first.sourceRef, "row:1");

    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.byType.room, 3);
    assert.equal(result.summary.avgConfidence, 1);
    assert.equal(result.summary.warningsCount, 0);
  });

  it("detects a tab-delimited (TSV) room list", () => {
    const content = ["Room\tType\tFloor", "301\tSGL\t3"].join("\n");
    const result = extractEntities({
      fileName: "rooms.tsv",
      fileType: "text/tab-separated-values",
      content,
      detectedDocumentType: "room_list"
    });
    assert.equal(result.entities.length, 1);
    assert.equal(result.entities[0]!.fields.roomNumber, "301");
    assert.equal(result.entities[0]!.fields.roomType, "SGL");
  });
});

describe("extraction engine — missing columns lower confidence + warn (no invention)", () => {
  it("warns about a missing required field and never invents a value", () => {
    // No "Type" column -> roomType (required) is missing.
    const content = ["Room,Floor", "101,1", "102,2"].join("\n");
    const result = extractEntities({
      fileName: "room_list.csv",
      fileType: "text/csv",
      content,
      detectedDocumentType: "room_list"
    });

    const entity = result.entities[0]!;
    // roomNumber + floor matched of 5 expected -> 2/5 = 0.4.
    assert.equal(entity.confidence, 0.4);
    assert.ok(entity.confidence < 1, "missing columns must lower confidence");
    assert.ok(entity.warnings.some((w) => w.includes("roomType")), "should warn about the missing roomType");
    // The missing field is genuinely absent — not invented.
    assert.equal("roomType" in entity.fields, false);
    assert.equal(entity.fields.roomNumber, "101");
  });

  it("does not write empty cells as field values", () => {
    const content = ["Room,Type,Floor", "101,DBL,"].join("\n");
    const result = extractEntities({
      fileName: "room_list.csv",
      fileType: "text/csv",
      content,
      detectedDocumentType: "room_list"
    });
    const entity = result.entities[0]!;
    assert.equal("floor" in entity.fields, false, "empty cell must not become a value");
    assert.equal(entity.fields.roomType, "DBL");
  });
});

describe("extraction engine — JSON array", () => {
  it("extracts typed guest entities from a JSON array of objects", () => {
    const content = JSON.stringify([
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", nationality: "GB" },
      { firstName: "Alan", lastName: "Turing", nationality: "GB" }
    ]);
    const result = extractEntities({
      fileName: "guests.json",
      fileType: "application/json",
      content,
      detectedDocumentType: "guest_export"
    });

    assert.equal(result.entities.length, 2);
    assert.equal(result.entities[0]!.entityType, "guest");
    assert.equal(result.entities[0]!.fields.firstName, "Ada");
    assert.equal(result.entities[0]!.fields.surname, "Lovelace");
    assert.equal(result.entities[0]!.fields.email, "ada@example.com");
    // Second guest is missing email/documentNumber -> still no invention.
    assert.equal("email" in result.entities[1]!.fields, false);
  });

  it("falls back to generic records when no document type is given", () => {
    const content = JSON.stringify([{ anything: "x", count: 3 }]);
    const result = extractEntities({ fileName: "data.json", fileType: "application/json", content });
    assert.equal(result.entities[0]!.entityType, "record");
    assert.equal(result.entities[0]!.fields.anything, "x");
    assert.equal(result.entities[0]!.fields.count, 3);
  });
});

describe("extraction engine — determinism + empty input", () => {
  it("produces stable ids for identical content", () => {
    const content = ["Room,Type", "101,DBL"].join("\n");
    const a = extractEntities({ fileName: "r.csv", fileType: "text/csv", content, detectedDocumentType: "room_list" });
    const b = extractEntities({ fileName: "r.csv", fileType: "text/csv", content, detectedDocumentType: "room_list" });
    assert.equal(a.entities[0]!.id, b.entities[0]!.id);
  });

  it("returns no entities for empty content", () => {
    const result = extractEntities({ fileName: "empty.csv", fileType: "text/csv", content: "" });
    assert.equal(result.entities.length, 0);
    assert.equal(result.summary.total, 0);
    assert.equal(result.summary.avgConfidence, 0);
  });
});

describe("mapping engine — catalog fuzzy matching + confidence", () => {
  it("maps an exact room-type alias (DBL) to Double Room at high confidence", () => {
    const entities = extractEntities({
      fileName: "rooms.csv",
      fileType: "text/csv",
      content: ["Room,Type", "101,DBL"].join("\n"),
      detectedDocumentType: "room_list"
    }).entities;

    const suggestions = generateMappings({ entities, target: "room_type" });
    assert.equal(suggestions.length, 1);
    const suggestion = suggestions[0]!;
    assert.equal(suggestion.mappingType, "room_type");
    assert.equal(suggestion.sourceValue, "DBL");
    assert.equal(suggestion.targetValue, "Double Room");
    assert.equal(suggestion.confidence, 0.95);
    assert.equal(suggestion.status, "pending");
  });

  it("flags an unknown room code with low confidence + a no-match rationale", () => {
    const entities = extractEntities({
      fileName: "rooms.csv",
      fileType: "text/csv",
      content: ["Room,Type", "101,ZZZQQ"].join("\n"),
      detectedDocumentType: "room_list"
    }).entities;

    const suggestions = generateMappings({ entities, target: "room_type" });
    const suggestion = suggestions[0]!;
    assert.equal(suggestion.targetValue, "");
    assert.equal(suggestion.confidence, 0.3);
    assert.ok(suggestion.rationale.toLowerCase().includes("no catalog match"));
  });

  it("fuzzy-matches a near-miss rate code (NREFF) to Non-refundable", () => {
    const entities = extractEntities({
      fileName: "rates.csv",
      fileType: "text/csv",
      content: ["Code,Name", "NREFF,Advance Saver"].join("\n"),
      detectedDocumentType: "rate_sheet"
    }).entities;
    const suggestions = generateMappings({ entities, target: "rate_plan" });
    const suggestion = suggestions[0]!;
    assert.equal(suggestion.targetValue, "Non-refundable");
    assert.equal(suggestion.confidence, 0.7);
  });

  it("auto mode summarises across mapping types", () => {
    const entities = extractEntities({
      fileName: "rooms.csv",
      fileType: "text/csv",
      content: ["Room,Type", "101,DBL", "102,TWIN", "103,UNKNOWN"].join("\n"),
      detectedDocumentType: "room_list"
    }).entities;
    const suggestions = generateMappings({ entities });
    const summary = summariseMappings(suggestions);
    assert.equal(summary.total, suggestions.length);
    assert.ok(summary.lowConfidence >= 1, "the UNKNOWN room type should count as low confidence");
  });
});

describe("classifier engine — header + keyword heuristics", () => {
  it("classifies a room list from its header", () => {
    const result = classifyDocument({
      fileName: "export.csv",
      fileType: "text/csv",
      content: ["Room,Type,Floor", "101,DBL,1"].join("\n")
    });
    assert.equal(result.detectedDocumentType, "room_list");
    assert.ok(result.confidence > 0.6);
  });

  it("falls back to the filename when content gives no signal", () => {
    const result = classifyDocument({
      fileName: "guest_export.csv",
      fileType: "text/csv",
      content: ["a,b,c", "1,2,3"].join("\n")
    });
    assert.equal(result.detectedDocumentType, "guest_export");
    assert.ok(result.warnings.length >= 1);
  });
});
