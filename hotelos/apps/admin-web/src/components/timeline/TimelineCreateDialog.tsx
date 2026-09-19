// Live Timeline · diálogo de creación por celdas (Tanda TL · lote TL-4).
//
// Al seleccionar celdas (habitación × noches) la pantalla ofrece crear una
// reserva: este diálogo confirma la selección y TL-5 navega a Nueva reserva
// con el tipo, la habitación y las fechas prefijados por query
// (`newReservationSearch` del motor). Sin red y sin estilos en línea.

import type { AdminRoom, AdminRoomType } from "../../services/pmsCommerceApi";
import { ACTIONS } from "../../content/actions";
import { dateRange, plural } from "../../lib/format";
import { CocoaCallout, CocoaDialog } from "../cocoa";

export type TimelineCreateSelection = {
  room: AdminRoom;
  roomType?: AdminRoomType;
  arrivalDate: string;
  departureDate: string;
  nights: number;
};

export interface TimelineCreateDialogProps {
  selection: TimelineCreateSelection | null;
  onConfirm(): void;
  onCancel(): void;
}

/** «Hab. 202 · Doble · 21–24 sept (3 noches)» (puro). */
export function createDialogDescription(selection: TimelineCreateSelection): string {
  const type = selection.roomType ? ` · ${selection.roomType.name}` : "";
  return `Hab. ${selection.room.number}${type} · ${dateRange(selection.arrivalDate, selection.departureDate, { style: "dayMonth" })} · ${plural(selection.nights, "noche", "noches")}`;
}

export function TimelineCreateDialog({ selection, onConfirm, onCancel }: TimelineCreateDialogProps) {
  return (
    <CocoaDialog
      open={selection !== null}
      size="sm"
      title="Nueva reserva"
      description={selection ? createDialogDescription(selection) : undefined}
      confirmLabel="Crear reserva"
      cancelLabel={ACTIONS.cancel}
      onConfirm={onConfirm}
      onClose={onCancel}
    >
      <CocoaCallout tone="info" role="note">
        Se abrirá el formulario con la habitación, el tipo y las fechas ya rellenos
      </CocoaCallout>
    </CocoaDialog>
  );
}

export default TimelineCreateDialog;
