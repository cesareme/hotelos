import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Helpers de e2e del portal del huésped (Tanda L7 · lote L7-03 · proyecto
 * Playwright `guest`, apps/admin-web/playwright.config.ts).
 *
 * Mismo patrón que e2e/_helpers.ts (tenant UXDAY) pero sobre el tenant aislado
 * `CHK` de packages/database/prisma/seed-checkin.ts (`org_chk` / `prop_chk`,
 * usuarios `recepcion@chk.test` y `direccion@chk.test`, contraseña `chk-demo`,
 * política con selfCheckInEnabled y mrz_checksum admitido):
 *   · `loginAsChk(request, rol)`: POST /auth/login REAL contra E2E_API_URL, sesión
 *     memorizada por correo en el worker (límite 10/min por IP);
 *   · `createSyntheticReservation(request, …)`: reserva nueva por API con un
 *     titular INVENTADO («Prueba Portal»): nunca datos de Faranda ni nombres reales;
 *   · `invite(request, reservationId)`: POST /properties/prop_chk/check-in/sessions
 *     → token del enlace mágico en claro (fuera de producción el API lo devuelve al
 *     personal cuando el envío es simulado, checkin-session.service.ts inviteReservation);
 *   · `guestUrl(token)`: enlace `GUEST_WEB/checkin?token=…&property=prop_chk`;
 *   · `syntheticMrz(...)`: MRZ TD3 sintética con dígitos de control válidos
 *     (misma fórmula 7-3-1 que packages/compliance/src/spain/mrz.ts) para el
 *     paso «Documento» sin proveedor de visión;
 *   · `assertTargets(page, testInfo, name)`: contrato de tamaño de objetivos
 *     (UX-RECEPCION-FEEL.md §7.1 · WCAG 2.2 2.5.8): 0 objetivos interactivos
 *     < 24 × 24 px CSS (salvo enlaces en línea); los < 44 px (2.5.5 / Apple HIG)
 *     se escriben en JSON en `TARGET_SIZE_OUT` o en el outputDir de la prueba,
 *     descritos por tipo (sin textos de tarjetas: nunca nombres);
 *   · `shot(page, name)`: captura a `E2E_SHOTS_DIR` (por defecto
 *     apps/admin-web/test-results/guest-portal-shots, ignorado por git);
 *   · `watchConsole(page)` + `assertConsoleClean(...)`: 0 excepciones de página y
 *     0 errores de consola salvo el «Failed to load resource» de las respuestas
 *     4xx que la spec declara esperadas (400 DOCUMENT_UNREADABLE, 409 de llegada);
 *     además el token del portal nunca viaja en la URL de ninguna petición.
 */

// Corrector L7-REV-08: por defecto el API del carril documentado (:3937, runbook §8 y README), NUNCA el :3000
// de la BD principal (el proyecto `guest` crea reservas RES-* en prop_chk).
export const E2E_API_URL = (process.env.E2E_API_URL ?? "http://127.0.0.1:3937").replace(/\/+$/, "");
export const E2E_GUEST_BASE_URL = (process.env.E2E_GUEST_BASE_URL ?? "http://127.0.0.1:5237").replace(/\/+$/, "");

export const CHK = {
  organizationId: "org_chk",
  propertyId: "prop_chk",
  propertyName: "Hotel CHK (prueba)",
  /** Doble del seed (rt_chk_dbl, 101-109 y 201-209). */
  roomTypeId: "rt_chk_dbl",
  password: process.env.E2E_CHK_PASSWORD ?? "chk-demo",
  users: {
    recepcion: "recepcion@chk.test",
    direccion: "direccion@chk.test"
  }
} as const;

export type ChkRole = keyof typeof CHK.users;

export type ChkSession = {
  token: string;
  /** Payload `user` de POST /auth/login + `email`. */
  user: Record<string, unknown> & { email: string };
  /** Cabeceras listas para las rutas de personal de prop_chk. */
  headers: Record<string, string>;
};

