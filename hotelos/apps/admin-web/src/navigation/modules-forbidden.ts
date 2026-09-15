// Session registry of the properties whose module list answered 403
// (Tanda 5 · L1c): `useEnabledModules` remembers the answer so a container
// or ⌘K that mounts later does not repeat GET /backoffice/properties/:id/modules
// for a user without `modules.read`. Forgotten on a module change of the
// property, on an explicit retry and on login/logout. Pure (unit-tested);
// the hook wires the events.

export type ForbiddenRegistry = {
  has: (propertyId: string) => boolean;
  add: (propertyId: string) => void;
  /** Forget one property, or every one when omitted. */
  forget: (propertyId?: string) => void;
  size: () => number;
};

export function createForbiddenRegistry(): ForbiddenRegistry {
  const forbidden = new Set<string>();
  return {
    has: (propertyId) => forbidden.has(propertyId),
    add: (propertyId) => {
      forbidden.add(propertyId);
    },
    forget: (propertyId) => {
      if (propertyId === undefined) forbidden.clear();
      else forbidden.delete(propertyId);
    },
    size: () => forbidden.size
  };
}
