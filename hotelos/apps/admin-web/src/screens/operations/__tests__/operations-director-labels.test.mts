import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEPARTMENT_LABEL,
  HK_TASK_STATUS_LABEL,
  HK_TASK_TYPE_LABEL,
  PRIORITY_LABEL,
  WO_STATUS_LABEL,
  departmentLabel,
  hkTaskStatusLabel,
  hkTaskTypeLabel,
  labelOf,
  priorityLabel,
  roomLabel,
  shiftStatusLabel,
  woStatusLabel
} from "../operations-director-labels.ts";

// FIX-1 · F9: /hoy/operaciones painted roomId, «departure_clean», «IN_PROGRESS»
// and «FRONT_DESK» (manual 10 § 2 and 40 § Mi día, «En construcción»).
const stripComments = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
const screen = stripComments(readFileSync(new URL("../OperationsDirectorScreen.tsx", import.meta.url), "utf8"));

describe("Mi día › Operaciones · etiquetas en español", () => {
  it("translates the housekeeping task types the brief lists", () => {
    assert.deepEqual(HK_TASK_TYPE_LABEL, {
      departure_clean: "Limpieza de salida",
      stayover: "Repaso",
      inspection: "Inspección",
      turndown: "Cobertura",
      deep_clean: "Limpieza a fondo"
    });
    assert.equal(hkTaskTypeLabel("departure_clean"), "Limpieza de salida");
  });

  it("translates task, work-order and shift statuses and priorities", () => {
    assert.equal(HK_TASK_STATUS_LABEL.pending, "Pendiente");
    assert.equal(HK_TASK_STATUS_LABEL.assigned, "Asignada");
    assert.equal(HK_TASK_STATUS_LABEL.in_progress, "En curso");
    assert.equal(HK_TASK_STATUS_LABEL.done, "Hecha");
    assert.equal(hkTaskStatusLabel("IN_PROGRESS"), "En curso", "case-insensitive: the API enum is lowercase, the badge uppercases");
    for (const status of ["open", "assigned", "in_progress", "waiting_vendor", "resolved", "closed"]) {
      assert.ok(WO_STATUS_LABEL[status], `WO_STATUS_LABEL.${status}`);
      assert.notEqual(woStatusLabel(status), status);
    }
    assert.equal(woStatusLabel("waiting_vendor"), "Esperando proveedor");
    for (const p of ["low", "normal", "high", "urgent", "preventive"]) assert.notEqual(priorityLabel(p), p, `PRIORITY_LABEL.${p}`);
    assert.equal(PRIORITY_LABEL.high, "Alta");
    assert.equal(PRIORITY_LABEL.preventive, "Preventiva", "demo work order «Revisión preventiva de la caldera» carries priority preventive");
    assert.equal(shiftStatusLabel("scheduled"), "Programado");
  });

  it("names the departments of the alerts (API ids of OpsDirectorDepartment)", () => {
    assert.equal(DEPARTMENT_LABEL.front_desk, "Recepción");
    assert.equal(DEPARTMENT_LABEL.housekeeping, "Pisos");
    assert.equal(DEPARTMENT_LABEL.maintenance, "Mantenimiento");
    assert.equal(DEPARTMENT_LABEL.fnb, "F&B");
    for (const id of ["front_desk", "housekeeping", "maintenance", "workforce", "safety", "fb_pos"]) {
      assert.notEqual(departmentLabel(id), id, `departmentLabel(${id})`);
    }
    assert.equal(departmentLabel("FRONT_DESK"), "Recepción");
  });

  it("falls back to the raw code for unknown values and to «—» for missing ones (never «undefined»)", () => {
    assert.equal(hkTaskTypeLabel("valet_service"), "valet_service");
    assert.equal(woStatusLabel("weird"), "weird");
    assert.equal(departmentLabel("logistics"), "logistics");
    assert.equal(priorityLabel(undefined), "—");
    assert.equal(hkTaskStatusLabel(null), "—");
    assert.equal(labelOf({}, "   "), "—");
  });

  it("roomLabel prefers the resolved number and never prints undefined", () => {
    assert.equal(roomLabel({ roomNumber: "204", roomId: "room_abc" }), "204");
    assert.equal(roomLabel({ roomNumber: null, roomId: "room_abc" }), "room_abc");
    assert.equal(roomLabel({ roomId: "room_abc" }), "room_abc");
    assert.equal(roomLabel({ roomNumber: null, roomId: null }), "—");
  });
});

describe("OperationsDirectorScreen.tsx · paints labels and numbers, not ids", () => {
  it("HK and WO tables use roomLabel and the label helpers; shifts say Asignado/Sin asignar; alerts use departmentLabel", () => {
    assert.match(screen, /from "\.\/operations-director-labels";/);
    assert.match(screen, /key: "room", label: "Habitación", render: \(t\) => roomLabel\(t\)/);
    assert.match(screen, /hkTaskTypeLabel\(t\.taskType\)/);
    assert.match(screen, /badge\(statusTone\(t\.status\), hkTaskStatusLabel\(t\.status\)\)/);
    assert.match(screen, /badge\(statusTone\(wo\.status\), woStatusLabel\(wo\.status\)\)/);
    assert.match(screen, /render: \(wo\) => roomLabel\(wo\)/);
    assert.match(screen, /s\.staffProfileId \? badge\("success", "Asignado"\) : badge\("warning", "Sin asignar"\)/);
    assert.match(screen, /\{departmentLabel\(a\.department\)\}/);
    assert.doesNotMatch(screen, /\{a\.department\}/);
    assert.doesNotMatch(screen, /key: "roomId", label: "Habitación" \}/);
    assert.doesNotMatch(screen, /s\.staffProfileId \? s\.staffProfileId/);
  });
});
