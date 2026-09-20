// Unit tests of the rbac:sync CLI flags and human report (Tanda 8a · L3):
// `--upgrade-templates` (the only operation that revokes keys of a role),
// the per-role revocation report (`revocationsByRole` resolved to names) and
// the untouched `--prune` block. No database. Run from apps/api:
//   node --import tsx --test src/scripts/__tests__/rbac-sync.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_TEMPLATE_REVOCATIONS, ROLE_TEMPLATE_VERSION } from "@hotelos/shared";
import { KNOWN_FLAGS, formatHuman, parseFlags, revocationReport, type RbacSyncSummary } from "../rbac-sync.js";

const FARANDA = "cmrhw9jy30002fyvb6tsdiugt";

function summary(overrides: Partial<RbacSyncSummary> = {}): RbacSyncSummary {
  const managerKeys = [...ROLE_TEMPLATE_REVOCATIONS.manager].sort();
  const accountantKeys = [...ROLE_TEMPLATE_REVOCATIONS.accountant].sort();
  return {
    dryRun: true,
    prune: false,
    upgradeTemplates: false,
    templateVersion: ROLE_TEMPLATE_VERSION,
    catalogKeys: 250,
    orgKeys: 249,
    platformKeys: 1,
    templates: { manager: 205, accountant: 57 },
    sync: { created: 27, updated: 0, stale: [] },
    backfill: {
      rolesFilled: 2,
      roles: ["Dirección (cmrhw9jy30002fyvb6tsdiugt) ← manager: +110", "Contabilidad (cmrhw9jy30002fyvb6tsdiugt) ← accountant: +29"],
      templateRoles: 20,
      templateRolesToppedUp: 20,
      templateKeysAssigned: 0,
      templateKeysAssignedRoles: [],
      customRoles: [],
      unmatched: [],
      platformRolesToppedUp: 1,
      platformRoles: ["Local Super Admin (org_123) ← full catalog: +27"],
      upgraded: [],
      revocationsByRole: { role_dir: managerKeys, role_cont: accountantKeys },
      templateRolesBehindVersion: 20
    },
    revocations: [
      { roleId: "role_dir", roleName: "Dirección", organizationId: FARANDA, templateKey: "manager", keys: managerKeys },
      { roleId: "role_cont", roleName: "Contabilidad", organizationId: FARANDA, templateKey: "accountant", keys: accountantKeys }
    ],
    revokedKeysTotal: managerKeys.length + accountantKeys.length,
    durationMs: 12,
    ...overrides
  };
}

describe("rbac:sync · parseFlags", () => {
  it("--upgrade-templates is parsed; without it the flags keep the pre-Tanda-8a shape (no upgradeTemplates key)", () => {
    assert.deepEqual(parseFlags(["--upgrade-templates"]), { prune: false, dryRun: false, json: false, upgradeTemplates: true });
    assert.deepEqual(parseFlags(["--dry-run", "--upgrade-templates", "--json"]), { prune: false, dryRun: true, json: true, upgradeTemplates: true });
    const legacy = parseFlags(["--", "--dry-run", "--prune", "--json"]);
    assert.deepEqual(legacy, { prune: true, dryRun: true, json: true });
    assert.equal("upgradeTemplates" in legacy, false);
  });
  it("rejects unknown flags listing every known one (including --upgrade-templates); --prune stays intact", () => {
    assert.deepEqual([...KNOWN_FLAGS], ["--prune", "--dry-run", "--json", "--upgrade-templates"]);
    assert.throws(() => parseFlags(["--upgrade"]), /Unknown flag "--upgrade"\. Known: --prune, --dry-run, --json, --upgrade-templates\./);
    assert.throws(() => parseFlags(["--apply"]), /Unknown flag "--apply"/);
    assert.equal(parseFlags(["--prune"]).prune, true);
  });
});

describe("rbac:sync · revocationReport", () => {
  it("resolves role ids to «name (org) ← template», sorts keys and rows (organisation, name), and keeps unknown ids readable", () => {
    const report = revocationReport(
      { r2: ["b.key", "a.key"], r1: ["z.key"], r_missing: ["x.key"] },
      [
        { id: "r1", name: "Contabilidad", organizationId: "org_b", templateKey: "accountant" },
        { id: "r2", name: "Dirección", organizationId: "org_a", templateKey: "manager" }
      ]
    );
    assert.deepEqual(report, [
      { roleId: "r_missing", roleName: "r_missing", organizationId: "?", templateKey: null, keys: ["x.key"] },
      { roleId: "r2", roleName: "Dirección", organizationId: "org_a", templateKey: "manager", keys: ["a.key", "b.key"] },
      { roleId: "r1", roleName: "Contabilidad", organizationId: "org_b", templateKey: "accountant", keys: ["z.key"] }
    ]);
    assert.deepEqual(revocationReport(undefined, []), []);
  });
});

