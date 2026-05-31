# LINT-RULE-PROPOSAL.md

**Audit Phase**: SINTESIS 3 (Preventivo)
**Objetivo**: Prevenir la recurrencia de divergencias entre `/screens/`, `Sidebar.tsx` y `App.tsx` route registry mediante hooks pre-commit y reglas de documentacion.

---

## Motivacion

La auditoria identifico tres clases de drift estructural:

1. **Screens huerfanas**: archivos en `/screens/` sin entrada en `Sidebar` ni en `App.tsx`.
2. **Rutas rotas**: items de `Sidebar` apuntando a IDs que no existen en el route registry.
3. **Placeholders sin presupuesto**: componentes "Coming Soon" que se acumulan sin promocion ni eliminacion.

Las reglas siguientes mecanizan la deteccion de estos drifts en pre-commit.

---

## Pre-commit hook 1: `sidebar-coverage`

**Proposito**: Detectar screens existentes en disco que no estan registradas en `Sidebar` y no son whitelisted como internas.

### Esqueleto TypeScript

```ts
// scripts/lint/sidebar-coverage.ts
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { Project, SyntaxKind } from "ts-morph";

const SCREENS_DIR = "apps/hotel-os/src/screens";
const SIDEBAR_FILE = "apps/hotel-os/src/components/Sidebar.tsx";
const APP_FILE = "apps/hotel-os/src/App.tsx";

const KNOWN_INTERNAL_SCREENS = new Set<string>([
  // Pantallas accesibles via deep-link o flujos contextuales,
  // que NO deben aparecer en el Sidebar global.
  "GuestProfileDetail",
  "ReservationDetail",
  "InvoiceDetail",
  "ChannelDebugConsole",
]);

function extractScreenNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".tsx"))
    .map((d) => basename(d.name, ".tsx"));
}

function extractSidebarItems(file: string): Set<string> {
  const project = new Project();
  const src = project.addSourceFileAtPath(file);
  const ids = new Set<string>();

  src.getDescendantsOfKind(SyntaxKind.PropertyAssignment).forEach((p) => {
    if (p.getName() === "screen" || p.getName() === "target") {
      const v = p.getInitializer()?.getText().replace(/['"`]/g, "");
      if (v) ids.add(v);
    }
  });
  return ids;
}