const sessionCache = new Map<string, ChkSession>();

/** Autentica a un usuario del tenant CHK (sesión memorizada por correo dentro del worker). */
export async function loginAsChk(request: APIRequestContext, role: ChkRole = "recepcion"): Promise<ChkSession> {
  const email = CHK.users[role];
  const cached = sessionCache.get(email);
  if (cached) return cached;
  const response = await request.post(`${E2E_API_URL}/auth/login`, {
    data: { email, password: CHK.password, deviceId: "e2e-guest" }
  });
  if (!response.ok()) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `[e2e:guest] POST ${E2E_API_URL}/auth/login como ${email} → ${response.status()} ${body.slice(0, 200)}. ` +
        "¿Está el API de pruebas arrancado y el seed CHK ejecutado (corepack pnpm --filter @hotelos/database db:seed:checkin -- --reset)?"
    );
  }
  const payload = (await response.json()) as { token: string; user: Record<string, unknown> };
  const session: ChkSession = {
    token: payload.token,
    user: { ...payload.user, email },
    headers: { Authorization: `Bearer ${payload.token}`, "x-property-id": CHK.propertyId }
  };
  sessionCache.set(email, session);
  return session;
}

/** Titular INVENTADO de las reservas de prueba (nunca una persona real). */
export const SYNTHETIC_GUEST = { firstName: "Prueba", surname1: "Portal" } as const;

/** Día local del hotel (Europe/Madrid) desplazado `offsetDays`, en ISO YYYY-MM-DD. */
/**
 * Corrector L7-REV-10: deja el tenant como estaba tras una spec —si la reserva
 * sigue alojada recepción hace el check-out reconociendo el saldo y, en todo
 * caso, dirección (housekeeping.task.manage) vuelve a marcar limpia la habitación
 * usada (el check-out la deja sucia y agotaba las Dobles listas de prop_chk).
 * Nunca lanza: se usa en `finally`.
 */
