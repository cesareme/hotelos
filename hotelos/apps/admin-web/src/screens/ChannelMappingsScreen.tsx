import { ScreenScaffold } from "./ScreenScaffold";

export function ChannelMappingsScreen() {
  return (
    <ScreenScaffold
      eyebrow="Mappings"
      title="Channel Mappings"
      summary="Validate internal room type to external room code and internal rate plan to external rate code before every sync."
      cards={[
        { title: "Room mappings", metric: "2 active", status: "ok", body: "Double room is mapped for Booking.com mock and Expedia mock." },
        { title: "Rate mappings", metric: "2 active", status: "ok", body: "Flexible BAR is mapped to external rate codes." },
        { title: "Mapping health", status: "warn", body: "Missing or duplicate mappings block ARI pushes and create channel health alerts." }
      ]}
    />
  );
}
