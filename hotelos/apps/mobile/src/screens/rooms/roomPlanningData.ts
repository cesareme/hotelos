export const roomFilters = [
  "All",
  "Arrivals",
  "Departures",
  "Clean",
  "Dirty",
  "Inspected",
  "Blocked",
  "VIP",
  "Balance pending",
  "Compliance pending"
];

export const planningRooms = [
  {
    roomNumber: "432",
    roomType: "Double Standard",
    occupancy: "vacant",
    housekeeping: "inspected",
    maintenance: "clear",
    nextArrival: "Maria Lopez, 15:00",
    balance: "EUR 0",
    complianceState: "signature pending",
    nextBestAction: "Check in now after phone and signature."
  },
  {
    roomNumber: "108",
    roomType: "Double Standard",
    occupancy: "vacant",
    housekeeping: "clean",
    maintenance: "blocked",
    nextArrival: "No arrival",
    balance: "EUR 0",
    complianceState: "ok",
    nextBestAction: "Resolve bathroom leak before selling."
  },
  {
    roomNumber: "204",
    roomType: "Double Standard",
    occupancy: "departure pending",
    housekeeping: "dirty",
    maintenance: "clear",
    guest: "Carlos Martin",
    balance: "EUR 42",
    complianceState: "ok",
    nextBestAction: "Departure clean, then supervisor inspection."
  },
  {
    roomNumber: "308",
    roomType: "Superior",
    occupancy: "available",
    housekeeping: "inspected",
    maintenance: "clear",
    nextArrival: "R. Silva, 18:30",
    balance: "EUR 96",
    complianceState: "pre-check complete",
    nextBestAction: "Collect balance before key handoff."
  }
];

export const planningDates = ["May 14", "May 15", "May 16", "May 17"];