export async function releaseReservationRoom(request: APIRequestContext, reservationId: string, roomId?: string | null): Promise<void> {
  try {
    const session = await loginAsChk(request, "recepcion");
    const current = await request.get(`${E2E_API_URL}/reservations/${reservationId}`, { headers: session.headers });
    const row = current.ok() ? ((await current.json()) as { status?: string; assignedRoomId?: string | null }) : {};
    if (row.status === "checked_in") {
      await request.post(`${E2E_API_URL}/reservations/${reservationId}/check-out`, { headers: session.headers, data: { acknowledgeBalance: true } });
    }
    const target = roomId ?? row.assignedRoomId ?? null;
    if (!target) return;
    const direccion = await loginAsChk(request, "direccion");
    const cleaned = await request.post(`${E2E_API_URL}/rooms/${target}/mark-clean`, { headers: direccion.headers, data: {} });
    if (!cleaned.ok()) console.warn(`[e2e:guest] POST /rooms/${target}/mark-clean → ${cleaned.status()} (la habitación queda sucia)`);
  } catch (error) {
    console.warn(`[e2e:guest] releaseReservationRoom(${reservationId}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function isoDay(offsetDays: number, timeZone = "Europe/Madrid"): string {
  const local = new Date(new Date().toLocaleString("en-US", { timeZone }));
  local.setDate(local.getDate() + offsetDays);
  return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
}

export type SyntheticReservation = {
  id: string;
  code: string;
  arrival: string;
  departure: string;
  email: string;
  mobilePhone: string;
};

/**
 * Reserva confirmada en prop_chk creada por API (POST /properties/:id/reservations,
 * misma forma que provisionDeparture de e2e/_helpers.ts): titular con nombre,
 * correo y móvil inventados y SIN documento, para que el asistente pase de
 * verdad por el paso «Documento» (foto → 400 → MRZ). Con `adults` > 1 la
 * sesión nace con acompañantes sin declarar y el asistente empieza en
 * «Viajeros» (precheckin.spec usa 1 mientras «Quitar» del portal esté roto).
 */
export async function createSyntheticReservation(
  request: APIRequestContext,
  options: { arrival: string; departure: string; email?: string; mobilePhone?: string; adults?: number; session?: ChkSession }
): Promise<SyntheticReservation> {
  const session = options.session ?? (await loginAsChk(request, "recepcion"));
  const stamp = Date.now().toString(36);
  const email = options.email ?? `prueba.portal.${stamp}@chk.test`;
  const mobilePhone = options.mobilePhone ?? "+34600000900";
  const created = await request.post(`${E2E_API_URL}/properties/${CHK.propertyId}/reservations`, {
    headers: session.headers,
    data: {
      arrivalDate: options.arrival,
      departureDate: options.departure,
      adults: options.adults ?? 1,
      roomTypeId: CHK.roomTypeId,
      channel: "direct",
      currency: "EUR",
      bookerName: `${SYNTHETIC_GUEST.firstName} ${SYNTHETIC_GUEST.surname1}`,
      bookerEmail: email,
      primaryGuest: { firstName: SYNTHETIC_GUEST.firstName, surname1: SYNTHETIC_GUEST.surname1, email, mobilePhone }
    }
  });
  expect(created.ok(), `POST reservations → ${created.status()} ${(await created.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
  const reservation = (await created.json()) as { id: string; code: string };
  return { id: reservation.id, code: reservation.code, arrival: options.arrival, departure: options.departure, email, mobilePhone };
}

export type Invitation = {
  token: string;
  checkInUrl: string;
  sessionId: string | null;
  sessionStatus: string | null;
  notification: { dispatched: boolean; simulated: boolean; channel: string | null; reason: string | null };
};

/**
 * Invita la reserva al pre-check-in como recepción. Fuera de producción (o con
 * envío simulado) el API devuelve el token del enlace en claro; sin él la spec
 * FALLA con el motivo: el portal solo se abre por enlace mágico.
 */
export async function invite(request: APIRequestContext, reservationId: string, options: { channel?: "email" | "whatsapp" | "sms"; session?: ChkSession } = {}): Promise<Invitation> {
  const session = options.session ?? (await loginAsChk(request, "recepcion"));
  const response = await request.post(`${E2E_API_URL}/properties/${CHK.propertyId}/check-in/sessions`, {
    headers: session.headers,
    data: { reservationId, channel: options.channel ?? "email" }
  });
  expect(response.ok(), `POST check-in/sessions → ${response.status()} ${(await response.text().catch(() => "")).slice(0, 200)}`).toBeTruthy();
  const payload = (await response.json()) as {
    token?: string;
    checkInUrl?: string;
    session?: { id?: string; status?: string };
    notification?: Invitation["notification"];
  };
  expect(payload.token, "la invitación no devolvió el token en claro (NODE_ENV=production sin GUEST_PORTAL_RETURN_TOKEN o envío real): la spec no puede abrir el portal").toBeTruthy();
  return {
    token: payload.token as string,
    checkInUrl: payload.checkInUrl ?? guestUrl(payload.token as string),
    sessionId: payload.session?.id ?? null,
    sessionStatus: payload.session?.status ?? null,
    notification: payload.notification ?? { dispatched: false, simulated: false, channel: null, reason: null }
  };
}

/** Enlace del portal: `/checkin?token=…&property=prop_chk` (+ `extra`), como inviteReservation. */
export function guestUrl(token: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ token, property: CHK.propertyId, ...extra });
  return `${E2E_GUEST_BASE_URL}/checkin?${params.toString()}`;
}

// ── MRZ sintética (TD3) ───────────────────────────────────────────────────────

const MRZ_WEIGHTS = [7, 3, 1] as const;

function mrzCharValue(char: string): number {
  if (char === "<") return 0;
  if (char >= "0" && char <= "9") return char.charCodeAt(0) - 48;
  if (char >= "A" && char <= "Z") return char.charCodeAt(0) - 55;
  return 0;
}

/** Dígito de control ICAO 9303 (pesos 7-3-1, módulo 10; `<` = 0, A-Z = 10-35). */
export function mrzCheckDigit(value: string): number {
  let sum = 0;
  for (let i = 0; i < value.length; i += 1) sum += mrzCharValue(value.charAt(i)) * MRZ_WEIGHTS[i % 3]!;
  return sum % 10;
}

function mrzFit(value: string, length: number): string {
  const clean = value.toUpperCase().replace(/[^A-Z0-9<]/g, "<");
  return clean.length > length ? clean.slice(0, length) : clean.padEnd(length, "<");
}

function yymmdd(iso: string): string {
  return iso.replace(/-/g, "").slice(2, 8);
}

export type SyntheticMrzInput = {
  surname: string;
  givenNames: string;
  /** Hasta 9 caracteres A-Z0-9. */
  documentNumber: string;
  /** ISO-3 (ESP…). */
  nationality: string;
  /** YYYY-MM-DD */
  dateOfBirth: string;
  /** H hombre · M mujer · O otro (vocabulario SES) → ICAO M / F / <. */
  sex: "H" | "M" | "O";
  /** YYYY-MM-DD */
  expiryDate: string;
  issuingCountry?: string;
};

/** Pasaporte TD3 (2 × 44) con los cuatro dígitos de control válidos; el parser del API lo acepta como mrz_reader. */
export function syntheticMrz(input: SyntheticMrzInput): string[] {
  const issuer = mrzFit(input.issuingCountry ?? input.nationality, 3);
  const names = mrzFit(`${input.surname}<<${input.givenNames}`, 39);
  const line1 = `P<${issuer}${names}`;
  const number = mrzFit(input.documentNumber, 9);
  const nationality = mrzFit(input.nationality, 3);
  const birth = yymmdd(input.dateOfBirth);
  const expiry = yymmdd(input.expiryDate);
  const sex = input.sex === "H" ? "M" : input.sex === "M" ? "F" : "<";
  const optional = mrzFit("", 14);
  const body = `${number}${mrzCheckDigit(number)}${nationality}${birth}${mrzCheckDigit(birth)}${sex}${expiry}${mrzCheckDigit(expiry)}${optional}${mrzCheckDigit(optional)}`;
  const composite = mrzCheckDigit(body.slice(0, 10) + body.slice(13, 20) + body.slice(21));
  return [line1, `${body}${composite}`];
}

/** PNG de 1 × 1 px: «foto» del documento que sin proveedor de visión el API rechaza con 400 DOCUMENT_UNREADABLE. */
export function tinyPng(): Buffer {
  return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
}

// ── Tamaño de objetivos (§7.1 · 2.5.8) ────────────────────────────────────────

export type TargetSample = { kind: string; label: string; w: number; h: number; min: number; inline: boolean };

export type TargetAudit = {
  coarse: boolean;
  totals: { targets: number; below24: number; below44: number; inlineExempt: number };
  below24: TargetSample[];
  below44: TargetSample[];
};

/** Recorre el DOM visible y mide cada objetivo interactivo (misma regla que e2e/target-size.spec.ts auditPage, sin badges). Se ejecuta en la página. */
function auditTargets(): TargetAudit {
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="link"], [role="slider"], [tabindex="0"]';

  const isVisible = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"], [hidden], .gp-visually-hidden')) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    // Patrón «visually hidden» (clip: rect(0 0 0 0) o 1 × 1 px recortado): solo para lectores de pantalla, no es un objetivo.
    if (/^rect\(0px,? 0px,? 0px,? 0px\)$/.test(style.clip) || (style.overflow === "hidden" && element.clientWidth <= 1 && element.clientHeight <= 1)) return false;
    return element.getClientRects().length > 0;
  };

  const kindOf = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const type = tag === "input" ? `[${(element as HTMLInputElement).type}]` : "";
    const gp = Array.from(element.classList).find((name) => name.startsWith("gp-")) ?? null;
    return `${tag}${type}${role ? `[role=${role}]` : ""}${gp ? ` (.${gp})` : ""}`;
  };

  const labelOf = (element: Element): string => {
    // Dentro de una tarjeta o formulario el texto puede llevar el nombre del viajero: se describe solo por su tipo.
    if (element.closest(".gp-card, form, .gp-chat")) return "(tarjeta)";
    const aria = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? "";
    const text = aria || (element.textContent ?? "").replace(/\s+/g, " ").trim();
    return text.slice(0, 48);
  };

  const rectOf = (element: Element): DOMRect => {
    const input = element as HTMLInputElement;
    if (element.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio")) {
      const label = element.closest("label");
      if (label) return label.getBoundingClientRect();
    }
    return element.getBoundingClientRect();
  };

  const isInlineLink = (element: Element): boolean => {
    if (element.tagName !== "A") return false;
    const parent = element.parentElement;
    if (!parent || !/^(P|SPAN|LI|TD|DD|SMALL|EM|STRONG)$/.test(parent.tagName)) return false;
    return Array.from(parent.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
  };

  const samples: TargetSample[] = [];
  for (const element of Array.from(document.querySelectorAll(INTERACTIVE))) {
    const input = element as HTMLInputElement;
    if (element.tagName === "INPUT" && (input.type === "hidden" || input.type === "file")) continue;
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") continue;
    if (!isVisible(element)) continue;
    const rect = rectOf(element);
    const w = Math.round(rect.width * 100) / 100;
    const h = Math.round(rect.height * 100) / 100;
    if (w === 0 || h === 0) continue;
    samples.push({ kind: kindOf(element), label: labelOf(element), w, h, min: Math.min(w, h), inline: isInlineLink(element) });
  }
  const below24 = samples.filter((sample) => sample.min < 24);
  const below44 = samples.filter((sample) => sample.min < 44);
  return {
    coarse: matchMedia("(pointer: coarse)").matches,
    totals: { targets: samples.length, below24: below24.length, below44: below44.length, inlineExempt: below24.filter((sample) => sample.inline).length },
    below24,
    below44
  };
}

