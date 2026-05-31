// Frontend client for the interactive POS (TPV) board.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type PosOutlet = { id: string; name: string; category: string };
export type PosLine = { name: string; quantity: number; unitPrice: number; total: number };
export type PosTicket = {
  id: string;
  propertyId: string;
  outletId: string;
  outletName: string;
  status: "open" | "closed";
  roomNumber?: string;
  lines: PosLine[];
  total: number;
  settlement?: "room" | "cash" | "card";
  createdAt: string;
  closedAt?: string;
};

export function fetchPosOutlets(propertyId = getActivePropertyId()) {
  return apiRequest<PosOutlet[]>(`/properties/${propertyId}/pos/outlets`);
}
export function fetchPosTickets(propertyId = getActivePropertyId()) {
  return apiRequest<PosTicket[]>(`/properties/${propertyId}/pos/tickets`);
}
export function openPosTicket(payload: { outletId: string; roomNumber?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<PosTicket>(`/pos/tickets`, { method: "POST", body: { propertyId, ...payload } });
}
export function addPosLine(ticketId: string, line: { name: string; quantity: number; unitPrice: number }) {
  return apiRequest<PosTicket>(`/pos/tickets/${ticketId}/lines`, { method: "POST", body: line });
}
export function closePosTicket(ticketId: string, settlement: "room" | "cash" | "card") {
  return apiRequest<PosTicket>(`/pos/tickets/${ticketId}/close`, { method: "POST", body: { settlement } });
}