function extractRouteRegistry(file: string): Set<string> {
  const src = readFileSync(file, "utf-8");
  // Asume registry { id: "ScreenName", component: ScreenName }
  return new Set(
    [...src.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  );
}

function main(): void {
  const screens = extractScreenNames(SCREENS_DIR);
  const sidebar = extractSidebarItems(SIDEBAR_FILE);
  const routes = extractRouteRegistry(APP_FILE);

  const orphans = screens.filter(
    (s) => !sidebar.has(s) && !routes.has(s) && !KNOWN_INTERNAL_SCREENS.has(s)
  );

  if (orphans.length > 0) {
    console.error("Screens huerfanas detectadas (no en Sidebar ni route registry):");
    orphans.forEach((o) => console.error(`  - ${o}.tsx`));
    console.error(
      "\nAccion: anadir a Sidebar.tsx, registrar en App.tsx, o whitelist en KNOWN_INTERNAL_SCREENS."
    );
    process.exit(1);
  }
  console.log(`OK: ${screens.length} screens, todas registradas o whitelisted.`);
}

main();
```

### Husky / lint-staged integracion

```json
// package.json
{
  "lint-staged": {
    "apps/hotel-os/src/screens/**/*.tsx": [
      "pnpm tsx scripts/lint/sidebar-coverage.ts"
    ]
  }
}
```

---

## Pre-commit hook 2: `route-validity`

**Proposito**: Validar que cada item de `Sidebar` con `screen` target tiene un ID correspondiente en el route registry de `App.tsx`.

### Esqueleto TypeScript

```ts
// scripts/lint/route-validity.ts
import { Project, SyntaxKind } from "ts-morph";
import { readFileSync } from "node:fs";

const SIDEBAR_FILE = "apps/hotel-os/src/components/Sidebar.tsx";
const APP_FILE = "apps/hotel-os/src/App.tsx";

interface SidebarItem {
  label: string;
  screen: string;
}

function extractSidebarTargets(file: string): SidebarItem[] {
  const project = new Project();
  const src = project.addSourceFileAtPath(file);
  const items: SidebarItem[] = [];

  src.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression).forEach((obj) => {
    const screenProp = obj.getProperty("screen");
    const labelProp = obj.getProperty("label");
    if (
      screenProp?.isKind(SyntaxKind.PropertyAssignment) &&
      labelProp?.isKind(SyntaxKind.PropertyAssignment)
    ) {
      const screen = screenProp.getInitializer()?.getText().replace(/['"`]/g, "");
      const label = labelProp.getInitializer()?.getText().replace(/['"`]/g, "");
      if (screen && label) items.push({ screen, label });
    }
  });
  return items;
}

function extractRouteIds(file: string): Set<string> {
  const src = readFileSync(file, "utf-8");
  return new Set(
    [...src.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  );
}

function main(): void {
  const items = extractSidebarTargets(SIDEBAR_FILE);
  const routes = extractRouteIds(APP_FILE);

  const broken = items.filter((i) => !routes.has(i.screen));
  if (broken.length > 0) {
    console.error("Sidebar items con targets rotos (no en App.tsx route registry):");
    broken.forEach((b) =>
      console.error(`  - "${b.label}" -> screen="${b.screen}"`)
    );
    console.error("\nAccion: anadir route en App.tsx o corregir el screen target.");
    process.exit(1);
  }
  console.log(`OK: ${items.length} sidebar items, todos con route valida.`);
}

main();
```

### Husky integracion

```json
{
  "lint-staged": {
    "apps/hotel-os/src/components/Sidebar.tsx": [
      "pnpm tsx scripts/lint/route-validity.ts"
    ],
    "apps/hotel-os/src/App.tsx": [
      "pnpm tsx scripts/lint/route-validity.ts"
    ]
  }
}
```

---

## Pre-commit hook 3: `placeholder-budget`

**Proposito**: Limitar el numero de placeholders ("Coming Soon", `<PlaceholderScreen>`, etc.) a un maximo de 10. Forzar promocion (implementacion real) o eliminacion.

### Esqueleto TypeScript

```ts
// scripts/lint/placeholder-budget.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SCREENS_DIR = "apps/hotel-os/src/screens";
const MAX_PLACEHOLDERS = 10;

const PLACEHOLDER_MARKERS = [
  /<PlaceholderScreen/,
  /\/\/\s*TODO:\s*implement/i,
  /Coming\s+Soon/i,
  /isPlaceholder\s*[:=]\s*true/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function isPlaceholder(file: string): boolean {
  const src = readFileSync(file, "utf-8");
  return PLACEHOLDER_MARKERS.some((re) => re.test(src));
}

function main(): void {
  const files = walk(SCREENS_DIR);
  const placeholders = files.filter(isPlaceholder);

  console.log(`Placeholders detectados: ${placeholders.length} / ${MAX_PLACEHOLDERS}`);
  placeholders.forEach((p) => console.log(`  - ${p}`));

  if (placeholders.length > MAX_PLACEHOLDERS) {
    console.error(
      `\nExceso de placeholders: ${placeholders.length} > ${MAX_PLACEHOLDERS}.`
    );
    console.error("Accion: promocionar (implementar) o eliminar antes de mergear.");
    process.exit(1);
  }
}

main();
```

### CI integracion

Tambien correr en CI (no solo pre-commit) para evitar bypass con `--no-verify`:

```yaml
# .github/workflows/lint.yml
- name: Placeholder budget
  run: pnpm tsx scripts/lint/placeholder-budget.ts
```

---

## Storybook story rule

**Regla**: Cualquier dialog significativo (>200 LOC) requiere una story Storybook que valide su accesibilidad mediante `@storybook/addon-a11y`.

### Esqueleto del checker

```ts
// scripts/lint/dialog-story-coverage.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const DIALOGS_DIR = "apps/hotel-os/src/components/dialogs";
const STORIES_DIR = "apps/hotel-os/src/stories";
const LOC_THRESHOLD = 200;

function countLOC(file: string): number {
  return readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).length;
}

function findStoryForComponent(name: string): boolean {
  return readdirSync(STORIES_DIR).some((f) =>
    f.toLowerCase().includes(name.toLowerCase()) && f.endsWith(".stories.tsx")
  );
}

function main(): void {
  const dialogs = readdirSync(DIALOGS_DIR).filter((f) => f.endsWith(".tsx"));
  const missing: string[] = [];

  for (const file of dialogs) {
    const path = join(DIALOGS_DIR, file);
    const loc = countLOC(path);
    if (loc < LOC_THRESHOLD) continue;
    const name = basename(file, ".tsx");
    if (!findStoryForComponent(name)) {
      missing.push(`${name} (${loc} LOC)`);
    }
  }

  if (missing.length > 0) {
    console.error("Dialogs significativos (>200 LOC) sin story de accesibilidad:");
    missing.forEach((m) => console.error(`  - ${m}`));
    process.exit(1);
  }
}

main();
```

La story debe incluir `parameters: { a11y: { test: 'error' } }` para fallar el build si hay violaciones WCAG AA.

---

## Documentation requirements

### Regla

Cualquier nueva feature en `/screens/` requiere update simultaneo de:

1. **`Sidebar.tsx`** con su nuevo entry (o whitelist en `KNOWN_INTERNAL_SCREENS`).
2. **`docs/audits/AUDITED-SCREENS.md`** (manifest) con su razon de existencia.

### Esqueleto del checker

```ts
// scripts/lint/audit-manifest-coverage.ts
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const SCREENS_DIR = "apps/hotel-os/src/screens";
const MANIFEST = "docs/audits/AUDITED-SCREENS.md";

function getStagedNewScreens(): string[] {
  const out = execSync("git diff --cached --name-only --diff-filter=A").toString();
  return out
    .split("\n")
    .filter((l) => l.startsWith(SCREENS_DIR) && l.endsWith(".tsx"))
    .map((l) => l.split("/").pop()!.replace(".tsx", ""));
}

function manifestMentions(name: string): boolean {
  return readFileSync(MANIFEST, "utf-8").includes(name);
}

function main(): void {
  const newScreens = getStagedNewScreens();
  const missing = newScreens.filter((s) => !manifestMentions(s));

  if (missing.length > 0) {
    console.error(
      "Nuevas screens sin entrada en AUDITED-SCREENS.md (manifest):"
    );
    missing.forEach((s) => console.error(`  - ${s}`));
    console.error(
      "\nAccion: documentar la razon de existencia en docs/audits/AUDITED-SCREENS.md."
    );
    process.exit(1);
  }
}

main();
```

### Plantilla de entrada en `AUDITED-SCREENS.md`

```markdown
### NombreScreen.tsx
- **Razon**: <por que existe>
- **Acceso**: Sidebar | deep-link | flujo contextual
- **Owner**: @usuario
- **Estado**: stub | parcial | completo
- **Ultima auditoria**: YYYY-MM-DD
```

---

## Configuracion Husky consolidada

```sh
# .husky/pre-commit
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

pnpm tsx scripts/lint/sidebar-coverage.ts
pnpm tsx scripts/lint/route-validity.ts
pnpm tsx scripts/lint/placeholder-budget.ts
pnpm tsx scripts/lint/dialog-story-coverage.ts
pnpm tsx scripts/lint/audit-manifest-coverage.ts
```

Cada script termina con `process.exit(1)` ante violacion. Husky bloquea el commit.

---

## Plan de adopcion (fases)

1. **Semana 1**: Implementar scripts en modo `warning` (no bloqueante) para baseline.
2. **Semana 2**: Resolver violaciones existentes; promover scripts a `error` bloqueante en pre-commit.
3. **Semana 3**: Replicar en CI (`.github/workflows/lint.yml`) para cerrar bypass.
4. **Semana 4**: Anadir metricas (count de placeholders, dialogs sin story) a dashboard interno.

---

## Resumen

| Regla | Detecta | Bloqueante | Whitelist |
|---|---|---|---|
| sidebar-coverage | screens huerfanas | si | KNOWN_INTERNAL_SCREENS |
| route-validity | targets rotos | si | n/a |
| placeholder-budget | exceso de stubs | si (>10) | n/a |
| dialog-story-coverage | dialogs >200 LOC sin a11y story | si | n/a |
| audit-manifest-coverage | screens nuevas sin doc | si | n/a |

Combinadas, estas reglas convierten el drift estructural detectado en SINTESIS 1 y 2 en una clase de error capturado en commit-time, no en revision manual trimestral.
