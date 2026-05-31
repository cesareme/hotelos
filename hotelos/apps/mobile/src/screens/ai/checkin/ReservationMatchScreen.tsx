import { Text } from "react-native";
import { HotelCard, ReservationCard, StatusChip, TimelineDataGrid } from "@hotelos/ui";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";
import { checkInGuest } from "./checkInFlowData";

export function ReservationMatchScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="match"
      title="Reservation match"
      subtitle="The backend matching tool proposes the reservation but does not check the guest in yet."
      stateLabel="matched"
    >
      <ReservationCard
        code={checkInGuest.reservationCode}
        guestName={checkInGuest.name}
        stay={`${checkInGuest.arrival} - ${checkInGuest.departure}`}
        status="arrival today"
        balance={checkInGuest.balance}
        nextAction="Validate room 432 before check-in."
      />
      <HotelCard title="Match evidence">
        <TimelineDataGrid
          items={[
            { label: "Name", value: "Strong match" },
            { label: "Arrival", value: "Today" },
            { label: "Document", value: "New required data" },
            { label: "Confidence", value: "94%" }
          ]}
        />
        <Text>Reception can change the match before execution.</Text>
        <StatusChip label="No database write yet" tone="ai" />
      </HotelCard>
    </CheckInFlowScaffold>
  );
}
