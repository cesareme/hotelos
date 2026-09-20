// CocoaFileInput — file picker of Cocoa 22 (COCOA-22.md §3.8 · Tanda 6): a
// bordered CocoaButton («Elegir fichero», UploadIcon) that opens the native
// picker through a visually hidden <input type="file"> — the one raw input
// the contract tolerates, kept here so no screen paints it (rule 4 of
// tests/cocoa-22-contract.test.mjs) — plus the name of the loaded file as a
// secondary caption next to the button. Asked for by three lots of the
// finance wave (banca 6-B, proveedores 6-E, adjuntos).
//
// The component never reads the file: it hands the `File` to `onPick` and the
// caller decides (`file.text()` for a CSB43 / CSV statement, base64 for an
// inline attachment). A file outside `accept` (extension or MIME) or heavier
// than `maxBytes` goes to `onReject` with a Spanish message and never reaches
// `onPick` — the pure `fileInputRejection` decides. The input's value is
// reset after every pick so the same file can be chosen twice in a row.
//
// Tanda T9 (documentos · lote T9-04, DOCUMENTOS-DIGITALIZACION.md §4.1): with
// `multiple` the picker admits several files per pick and hands the admitted
// ones to `onPickMany(files)` — or the first one to `onPick` when the caller
// gave no `onPickMany` — after applying `accept` / `maxBytes` to each file (one
// `onReject` per refused file; the pure `selectAcceptedFiles` decides).
// `capture="environment"` opens the rear camera in the mobile PWA (no
// dependency). Without `multiple` nothing changes for the single-file callers.

import { useId, useRef, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { number as formatNumber } from "../../lib/format";
import { UploadIcon } from "../cocoa-icons/ActionIcons";
import { CocoaButton, type CocoaButtonSize } from "./CocoaButton";

export interface CocoaFileInputProps {
  /** Native `accept` list: extensions and/or MIME types, comma-separated (`.n43,.txt,text/plain`). */
  accept?: string;
  /** Upper bound in bytes; a heavier file is refused before `onPick`. */
  maxBytes?: number;
  /** The chosen file (already within `accept` and `maxBytes`); with `multiple` and no `onPickMany`, the first admitted one. */
  onPick?: (file: File) => void;
  /** Spanish reason a file was refused (type or size); without it the refusal is silent. With `multiple`, once per refused file. */
  onReject?: (message: string) => void;
  /** Several files per pick (native `multiple`); the admitted ones go to `onPickMany`. */
  multiple?: boolean;
  /** Every admitted file of a `multiple` pick (in the order the picker gave them); never called with an empty list. */
  onPickMany?: (files: File[]) => void;
  /** Native `capture`: `environment` (rear camera) or `user` (front camera) on a phone; ignored by desktop browsers. */
  capture?: "environment" | "user";
  /** Button label; default «Elegir fichero». */
  label?: string;
  /** Name of the file currently loaded, painted next to the button (the caller owns it). */
  fileName?: string | null;
  disabled?: boolean;
  /** Button size; default `small` (the picker sits in a row of small actions). */
  size?: CocoaButtonSize;
  /** Button icon; default `UploadIcon`. */
  icon?: ReactNode;
  id?: string;
  "aria-describedby"?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

const KB = 1024;

/** «812 B» · «512 KB» · «2,5 MB» (pure, es-ES, base 1024). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < KB) return `${formatNumber(bytes, { maximumFractionDigits: 0 })} B`;
  if (bytes < KB * KB) return `${formatNumber(bytes / KB, { maximumFractionDigits: 0 })} KB`;
  return `${formatNumber(bytes / (KB * KB), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** Whether a file satisfies a native `accept` list (pure): `.ext` by name, `type/*` or `type/sub` by MIME; an empty list accepts everything. */
export function fileMatchesAccept(file: { name: string; type: string }, accept: string | undefined): boolean {
  const tokens = (accept ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return tokens.some((token) => {
    if (token.startsWith(".")) return name.endsWith(token);
    if (token.endsWith("/*")) return mime !== "" && mime.startsWith(token.slice(0, -1));
    return mime !== "" && mime === token;
  });
}

/** Spanish rejection for a file outside `accept` or over `maxBytes`; null when it passes (pure). */
export function fileInputRejection(file: { name: string; size: number; type: string }, limits: { accept?: string; maxBytes?: number }): string | null {
  if (!fileMatchesAccept(file, limits.accept)) {
    const extensions = (limits.accept ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter((token) => token.startsWith("."))
      .join(", ");
    return extensions ? `El fichero «${file.name}» no es de un tipo admitido (${extensions}).` : `El fichero «${file.name}» no es de un tipo admitido.`;
  }
  if (typeof limits.maxBytes === "number" && file.size > limits.maxBytes) {
    return `El fichero «${file.name}» pesa ${formatFileSize(file.size)}; el máximo es ${formatFileSize(limits.maxBytes)}.`;
  }
  return null;
}

export type FileSelection<T> = {
  /** Files within `accept` and `maxBytes`, in the picker's order. */
  accepted: T[];
  /** Every refused file with its Spanish reason (same order). */
  rejected: Array<{ file: T; reason: string }>;
};

/** Split a multiple pick into admitted files and refusals, applying `fileInputRejection` to each one (pure). */
export function selectAcceptedFiles<T extends { name: string; size: number; type: string }>(files: readonly T[], limits: { accept?: string; maxBytes?: number }): FileSelection<T> {
  const selection: FileSelection<T> = { accepted: [], rejected: [] };
  for (const file of files) {
    const reason = fileInputRejection(file, limits);
    if (reason) selection.rejected.push({ file, reason });
    else selection.accepted.push(file);
  }
  return selection;
}

const nameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

export function CocoaFileInput({
  accept,
  maxBytes,
  onPick,
  onReject,
  multiple = false,
  onPickMany,
  capture,
  label = "Elegir fichero",
  fileName,
  disabled = false,
  size = "small",
  icon,
  id,
  "aria-describedby": ariaDescribedBy,
  className,
  style
}: CocoaFileInputProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reactId = useId();
  const nameId = `cocoa-file-input-name-${reactId}`;
  const describedBy = [fileName ? nameId : null, ariaDescribedBy].filter(Boolean).join(" ") || undefined;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    if (!multiple) {
      const file = files[0];
      const rejection = fileInputRejection(file, { accept, maxBytes });
      if (rejection) {
        onReject?.(rejection);
        return;
      }
      onPick?.(file);
      return;
    }
    const { accepted, rejected } = selectAcceptedFiles(files, { accept, maxBytes });
    for (const { reason } of rejected) onReject?.(reason);
    if (accepted.length === 0) return;
    if (onPickMany) onPickMany(accepted);
    else onPick?.(accepted[0]);
  }

  return (
    <span className={["c22-file-input", "cocoa-row", className].filter(Boolean).join(" ")} data-gap="2" data-cocoa="file-input" style={style}>
      <input ref={inputRef} type="file" accept={accept} multiple={multiple} capture={capture} className="cocoa-sr-only" tabIndex={-1} aria-hidden="true" disabled={disabled} onChange={handleChange} />
      <CocoaButton
        id={id}
        variant="bordered"
        tone="neutral"
        size={size}
        icon={icon ?? <UploadIcon size={14} aria-hidden="true" />}
        disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </CocoaButton>
      {fileName ? (
        <span id={nameId} className="c22-file-input__name" style={nameStyle} title={fileName}>
          {fileName}
        </span>
      ) : null}
    </span>
  );
}

export default CocoaFileInput;