/** Agrupa los objetivos < 44 por tipo con su tamaño mínimo (tabla del informe). */
function summarizeTargets(samples: TargetSample[]): Array<{ kind: string; label: string; count: number; min: number }> {
  const groups = new Map<string, { kind: string; label: string; count: number; min: number }>();
  for (const sample of samples) {
    const key = `${sample.kind} · ${sample.label}`;
    const group = groups.get(key) ?? { kind: sample.kind, label: sample.label, count: 0, min: Number.POSITIVE_INFINITY };
    group.count += 1;
    group.min = Math.min(group.min, sample.min);
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => a.min - b.min || b.count - a.count);
}

/**
 * Afirma 0 objetivos interactivos < 24 × 24 px (2.5.8, salvo enlaces en línea) en
 * la pantalla actual y escribe `targets-<name>.json` con los < 44 px en
 * `TARGET_SIZE_OUT` (o el outputDir de la prueba). Devuelve la auditoría.
 */
export async function assertTargets(page: Page, testInfo: TestInfo, name: string): Promise<TargetAudit> {
  const audit = await page.evaluate(auditTargets);
  const dir = process.env.TARGET_SIZE_OUT ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `targets-${name}.json`), `${JSON.stringify({ name, url: page.url().replace(/token=[^&]+/, "token=[redacted]"), viewport: page.viewportSize(), ...audit, below44Summary: summarizeTargets(audit.below44) }, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(`[guest:targets:${name}] targets=${audit.totals.targets} <24=${audit.totals.below24} (inline ${audit.totals.inlineExempt}) <44=${audit.totals.below44} coarse=${audit.coarse}`);
  const offenders = audit.below24.filter((sample) => !sample.inline);
  expect(offenders, `${name}: objetivos < 24 × 24 px (2.5.8): ${JSON.stringify(offenders)}`).toEqual([]);
  return audit;
}

/** Fija `pointer: coarse` / `hover: none` por CDP (como e2e/target-size.spec.ts forceCoarse): la medida no depende del emulador. */
export async function forceCoarse(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] });
}

// ── Capturas ──────────────────────────────────────────────────────────────────

/** Carpeta de capturas: `E2E_SHOTS_DIR` (p. ej. el scratchpad de la tanda) o test-results/guest-portal-shots (ignorado por git). */
export function shotsDir(): string {
  return process.env.E2E_SHOTS_DIR ?? join(process.cwd(), "test-results", "guest-portal-shots");
}

/** Captura de página completa `<name>.png`; sin datos reales: el tenant CHK solo tiene nombres inventados. */
export async function shot(page: Page, name: string): Promise<string> {
  const dir = shotsDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

// ── Consola y red ─────────────────────────────────────────────────────────────

export type FailedResponse = { method: string; url: string; status: number };

export type ConsoleWatch = {
  errors: Array<{ text: string; url: string | null }>;
  pageErrors: string[];
  failed: FailedResponse[];
  /** Peticiones cuya URL llevaba el token del portal (debe quedar vacío: el token viaja solo en `x-guest-token`). */
  tokenInUrl: string[];
};

/** Registra errores de consola, excepciones de página, respuestas ≥ 400 al API y URLs con el token. */
export function watchConsole(page: Page, token: string): ConsoleWatch {
  const watch: ConsoleWatch = { errors: [], pageErrors: [], failed: [], tokenInUrl: [] };
  page.on("console", (message) => {
    if (message.type() === "error") watch.errors.push({ text: message.text(), url: message.location().url || null });
  });
  page.on("pageerror", (error) => watch.pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(token) && !url.startsWith(E2E_GUEST_BASE_URL)) watch.tokenInUrl.push(`${request.method()} ${url.replace(token, "[token]")}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) watch.failed.push({ method: response.request().method(), url: response.url(), status: response.status() });
  });
  return watch;
}

