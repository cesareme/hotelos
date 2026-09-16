// Floor labels of the room rack (Cocoa 22 · ola 3 · fix:3-A qa#11). The API
// groups rooms by the raw `floor` and sends "" for the 120 rooms of Rías
// Altas, "—" when the column is null, and a value that already says
// «Planta 1» on Los Tilos; interpolating it read «Planta » and «Planta Planta
// 1». Pure and unit-tested (__tests__/room-rack-labels.test.mts).

/** Filter / group key of the rooms without a floor (never "" so the select keeps a real value). */
export const NO_FLOOR_KEY = "sin-planta";

/** Floor the API sends → trimmed value, or null when it is blank or the "—" placeholder. */
export function normalizeFloor(floor: string | null | undefined): string | null {
  const value = (floor ?? "").trim();
  return !value || /^[—–-]+$/.test(value) ? null : value;
}

/** Stable key of a floor group; the same for every spelling of «no floor». */
export function floorKey(floor: string | null | undefined): string {
  return normalizeFloor(floor) ?? NO_FLOOR_KEY;
}

/** Visible title: «Sin planta», «Planta 2» for a bare value, the value itself when it already says «Planta». */
export function floorTitle(floor: string | null | undefined): string {
  const value = normalizeFloor(floor);
  if (!value) return "Sin planta";
  return /^planta\b/i.test(value) ? value : `Planta ${value}`;
}
