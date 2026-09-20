import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

// Tanda L6b · L6b-01 (asistente unificado): contrato de esquema, migración y PII de
// la memoria conversacional SIN base de datos. Lo que sí necesita BD (columna a
// columna) lo cubren `db:drift:check` y `db:install:check`. La migración se localiza
// por sufijo porque la fusión puede renumerar la marca (como hizo CHK).

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migrationsDir = new URL("../packages/database/prisma/migrations/", import.meta.url);
const folders = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const migrationFolders = folders.filter((name) => name.endsWith("_asistente_unificado"));
const checkinFolders = folders.filter((name) => name.endsWith("_checkin_pago_en_recepcion"));

const schema = read("packages/database/prisma/schema.prisma");
const crypto = read("packages/database/src/crypto-fields.ts");

const TABLES = {
  AssistantConversation: "assistant_conversations",
  AssistantMessage: "assistant_messages"
};

const INDEXES = [
  'CREATE INDEX "assistant_conversations_organization_id_property_id_user_id_idx" ON "assistant_conversations"("organization_id", "property_id", "user_id", "last_message_at")',
  'CREATE INDEX "assistant_messages_conversation_id_created_at_idx" ON "assistant_messages"("conversation_id", "created_at")'
];

// Columnas exactas (nombre SQL → tipo DDL) de cada tabla: ni una más ni una menos.
const COLUMNS = {
  assistant_conversations: {
    id: "TEXT NOT NULL",
    organization_id: "TEXT NOT NULL",
    property_id: "TEXT NOT NULL",
    user_id: "TEXT NOT NULL",
    surface: "TEXT NOT NULL",
    title: "TEXT NOT NULL",
    screen_context_json: "JSONB",
    status: "TEXT NOT NULL DEFAULT 'open'",
    last_message_at: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
    created_at: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP",
    updated_at: "TIMESTAMP(3) NOT NULL"
  },
  assistant_messages: {
    id: "TEXT NOT NULL",
    conversation_id: "TEXT NOT NULL",
    role: "TEXT NOT NULL",
    content: "TEXT NOT NULL",
    tool_calls_json: "JSONB",
    routed_by: "TEXT",
    model: "TEXT",
    tokens_input: "INTEGER",
    tokens_output: "INTEGER",
    cost_eur: "DECIMAL(12,6)",
    created_at: "TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP"
  }
};

// Vocabularios de la tanda (brief L6b · objetivos 1, 3 y 4): tres superficies sobre el
// mismo núcleo, estado de la conversación, rol del mensaje y quién enrutó la respuesta
// (reglas sin proveedor / modelo). Son la fuente para los `as const` del contrato wire.
const VOCABULARIES = {
  ASSISTANT_SURFACES: ["backoffice", "reception", "guest"],
  ASSISTANT_CONVERSATION_STATUSES: ["open", "archived"],
  ASSISTANT_MESSAGE_ROLES: ["user", "assistant", "tool"],
  ASSISTANT_ROUTED_BY: ["rules", "model"]
};
const VOCABULARY_FIELDS = [
  ["ASSISTANT_SURFACES", "AssistantConversation", "surface"],
  ["ASSISTANT_CONVERSATION_STATUSES", "AssistantConversation", "status"],
  ["ASSISTANT_MESSAGE_ROLES", "AssistantMessage", "role"],
  ["ASSISTANT_ROUTED_BY", "AssistantMessage", "routedBy"]
];

