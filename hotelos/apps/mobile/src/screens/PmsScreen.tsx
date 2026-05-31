import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BedDouble, CalendarDays, ReceiptText } from "lucide-react-native";
import { getPmsSnapshot, type MobileFolio, type MobileReservation, type MobileRoom } from "../services/api";
import { colors } from "../theme/colors";

export function PmsScreen() {
  const [reservations, setReservations] = useState<MobileReservation[]>([]);
  const [rooms, setRooms] = useState<MobileRoom[]>([]);
  const [folio, setFolio] = useState<MobileFolio | null>(null);

  useEffect(() => {
    void getPmsSnapshot().then((snapshot) => {
      setReservations(snapshot.reservations);
      setRooms(snapshot.rooms);
      setFolio(snapshot.folio);
    });
  }, []);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>PMS core</Text>
          <Text style={styles.title}>Rooms</Text>
        </View>
        <BedDouble color={colors.primary} size={28} />
      </View>

      <View style={styles.band}>
        <CalendarDays color={colors.primary} size={22} />
        <View style={styles.bandText}>
          <Text style={styles.bandTitle}>Reservations calendar</Text>
          <Text style={styles.bandMeta}>Arrivals, departures, in-house guests, room assignment, folio, payment, invoice.</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Reservations</Text>
      {reservations.map((reservation) => (
        <View key={reservation.id} style={styles.row}>
          <Text style={styles.rowTitle}>{reservation.code}</Text>
          <Text style={styles.rowMeta}>
            {reservation.status} - {reservation.arrivalDate} to {reservation.departureDate}
          </Text>
        </View>
      ))}

      <Text style={styles.sectionTitle}>Room assignment</Text>
      {rooms.map((room) => (
        <View key={room.id} style={styles.row}>
          <Text style={styles.rowTitle}>Room {room.number}</Text>
          <Text style={styles.rowMeta}>
            {room.status} - housekeeping {room.housekeepingStatus} - maintenance {room.maintenanceStatus}
          </Text>
        </View>
      ))}

      {folio ? (
        <View style={styles.folio}>
          <ReceiptText color={colors.primary} size={22} />
          <View style={styles.bandText}>
            <Text style={styles.bandTitle}>Folio {folio.folio.id}</Text>
            <Text style={styles.bandMeta}>
              Charges {folio.chargesTotal} {folio.folio.currency} - Payments {folio.paymentsTotal} - Balance {folio.balanceDue}
            </Text>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  kicker: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  sectionTitle: {
    marginTop: 4,
    color: colors.ink,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0
  },
  band: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14
  },
  folio: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#eef7f4",
    borderWidth: 1,
    borderColor: "#b7d8d1",
    borderRadius: 8,
    padding: 14
  },
  bandText: {
    flex: 1,
    gap: 4
  },
  bandTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0
  },
  bandMeta: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  row: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: 2
  },
  rowTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0
  },
  rowMeta: {
    color: colors.muted,
    marginTop: 4,
    lineHeight: 20,
    letterSpacing: 0
  }
});

