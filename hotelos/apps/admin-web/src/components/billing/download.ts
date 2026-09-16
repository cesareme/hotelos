// Materialise a downloaded Blob in the browser (Finanzas · Tanda 6): the API
// answers PDFs and CSV through apiRequestBlob; the screen names the file with
// the Content-Disposition of the answer (finance-contracts.downloadFilename).
// The object URL is revoked after the click so long sessions do not leak.

export function saveBlob(blob: Blob, filename: string): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open a Blob in a new tab (a PDF the operator wants to read before saving). Returns false when the browser blocked the window. */
export function openBlob(blob: Blob): boolean {
  if (typeof window === "undefined") return false;
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return popup !== null;
}