describe("rbac:sync · formatHuman", () => {
  it("without --upgrade-templates: lists per role the keys an upgrade WOULD revoke, the total, and the «kept» hint (the boot never revokes)", () => {
    const text = formatHuman(summary());
    assert.match(text, /^\[rbac:sync\] DRY-RUN \(no writes\) · 12 ms/);
    assert.doesNotMatch(text, /upgrade-templates ·/);
    assert.match(text, /permissions: \+27 created · 0 descriptions updated · 0 stale/);
    assert.match(text, new RegExp(`template version: ${ROLE_TEMPLATE_VERSION} · 20 role\\(s\\) behind · 2 role\\(s\\) hold key\\(s\\) the version revokes \\(${ROLE_TEMPLATE_REVOCATIONS.manager.length + ROLE_TEMPLATE_REVOCATIONS.accountant.length} key\\(s\\) in total\\)`));
    assert.match(text, new RegExp(`would revoke: Dirección \\(${FARANDA}\\) ← manager: −${ROLE_TEMPLATE_REVOCATIONS.manager.length} · accounting\\.configure, accounting\\.entity\\.read`));
    assert.match(text, new RegExp(`would revoke: Contabilidad \\(${FARANDA}\\) ← accountant: −${ROLE_TEMPLATE_REVOCATIONS.accountant.length} · `));
    assert.match(text, /kept — the boot top-up never revokes; run `rbac:sync -- --dry-run --upgrade-templates`/);
    assert.match(text, /templates: manager=205 accountant=57/);
  });

  it("with --upgrade-templates in dry-run: header flag, «would upgrade» lines, nothing written, no «kept» hint", () => {
    const text = formatHuman(
      summary({
        upgradeTemplates: true,
        backfill: { ...summary().backfill, upgraded: ["Dirección (cmrhw9jy30002fyvb6tsdiugt) ← manager v0→v2: +110 −16 [dry-run]"] }
      })
    );
    assert.match(text, /^\[rbac:sync\] DRY-RUN \(no writes\) \+ upgrade-templates · 12 ms/);
    assert.match(text, /template version: 4 · 20 role\(s\) behind \[dry-run: nothing written\] · 2 role\(s\) hold key\(s\) the version revokes/);
    assert.match(text, /would upgrade: Dirección \(cmrhw9jy30002fyvb6tsdiugt\) ← manager v0→v2: \+110 −16 \[dry-run\]/);
    assert.match(text, /would revoke: Dirección/);
    assert.doesNotMatch(text, /kept — the boot top-up never revokes/);
  });

  it("applied upgrade: «revoked» per role, «upgraded» lines and the post-state counter", () => {
    const text = formatHuman(
      summary({
        dryRun: false,
        upgradeTemplates: true,
        backfill: { ...summary().backfill, templateRolesBehindVersion: 0, upgraded: ["Dirección (cmrhw9jy30002fyvb6tsdiugt) ← manager v0→v2: +110 −16"] }
      })
    );
    assert.match(text, /^\[rbac:sync\] APPLIED \+ upgrade-templates/);
    assert.match(text, /template version: 4 · 0 role\(s\) behind after the upgrade · 2 role\(s\) lost key\(s\) the version revoked/);
    assert.match(text, /    revoked: Dirección \(cmrhw9jy30002fyvb6tsdiugt\) ← manager: −16 · /);
    assert.match(text, /upgraded: Dirección \(cmrhw9jy30002fyvb6tsdiugt\) ← manager v0→v2: \+110 −16$/m);
  });

  it("a converged catalogue reports 0 behind and no revocation lines; the --prune block is unchanged", () => {
    const converged = formatHuman(summary({ revocations: [], revokedKeysTotal: 0, backfill: { ...summary().backfill, revocationsByRole: {}, templateRolesBehindVersion: 0 } }));
    assert.match(converged, /template version: 4 · 0 role\(s\) behind · 0 role\(s\) hold key\(s\) the version revokes \(0 key\(s\) in total\)/);
    assert.doesNotMatch(converged, /would revoke/);
    assert.doesNotMatch(converged, /kept —/);
    const pruned = formatHuman(summary({ prune: true, sync: { created: 0, updated: 0, stale: ["capex.approve"], staleGrants: 1, staleGrantRoles: 1, pruned: 1, prunedGrants: 1 } }));
    assert.match(pruned, /DRY-RUN \(no writes\) \+ prune · 12 ms/);
    assert.match(pruned, /stale keys \(1\): capex\.approve/);
    assert.match(pruned, /--prune WOULD delete 1 key\(s\) and 1 role_permissions row\(s\) on 1 role\(s\)/);
  });

  it("tolerates a summary that predates Tanda 8a (no revocation fields): resolves the report from backfill.revocationsByRole", () => {
    const legacy = summary();
    delete legacy.revocations;
    delete legacy.revokedKeysTotal;
    delete legacy.templateVersion;
    delete legacy.upgradeTemplates;
    const text = formatHuman(legacy);
    assert.match(text, /would revoke: role_dir \(\?\) ← sin plantilla: −16 · /);
    assert.match(text, /template version: 4 · 20 role\(s\) behind · 2 role\(s\) hold key\(s\)/);
  });
});