const count = (source, re) => (source.match(re) ?? []).length;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const modelBlock = (model) => {
  const match = new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "m").exec(schema);
  assert.ok(match, `model ${model} no está en schema.prisma`);
  return match[0];
};
// Valores del `///` inmediatamente anterior al campo (se ignora un paréntesis final).
const docValues = (model, field) => {
  const match = new RegExp(`^  /// ([^\\n]+)\\n  ${field}\\s`, "m").exec(modelBlock(model));
  assert.ok(match, `${model}.${field} debe llevar un /// con sus valores`);
  return match[1].replace(/\s*\(.*$/, "").split("|").map((value) => value.trim());
};

describe("Asistente unificado · memoria: esquema, migración y PII (Tanda L6b · L6b-01)", () => {
  const migrationFolder = migrationFolders[0];
  const migration = migrationFolder ? readFileSync(new URL(`${migrationFolder}/migration.sql`, migrationsDir), "utf8") : "";
  // DDL sin la cabecera comentada (la cabecera menciona a propósito los DROP de reversión).
  const ddl = migration.replace(/^--.*$/gm, "");
  const tableBody = (table) => {
    const match = new RegExp(`^CREATE TABLE "${table}" \\(\\n([\\s\\S]*?)^\\);`, "m").exec(ddl);
    assert.ok(match, `CREATE TABLE ${table}`);
    return match[1];
  };

  it("hay UNA migración *_asistente_unificado, con marca de 14 dígitos posterior a la última de CHK y cabecera con el comando y la reversión", () => {
    assert.equal(migrationFolders.length, 1, `esperaba una carpeta *_asistente_unificado, hay ${migrationFolders.length}`);
    assert.match(migrationFolder, /^\d{14}_asistente_unificado$/);
    assert.equal(checkinFolders.length, 1, "la migración de CHK (checkin_pago_en_recepcion) debe seguir en el árbol");
    assert.ok(migrationFolder > checkinFolders[0], `${migrationFolder} debe ser posterior a ${checkinFolders[0]}`);
    assert.match(migration, /--from-schema-datasource prisma\/schema\.prisma/);
    assert.match(migration, /Reversible/);
    // Reversión documentada en comentario y en el orden que exige la FK.
    const dropMessages = migration.indexOf('--   DROP TABLE "assistant_messages";');
    const dropConversations = migration.indexOf('--   DROP TABLE "assistant_conversations";');
    assert.ok(dropMessages > 0 && dropConversations > dropMessages, "la cabecera lista los dos DROP TABLE, mensajes antes que conversaciones");
    assert.match(migration, /PII_FIELDS\.AssistantMessage/);
  });

  it("declara los 2 modelos junto a AiToolCall con su @@map y la migración crea exactamente esas 2 tablas", () => {
    for (const [model, table] of Object.entries(TABLES)) {
      assert.match(modelBlock(model), new RegExp(`@@map\\("${table}"\\)`), `${model} → ${table}`);
      assert.match(ddl, new RegExp(`^CREATE TABLE "${table}" \\($`, "m"), `CREATE TABLE ${table}`);
    }
    assert.equal(count(ddl, /^CREATE TABLE "/gm), 2);
    const aiToolCall = schema.indexOf("\nmodel AiToolCall {");
    const conversation = schema.indexOf("\nmodel AssistantConversation {");
    const message = schema.indexOf("\nmodel AssistantMessage {");
    assert.ok(aiToolCall > 0 && conversation > aiToolCall && message > conversation, "AssistantConversation y AssistantMessage van justo detrás de AiToolCall");
    assert.equal(schema.indexOf("model EventStream {") > message, true);
  });

  it("aditiva y reversible: 0 enums, 0 columnas en tablas existentes, 0 DROP, 0 backfill; 2 índices + 1 FK ON DELETE CASCADE", () => {
    assert.equal(count(ddl, /^CREATE TYPE /gm), 0, "surface/status/role/routed_by son String documentados con ///");
    assert.equal(count(ddl, /^DROP /gm), 0);
    assert.equal(count(ddl, /ADD COLUMN/g), 0);
    assert.equal(count(ddl, /^(INSERT|UPDATE|DELETE) /gm), 0);
    assert.doesNotMatch(ddl, /DO \$\$/);
    assert.doesNotMatch(ddl, /"ai_tool_calls"/, "ai_tool_calls.conversation_id sigue siendo una referencia libre: sin FK ni columnas nuevas");
    for (const index of INDEXES) assert.match(ddl, new RegExp(`^${escape(index)};$`, "m"), index);
    assert.equal(count(ddl, /^CREATE (UNIQUE )?INDEX "/gm), INDEXES.length);
    assert.equal(count(ddl, /^ALTER TABLE /gm), 1);
    assert.match(
      ddl,
      /^ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_fkey" FOREIGN KEY \("conversation_id"\) REFERENCES "assistant_conversations"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE;$/m
    );
    const conversation = modelBlock("AssistantConversation");
    const message = modelBlock("AssistantMessage");
    assert.match(message, /^  conversation AssistantConversation @relation\(fields: \[conversationId\], references: \[id\], onDelete: Cascade\)$/m);
    assert.match(conversation, /^  messages AssistantMessage\[\]$/m);
    assert.match(conversation, /^  @@index\(\[organizationId, propertyId, userId, lastMessageAt\]\)$/m);
    assert.match(message, /^  @@index\(\[conversationId, createdAt\]\)$/m);
    assert.doesNotMatch(modelBlock("AiToolCall"), /@relation/, "AiToolCall no gana relaciones en este lote");
  });

  it("las dos tablas llevan exactamente las columnas previstas (tipos DDL) y los campos Prisma con su @map", () => {
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const body = tableBody(table);
      for (const [column, type] of Object.entries(columns)) {
        assert.match(body, new RegExp(`^    "${column}" ${escape(type)},?$`, "m"), `${table}.${column} ${type}`);
      }
      assert.equal(count(body, /^    "\w+" /gm), Object.keys(columns).length, `${table}: número exacto de columnas`);
      assert.match(body, new RegExp(`CONSTRAINT "${table}_pkey" PRIMARY KEY \\("id"\\)`));
    }
    const conversation = modelBlock("AssistantConversation");
    assert.match(conversation, /^  screenContextJson\s+Json\?\s+@map\("screen_context_json"\)$/m);
    assert.match(conversation, /^  lastMessageAt\s+DateTime\s+@default\(now\(\)\) @map\("last_message_at"\)$/m);
    assert.match(conversation, /^  updatedAt\s+DateTime\s+@updatedAt @map\("updated_at"\)$/m);
    const message = modelBlock("AssistantMessage");
    assert.match(message, /^  toolCallsJson\s+Json\?\s+@map\("tool_calls_json"\)$/m);
    assert.match(message, /^  costEur\s+Decimal\?\s+@db\.Decimal\(12, 6\) @map\("cost_eur"\)$/m);
    assert.match(message, /^  tokensInput\s+Int\?\s+@map\("tokens_input"\)$/m);
    assert.match(message, /^  tokensOutput\s+Int\?\s+@map\("tokens_output"\)$/m);
    assert.match(message, /^  model\s+String\?$/m);
    // Trazabilidad (brief · objetivo 4): el /// de toolCallsJson fija la forma { tool, source, aiToolCallId }.
    assert.match(message, /\{ tool, source, aiToolCallId \}/);
  });

  it("PII: AssistantMessage.content y AssistantConversation.title son String obligatorios cifrados por PII_FIELDS, sin columna de lookup hash", () => {
    const pii = /PII_FIELDS[\s\S]*?\n  AssistantMessage: \[([\s\S]*?)\]/.exec(crypto);
    assert.ok(pii, "PII_FIELDS.AssistantMessage");
    assert.deepEqual([...pii[1].matchAll(/"(\w+)"/g)].map((m) => m[1]), ["content"]);
    // Corrector L6b (REV-02): el título (primera pregunta) puede llevar un nombre sin tratamiento que el redactor no
    // reconoce, así que va cifrado como el contenido; screen_context_json solo admite ids seguros (normalizeScreenContext).
    const piiTitle = /PII_FIELDS[\s\S]*?\n  AssistantConversation: \[([\s\S]*?)\]/.exec(crypto);
    assert.ok(piiTitle, "PII_FIELDS.AssistantConversation");
    assert.deepEqual([...piiTitle[1].matchAll(/"(\w+)"/g)].map((m) => m[1]), ["title"]);
    // Las entradas están dentro del literal PII_FIELDS (antes de LOOKUP_HASH_FIELDS) y no en el mapa de hashes.
    const lookupStart = crypto.indexOf("export const LOOKUP_HASH_FIELDS = {");
    assert.ok(crypto.indexOf("  AssistantMessage: [") < lookupStart);
    assert.ok(crypto.indexOf("  AssistantConversation: [") < lookupStart);
    assert.doesNotMatch(crypto.slice(lookupStart), /AssistantMessage|AssistantConversation/, "nunca se busca por igualdad de contenido ni de título: sin lookup hash");
    assert.match(modelBlock("AssistantConversation"), /^  title\s+String$/m, "title es String obligatorio (ciphertext v1.<iv>.<data>.<tag>)");
    assert.match(modelBlock("AssistantMessage"), /^  content\s+String$/m, "content es String obligatorio (ciphertext v1.<iv>.<data>.<tag>)");
    assert.match(tableBody("assistant_messages"), /^    "content" TEXT NOT NULL,$/m);
    assert.doesNotMatch(ddl, /lookup_hash/);
  });

  it("los vocabularios `///` son exactamente los de la tanda; el DEFAULT de status es un valor del vocabulario; routedBy admite null en mensajes del usuario", () => {
    for (const [name, model, field] of VOCABULARY_FIELDS) {
      assert.deepEqual(docValues(model, field), VOCABULARIES[name], `${name} ↔ ${model}.${field}`);
    }
    const statusDefault = /"status" TEXT NOT NULL DEFAULT '(\w+)'/.exec(tableBody("assistant_conversations"))?.[1];
    assert.ok(VOCABULARIES.ASSISTANT_CONVERSATION_STATUSES.includes(statusDefault), `DEFAULT '${statusDefault}'`);
    assert.match(modelBlock("AssistantConversation"), /^  status\s+String\s+@default\("open"\)$/m);
    assert.match(modelBlock("AssistantConversation"), /^  surface\s+String$/m, "surface sin default: cada superficie lo declara");
    assert.match(modelBlock("AssistantMessage"), /^  role\s+String$/m);
    assert.match(modelBlock("AssistantMessage"), /^  routedBy\s+String\?\s+@map\("routed_by"\)$/m);
  });

  it("la comprobación migraciones↔schema sin BD ve las dos tablas de esta migración y sigue en verde", async () => {
    const { check, replayMigrations } = await import("../scripts/check-migrations-vs-schema.mjs");
    const replayed = replayMigrations([[migrationFolder, migration]]);
    assert.deepEqual([...replayed.tables].sort(), Object.values(TABLES).sort());
    assert.equal(replayed.enums.size, 0);
    const result = check();
    assert.equal(result.ok, true, JSON.stringify({ tables: result.tables, enums: result.enums }));
  });
});
