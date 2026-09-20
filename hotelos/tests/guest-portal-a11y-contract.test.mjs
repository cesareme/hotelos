import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// Tanda L7 · L7-05 — Asistente de 6 pasos y kiosco accesibles (WCAG 2.2 AA;
// UX-RECEPCION-FEEL.md §7.1, recon-delta §14 y §18 D6). Contrato sobre el código
// que se pinta (comentarios fuera): etiquetas explícitas, regiones vivas, foco al
// título del paso, firma con alternativa sin arrastre, aviso de inactividad del
// kiosco como alerta con botón grande, códigos numéricos de un solo uso, cámara
// operable por teclado, sin literales ingleses, 0 `style=` y solo claves de copy
// que ya existen en wizard.ts (este lote no añade copy).

const SRC = (path) => new URL(`../apps/guest-web/src/${path}`, import.meta.url);
const read = (path) => readFileSync(SRC(path), "utf8");

/** Quita comentarios (// y /* *\/, también dentro de JSX) para mirar solo el código que se pinta. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FILES = {
  wizard: "pages/CheckInWizardPage.tsx",
  arrival: "pages/ArrivalPage.tsx",
  kiosk: "kiosk/KioskShell.tsx",
  kioskMode: "kiosk/kiosk-mode.ts",
  camera: "components/DocumentCamera.tsx",
  signature: "components/SignaturePad.tsx",
  qr: "components/QrCode.tsx",
  chat: "components/ChatWidget.tsx"
};

const code = Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, stripComments(read(path))]));
const raw = Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, read(path)]));
const wizardCopy = read("checkin/wizard.ts");
const styles = read("styles.css");
const layout = read("components/Layout.tsx");

/** Claves de COPY_ES (la tabla en español es la fuente de CopyKey). */
const COPY_KEYS = new Set((/const COPY_ES = \{([\s\S]*?)\} as const;/.exec(wizardCopy)?.[1] ?? "").split("\n").map((line) => /^\s{2}([A-Za-z0-9]+): "/.exec(line)?.[1]).filter(Boolean));

// Literales ingleses que un lote apresurado podría pintar en el asistente o el kiosco.
const FORBIDDEN_EN = [
  "Continue", "Back", "Next", "Sign", "Sign here", "Clear", "Sign at reception", "Cancel", "Take a photo", "Use the camera", "Capture", "Read the MRZ",
  "Loading", "Saving", "Retry", "Step", "Travellers", "Document", "Details", "Signature", "Payment", "Arrival", "Your key", "Your room", "Welcome",
  "Touch to start", "Pairing code", "Pair", "Find", "Finish", "Stay here", "Keep going", "No activity", "Language", "English", "Spanish",
  "Send", "Sending", "Type your message", "Chat with the front desk", "Ticket", "Please go to the desk"
];

describe("Guest Portal · Tanda L7 · L7-05 (asistente y kiosco accesibles)", () => {
  it("solo se pintan claves de copy existentes en wizard.ts (sin literales ingleses, sin copy nuevo)", () => {
    for (const [name, source] of Object.entries(code)) {
      if (name === "kioskMode") continue;
      // Toda clave t(lang, "x") existe en COPY_ES (el lote no toca wizard.ts).
      for (const match of source.matchAll(/\bt\(lang, "([A-Za-z0-9]+)"/g)) {
        assert.equal(COPY_KEYS.has(match[1]), true, `${FILES[name]} usa la clave inexistente «${match[1]}»`);
      }
      for (const literal of FORBIDDEN_EN) {
        const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Texto JSX (>Literal<), atributo/prop ("Literal") o rama de ternario.
        assert.doesNotMatch(source, new RegExp(`(>\\s*|["'\`])${escaped}(\\s*<|["'\`…\\.])`), `${FILES[name]} pinta «${literal}» sin traducir`);
      }
      assert.doesNotMatch(source, /\sstyle=\{/, `${FILES[name]} sin style= inline (Cocoa)`);
    }
    assert.match(wizardCopy, /^  statusHandedOff: "En recepción",$/m, "«Firmar en recepción» se deriva de sign + statusHandedOff");
    assert.match(code.signature, /export function deferSignatureLabel\(lang: Lang\): string \{\n  return `\$\{t\(lang, "sign"\)\} \$\{t\(lang, "statusHandedOff"\)\.toLowerCase\(\)\}`;/);
  });

  it("todas las clases usadas existen en styles.css (0 CSS nuevo: clases de CHK y L7-01)", () => {
    const known = new Set([...styles.matchAll(/\.(gp-[a-z0-9-]+)/g)].map((match) => match[1]));
    // Clases de CHK · W4-C sin regla propia (heredan del contenedor); anteriores a este lote.
    const PREEXISTING = new Set(["gp-step-label", "gp-traveller", "gp-extras", "gp-chat"]);
    for (const [name, source] of Object.entries(code)) {
      for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
        const classes = (match[1] ?? match[2] ?? "").replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter((cls) => cls.startsWith("gp-") && !cls.endsWith("-") && !PREEXISTING.has(cls));
        for (const cls of classes) assert.equal(known.has(cls), true, `${FILES[name]} usa la clase «${cls}» que no existe en styles.css`);
      }
    }
    assert.match(styles, /\.gp-visually-hidden \{/);
    assert.match(styles, /\.gp-button-big \{\n  min-height: 56px;/, "el botón grande del kiosco mide ≥ 56 px");
  });

  it("asistente: foco al título del paso (role=heading, tabIndex -1) al cambiar de paso y al cargar", () => {
    const wizard = code.wizard;
    assert.match(wizard, /export const STEP_TITLE_ID = "gp-step-title";/);
    assert.match(wizard, /<span className="gp-progress-label" role="heading" aria-level=\{2\} id=\{STEP_TITLE_ID\} tabIndex=\{-1\} ref=\{titleRef\}>/);
    assert.match(wizard, /\{t\(lang, "stepOf", \{ index: progress\.index, total: progress\.total \}\)\} · \{stepLabel\(step, lang\)\}/, "el título lleva «Paso n de 6 · Nombre del paso»");
    assert.match(wizard, /const titleRef = useRef<HTMLElement \| null>\(null\);/);
    assert.match(wizard, /if \(!ready \|\| focusedStepRef\.current === step\) return;\n    focusedStepRef\.current = step;\n    titleRef\.current\?\.focus\(/, "el foco va al título en cada cambio de paso");
    assert.match(wizard, /role="progressbar" aria-valuemin=\{0\} aria-valuemax=\{100\} aria-valuenow=\{progress\.percent\} aria-labelledby=\{STEP_TITLE_ID\}/);
    // El grupo conserva el nombre «Paso n de 6» que usa la spec e2e de L7-03.
    assert.match(wizard, /className="gp-progress" role="group" aria-label=\{t\(lang, "stepOf", \{ index: progress\.index, total: progress\.total \}\)\}/);
    // Un solo selector de idioma: el de la cabecera (LangContext); el del asistente solo sin proveedor.
    assert.match(wizard, /const headerHasLanguage = useContext\(LangContext\) !== null;/);
    assert.match(wizard, /\{!headerHasLanguage \? \(\n\s+<button type="button" className="gp-link gp-lang"/);
    assert.match(wizard, /<nav className="gp-wizard-nav" aria-label=\{t\(lang, "wizardEyebrow"\)\}>/);
  });

  it("asistente: regiones vivas para errores y ocupado, aria-busy en el asistente y en cada tarjeta", () => {
    const wizard = code.wizard;
    assert.match(wizard, /<div className=\{`gp-wizard\$\{isKiosk \? " gp-wizard-kiosk" : ""\}`\} aria-busy=\{busy \|\| preparing\}>/);
    assert.match(wizard, /<p className="gp-visually-hidden" role="status">\{busy \? t\(lang, "saving"\) : ""\}<\/p>/);
    assert.match(wizard, /<div aria-live="polite">\{error \? <p className="gp-error" role="alert">\{error\}<\/p> : null\}<\/div>/);
    assert.match(wizard, /<div aria-live="polite">\{inlineError \? <p className="gp-error" role="alert">\{inlineError\}<\/p> : null\}<\/div>/);
    assert.match(wizard, /<div aria-live="polite">\{unreadable\[guest\.id\] \? <p className="gp-error" role="alert">/);
    assert.match(wizard, /<div aria-live="polite">\{mismatch\[guest\.id\] \? <p className="gp-error" role="alert">/);
    assert.match(wizard, /<p className="gp-payment-message" role="status">/);
    assert.match(wizard, /<div className="gp-card gp-skeleton" role="status" aria-live="polite">\{t\(lang, "loading"\)\}<\/div>/);
    assert.match(wizard, /<p className="gp-card gp-skeleton" role="status">\{t\(lang, "preparingRecords"\)\}<\/p>/);
    for (const form of ["gp-traveller", "gp-details"]) {
      assert.match(wizard, new RegExp(`className="gp-card gp-form ${form}" onSubmit=\\{\\(event\\) => void submit\\(event\\)\\} noValidate aria-labelledby=\\{headId\\} aria-busy=\\{busy\\}`), `${form} con nombre y aria-busy`);
    }
    assert.match(wizard, /className="gp-card gp-signature-card" aria-labelledby=\{headId\} aria-busy=\{busyGuestId === guest\.id\}/);
    assert.match(wizard, /className="gp-card gp-document" aria-labelledby=\{headId\} aria-busy=\{busyGuestId === guest\.id\}/);
  });

  it("asistente: <label htmlFor> + id en todos los campos, aria-invalid y aria-describedby con las faltas en «Datos»", () => {
    const wizard = code.wizard;
    assert.match(wizard, /export function fieldId\(scope: string, guestId: string, field: string\): string \{\n  return `gp-\$\{scope\}-\$\{guestId\}-\$\{field\}`;/);
    assert.match(wizard, /export function isFieldMissing\(field: string, missing: readonly string\[\]\): boolean/);
    // Ningún <label className="gp-field"> ni <label className="gp-check"> sin htmlFor.
    for (const match of wizard.matchAll(/<label className="(gp-field|gp-check)"([^>]*)>/g)) {
      assert.match(match[2], /htmlFor=\{/, `<label className="${match[1]}"${match[2]}> sin htmlFor`);
    }
    // Ningún control de formulario sin id (los de Datos lo reciben por {...a11y(key)}).
    for (const match of wizard.matchAll(/<(input|select)\s([^>]*)\/?>/g)) {
      assert.match(match[2], /\bid=\{|\{\.\.\.a11y\(/, `<${match[1]} ${match[2].slice(0, 60)}…> sin id`);
    }
    // Datos: faltas → aria-invalid + aria-describedby (lista de faltas y origen MRZ/visión).
    assert.match(wizard, /const invalid = isFieldMissing\(key, missing\);/);
    assert.match(wizard, /"aria-invalid": invalid \|\| undefined, "aria-describedby": describedBy \|\| undefined/);
    assert.match(wizard, /<p className="gp-missing" id=\{missingId\}>/);
    assert.match(wizard, /<small className="gp-badge-source" id=\{id\(`\$\{key\}-source`\)\}>/);
    assert.match(wizard, /email: \["contact", "email"\],\n  phoneMobile: \["contact", "phoneMobile"\],/, "«correo o móvil» marca los dos campos");
    assert.match(wizard, /residenceFullAddress: \["residenceFullAddress", "residenceAddress"\],/);
    // Consentimiento obligatorio y textos de política como descripción.
    assert.match(wizard, /aria-required aria-describedby=\{policy\.guestConsentText \? id\("gdpr-text"\) : undefined\}/);
    // OTP: código numérico de un solo uso con etiqueta y descripción.
    assert.match(wizard, /<input id=\{id\("otp-code"\)\} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength=\{6\} value=\{code\} onChange=\{\(event\) => setCode\(event\.target\.value\)\} aria-describedby=\{id\("otp-sent"\)\} \/>/);
    assert.match(wizard, /<div className="gp-chips" role="group" aria-labelledby=\{id\("prefs-title"\)\}>/);
    assert.match(wizard, /aria-describedby=\{id\("arrive-hint"\)\}>/);
  });

  it("firma: canvas role=img con descripción y alternativa sin arrastre «Firmar en recepción» (kiosco → handoff con ticket; móvil → aviso y puede seguir)", () => {
    const signature = code.signature;
    assert.match(signature, /role="img"\n\s+aria-label=\{t\(lang, "signHere"\)\}\n\s+aria-describedby=\{`\$\{hintId\} \$\{toolsId\}`\}/);
    assert.match(signature, /<p id=\{hintId\} className="gp-visually-hidden">\{t\(lang, "signatureIntro"\)\}<\/p>/);
    assert.match(signature, /onDefer\?: \(\) => void;/);
    assert.match(signature, /\{onDefer \? \(\n\s+<button type="button" className="gp-link" onClick=\{onDefer\} disabled=\{disabled\}>\n\s+\{deferLabel \?\? deferSignatureLabel\(lang\)\}/);
    const wizard = code.wizard;
    assert.match(wizard, /import \{ SignaturePad, deferSignatureLabel \} from "\.\.\/components\/SignaturePad";/);
    assert.match(wizard, /onDefer=\{\(\) => onDefer\(guest\.id\)\}/, "el asistente pasa la alternativa al lienzo");
    assert.match(wizard, /export function deferredSignatureMessage\(lang: Lang\): string \{\n  return `\$\{t\(lang, "signatureMissing"\)\} \$\{deferSignatureLabel\(lang\)\}\.`;/);
    assert.match(wizard, /: !kiosk && deferred\[guest\.id\] \? \(\n\s+<p className="gp-meta" role="status">\{deferredSignatureMessage\(lang\)\}<\/p>/, "móvil: aviso honesto en vez del lienzo");
    // Corrector L7-REV-05: el kiosco deriva en el SERVIDOR (POST /guest-portal/check-in/handoff) y solo pinta el ticket que devuelve el API.
    assert.match(wizard, /const deferSignature = \(guestId: string\) => \{\n\s+if \(kiosk\) \{\n(?:\s+\/\/[^\n]*\n)*\s+void handoffAtReception\(\);\n\s+return;\n\s+\}\n\s+setDeferredSignatures/, "kiosco: deriva la sesión en el servidor; móvil: marca la firma como diferida");
    assert.match(wizard, /const result = await handoffCheckIn\("signature"\);/);
    assert.match(wizard, /code: "SIGNATURE_AT_RECEPTION"[^\n]*handoff: true, ticket: result\.ticket \}\)/, "el ticket que se pinta es el del servidor");
    assert.match(wizard, /const advance = canAdvance\(session, step\) \|\| allDeferred;/);
    assert.match(wizard, /\.\.\.\(handoff \? \{ handoff: true \} : \{\}\)/);
    const arrival = code.arrival;
    assert.match(arrival, /handoff\?: boolean;/);
    assert.match(arrival, /ticket\?: string;/);
    assert.match(arrival, /const showHandoff = kiosk && \(view\.handoff \|\| outcome\.handoff === true\);/);
    assert.match(arrival, /const ticket = showHandoff && typeof outcome\.ticket === "string" && outcome\.ticket\.trim\(\) \? outcome\.ticket\.trim\(\) : null;/, "sin ticket del servidor no se inventa ninguno");
    assert.match(arrival, /\{ticket \? <p className="gp-confirmation">\{t\(lang, "handoffTicket", \{ ticket \}\)\}<\/p> : null\}/);
    assert.doesNotMatch(readFileSync(new URL("../apps/guest-web/src/kiosk/KioskShell.tsx", import.meta.url), "utf8"), /handoffTicket\(/, "KioskShell no calcula tickets en cliente");
    assert.doesNotMatch(readFileSync(new URL("../apps/guest-web/src/kiosk/kiosk-mode.ts", import.meta.url), "utf8"), /export function handoffTicket/, "kiosk-mode ya no exporta un ticket de cliente");
    // El botón «Firmar» exacto y el nombre del lienzo que usa la spec e2e siguen igual.
    assert.match(wizard, /\{busyGuestId === guest\.id \? t\(lang, "saving"\) : t\(lang, "sign"\)\}/);
    assert.match(raw.signature, /aria-label=\{t\(lang, "signHere"\)\}/);
  });

  it("llegada: role=status, foco al contenido al montarse, QR con <title> y número de serie en texto", () => {
    const arrival = code.arrival;
    assert.match(arrival, /function useFocusMain\(\) \{[\s\S]*document\.getElementById\("gp-main"\);[\s\S]*main\.focus\(\{ preventScroll: true \}\)/);
    assert.match(arrival, /className="gp-card gp-arrival-room" role="status"/);
    assert.match(arrival, /className=\{`gp-card \$\{view\.done \? "gp-success" : "gp-arrival-pending"\}`\} role="status"/);
    assert.match(arrival, /<QrCode value=\{key\.qr\} label=\{t\(lang, "arrivalKey"\)\} \/>\n\s+<span className="gp-qr-serial">\{key\.serialNumber\}<\/span>/);
    assert.match(layout, /<main id="gp-main" className="gp-main" tabIndex=\{-1\}>/, "Layout (L7-01) expone el destino del foco");
    const qr = code.qr;
    assert.match(qr, /role="img" aria-label=\{label\} aria-labelledby=\{titleId\} focusable="false"/);
    assert.match(qr, /<title id=\{titleId\}>\{label\}<\/title>/);
  });

  it("kiosco: idioma por LangContext + <html lang>, aviso de inactividad role=alert con cuenta atrás y botón ≥ 56 px, foco al título de pantalla", () => {
    const kiosk = code.kiosk;
    assert.match(kiosk, /import \{ LangContext \} from "\.\.\/components\/Layout";/);
    assert.match(kiosk, /<LangContext\.Provider value=\{\{ lang, setLang \}\}>/);
    assert.match(kiosk, /document\.documentElement\.lang = lang;/);
    assert.match(kiosk, /export const IDLE_WARNING_SECONDS = Math\.ceil\(IDLE_WARNING_MS \/ 1000\);/);
    assert.match(code.kioskMode, /export const IDLE_WARNING_MS = 15_000;/);
    assert.match(kiosk, /<div className="gp-kiosk-idle-warning" role="alert">/);
    assert.doesNotMatch(kiosk, /gp-kiosk-idle-warning" role="status" aria-live="polite"/, "ya no es un status educado: es una alerta");
    // La frase se anuncia UNA vez (segundos fijos) y la cuenta atrás visible no se relee cada segundo.
    assert.match(kiosk, /<span className="gp-visually-hidden">\{t\(lang, "kioskIdleWarning", \{ seconds: IDLE_WARNING_SECONDS \}\)\}<\/span>/);
    assert.match(kiosk, /<span aria-hidden>\{t\(lang, "kioskIdleWarning", \{ seconds: secondsLeft \}\)\}<\/span>/);
    assert.match(kiosk, /<button type="button" className="gp-button gp-button-primary gp-button-big" onClick=\{stay\}>\n\s+\{t\(lang, "next"\)\}/, "botón «Continuar» (clave existente) de 56 px");
    assert.match(kiosk, /function stay\(\) \{\n\s+setSecondsLeft\(null\);\n\s+timerRef\.current\?\.touch\(\);/);
    // Foco al h1 de cada pantalla propia del kiosco.
    assert.equal((kiosk.match(/<h1 tabIndex=\{-1\} ref=\{headingRef\}>/g) ?? []).length, 3, "las tres pantallas del kiosco enfocan su título");
    assert.match(kiosk, /if \(screen === "pairing" \|\| screen === "idle" \|\| screen === "locate"\) headingRef\.current\?\.focus\(/);
  });

  it("kiosco: código de emparejamiento numérico de un solo uso con etiqueta, y campos de localización etiquetados con errores en regiones vivas", () => {
    const kiosk = code.kiosk;
    assert.match(kiosk, /<label className="gp-field" htmlFor=\{ids\.pairCode\}>/);
    assert.match(kiosk, /<input id=\{ids\.pairCode\} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength=\{9\} value=\{code\} onChange=\{\(event\) => setCode\(event\.target\.value\)\} className="gp-kiosk-code" aria-describedby=\{ids\.pairIntro\} aria-invalid=\{error \? true : undefined\} \/>/);
    assert.doesNotMatch(kiosk, /inputMode="numeric" autoComplete="off"/, "el código de emparejamiento ya no bloquea el autocompletado de un solo uso");
    for (const field of ["invitation", "reservationCode", "email"]) {
      assert.match(kiosk, new RegExp(`<label className="gp-field" htmlFor=\\{ids\\.${field}\\}>`), `${field} con htmlFor`);
      assert.match(kiosk, new RegExp(`<input id=\\{ids\\.${field}\\}`), `${field} con id`);
    }
    assert.equal((kiosk.match(/<div aria-live="polite">\{error \? <p className="gp-error" role="alert">\{error\}<\/p> : null\}<\/div>/g) ?? []).length, 2, "errores de emparejamiento y de localización en regiones vivas");
    assert.equal((kiosk.match(/noValidate aria-busy=\{busy\}/g) ?? []).length, 3, "los tres formularios del kiosco marcan aria-busy");
    assert.match(kiosk, /className="gp-link gp-lang" onClick=\{\(\) => setLang\(lang === "es" \? "en" : "es"\)\} lang=\{lang === "es" \? "en" : "es"\} aria-label=\{t\(lang, "langSelector"\)\}/);
  });

  it("cámara: operable por teclado (botón real abre el input de fichero, que no se tabula), vídeo decorativo, MRZ con aria-controls y etiqueta, errores en región viva", () => {
    const camera = code.camera;
    // La cadena exacta que fija tests/guest-portal-ui-contract.test.mjs se conserva.
    assert.match(camera, /<input ref=\{fileInputRef\} type="file" accept="image\/\*" capture="environment" className="gp-visually-hidden" tabIndex=\{-1\} aria-hidden onChange=\{\(event\) => void onFile\(event\)\} disabled=\{busy\} \/>/);
    assert.match(camera, /<button type="button" className="gp-button gp-button-primary" onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\} disabled=\{busy\} aria-describedby=\{hintId\}>/);
    assert.doesNotMatch(camera, /<label className=\{`gp-button gp-button-primary gp-file-button/, "el input de fichero ya no va dentro de un <label> sin foco visible");
    assert.match(camera, /<video ref=\{videoRef\} className="gp-camera-video" playsInline muted autoPlay aria-hidden \/>/);
    assert.match(camera, /<div className="gp-camera-live" role="group" aria-label=\{t\(lang, "useCamera"\)\}>/);
    assert.match(camera, /aria-expanded=\{mrzOpen\} aria-controls=\{mrzPanelId\}>/);
    assert.match(camera, /<div className="gp-stacked" id=\{mrzPanelId\} hidden=\{!mrzOpen\}>/);
    assert.match(camera, /<label htmlFor=\{mrzInputId\} className="gp-visually-hidden">\n\s+\{t\(lang, "sendMrz"\)\}/);
    assert.match(camera, /<textarea id=\{mrzInputId\} className="gp-mrz-input"/);
    assert.match(camera, /<div className="gp-camera" aria-busy=\{busy\}>/);
    assert.match(camera, /<p className="gp-visually-hidden" role="status">\{busy \? t\(lang, "processing"\) : ""\}<\/p>/);
    assert.match(camera, /<div aria-live="polite">\{localError \? <p className="gp-error" role="alert">\{localError\}<\/p> : null\}<\/div>/);
  });

  it("chat: sección nombrada por su título, campo con etiqueta explícita y descripción, estado ocupado y errores anunciados", () => {
    const chat = code.chat;
    assert.match(chat, /<section className="gp-card gp-chat" aria-labelledby=\{titleId\} aria-busy=\{busy\}>/);
    assert.match(chat, /<p className="gp-label" id=\{titleId\}>\{t\(lang, "chatTitle"\)\}<\/p>/);
    assert.match(chat, /<div className="gp-chat-log" ref=\{listRef\} role="log" aria-live="polite" aria-busy=\{busy\}>/);
    assert.match(chat, /<p className="gp-visually-hidden" role="status">\{busy \? t\(lang, "chatSending"\) : ""\}<\/p>/);
    assert.match(chat, /<div aria-live="polite">\{error \? <p className="gp-error" role="alert">\{error\}<\/p> : null\}<\/div>/);
    assert.match(chat, /<label className="gp-field gp-chat-field" htmlFor=\{inputId\}>/);
    assert.match(chat, /<input id=\{inputId\} type="text" value=\{text\} onChange=\{\(event\) => setText\(event\.target\.value\)\} placeholder=\{t\(lang, "chatPlaceholder"\)\} maxLength=\{4000\} disabled=\{busy\} autoComplete="off" aria-describedby=\{introId\} \/>/);
    assert.match(chat, /<p className="gp-disclosure" role="status">/);
  });
});
