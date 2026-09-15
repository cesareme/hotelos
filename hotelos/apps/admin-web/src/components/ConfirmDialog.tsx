// ConfirmDialog — legacy API kept for its 14 consumers; renders CocoaDialog
// (Cocoa 22, COCOA-22.md §3.9): tokens only, `--cocoa-z-modal`, scrim label
// 45 %, CocoaButton actions (destructive filled for `variant="danger"`),
// focus trap, initial focus on Cancel for destructive dialogs, Esc / overlay
// cancel. New code should use `CocoaDialog` directly.
//
// Usage:
//   <ConfirmDialog open title="¿Eliminar este recurso?" description="Esta acción no se puede deshacer."
//     variant="danger" onConfirm={doDelete} onCancel={() => setOpen(false)} />

import type { ReactNode } from "react";
import { CocoaDialog } from "./cocoa/CocoaDialog";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "primary";
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  /** Extra content under the description (lists, notes); part of the dialog's description for screen readers. */
  children?: ReactNode;
  /** The caller is awaiting its own request: spinner on confirm, cancel disabled. */
  busy?: boolean;
};

export function ConfirmDialog(props: ConfirmDialogProps) {
  const { open, title, description, confirmLabel = "Confirmar", cancelLabel = "Cancelar", variant = "primary", onConfirm, onCancel, children, busy } = props;
  return (
    <CocoaDialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      tone={variant === "danger" ? "destructive" : "primary"}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={onConfirm}
      busy={busy}
    >
      {children}
    </CocoaDialog>
  );
}

export default ConfirmDialog;