export type ExpectedFailure = { path: RegExp; status: number };

/**
 * 0 excepciones de página; toda respuesta ≥ 400 debe estar declarada en
 * `expected` (y cada esperada debe haberse producido); el único error de consola
 * admitido es el «Failed to load resource» que Chromium emite por esas mismas
 * respuestas; el token del portal no aparece en ninguna URL.
 */
export function assertConsoleClean(watch: ConsoleWatch, expected: ExpectedFailure[]): void {
  expect(watch.pageErrors, "excepciones de página").toEqual([]);
  expect(watch.tokenInUrl, "el token del portal viajó en una URL").toEqual([]);
  const unexpected = watch.failed.filter((response) => !expected.some((rule) => rule.status === response.status && rule.path.test(new URL(response.url).pathname)));
  expect(unexpected, "respuestas ≥ 400 no declaradas").toEqual([]);
  for (const rule of expected) {
    expect(watch.failed.some((response) => response.status === rule.status && rule.path.test(new URL(response.url).pathname)), `no se produjo la respuesta esperada ${rule.status} ${rule.path}`).toBe(true);
  }
  const strayErrors = watch.errors.filter((entry) => {
    const resourceError = /Failed to load resource/i.test(entry.text);
    if (!resourceError || !entry.url) return true;
    const pathname = new URL(entry.url).pathname;
    return !expected.some((rule) => rule.path.test(pathname) && new RegExp(`status of ${rule.status}`).test(entry.text));
  });
  expect(strayErrors, "errores de consola").toEqual([]);
}
