// DirectorKpiTile — DEPRECATED alias of `CocoaKpi` (COCOA-22.md §7, ola 2).
//
// The Director dashboard tile was the canon `CocoaKpi` was measured from
// (§3.6); the primitive now owns the geometry, the delta chip, the sparkline
// (`cocoa-chart-math.sparklinePath`) and the accessible name. This module
// only maps the legacy prop names (`deltaPolarity` → `polarity`) so the two
// remaining consumers of the old name keep compiling until wave 11 deletes
// it. New screens import `CocoaKpi` from `components/cocoa`.

import { CocoaKpi, type CocoaKpiDeltaUnit, type CocoaKpiPolarity, type CocoaKpiSize, type CocoaKpiStatus } from "../cocoa/CocoaKpi";
import type { ReactNode } from "react";

/** @deprecated Use `CocoaKpiDeltaUnit` from `components/cocoa`. */
export type DirectorKpiDeltaUnit = CocoaKpiDeltaUnit;
/** @deprecated Use `CocoaKpiPolarity` from `components/cocoa`. */
export type DirectorKpiPolarity = CocoaKpiPolarity;
/** @deprecated Use `CocoaKpiStatus` from `components/cocoa`. */
export type DirectorKpiStatus = CocoaKpiStatus;
/** @deprecated Use `CocoaKpiSize` from `components/cocoa`. */
export type DirectorKpiSize = CocoaKpiSize;

/** @deprecated Use `CocoaKpiProps` from `components/cocoa` (`polarity` instead of `deltaPolarity`). */
export interface DirectorKpiTileProps {
  label: string;
  value: string | number;
  unit?: string;
  deltaLabel?: string;
  delta?: number;
  deltaUnit?: DirectorKpiDeltaUnit;
  deltaPolarity?: DirectorKpiPolarity;
  sparkline?: number[];
  icon?: ReactNode;
  status?: DirectorKpiStatus;
  size?: DirectorKpiSize;
  onClick?: () => void;
}

/** @deprecated Use `CocoaKpi` from `components/cocoa`; this alias only renames `deltaPolarity`. */
export function DirectorKpiTile({ deltaPolarity = "positive-good", ...rest }: DirectorKpiTileProps) {
  return <CocoaKpi polarity={deltaPolarity} {...rest} />;
}

export default DirectorKpiTile;
