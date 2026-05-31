import { ScreenScaffold } from "./ScreenScaffold";

export function RoomTypeManager() {
  return (
    <ScreenScaffold
      eyebrow="Inventory setup"
      title="Room Type Manager"
      summary="Create and manage sellable room types, occupancy, default bed configurations, amenities, photos and linked physical rooms."
      cards={[
        { title: "Double", metric: "2 pax", status: "ok", body: "Standard double room with one queen bed and city-view features." },
        { title: "Validation rules", status: "warn", body: "Room types cannot be deleted when rooms or reservations are linked; they can be deactivated or merged with confirmation." }
      ]}
    />
  );
}
