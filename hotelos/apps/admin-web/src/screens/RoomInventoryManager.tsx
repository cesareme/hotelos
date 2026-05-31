import { ScreenScaffold } from "./ScreenScaffold";

export function RoomInventoryManager() {
  return (
    <ScreenScaffold
      eyebrow="Physical rooms"
      title="Room Inventory Manager"
      summary="Manage rooms, bed setups, features, accessibility, sellable state, QR codes, housekeeping sections and maintenance areas."
      cards={[
        { title: "Mapped rooms", metric: "2", status: "warn", body: "Rooms 432 and 108 are mapped to the main building. Bulk creation can add ranges such as 401 to 440." },
        { title: "Sellable validation", status: "ok", body: "Sellable rooms must have a room type and cannot be assigned to disabled floors or buildings." }
      ]}
    />
  );
}
