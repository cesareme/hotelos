import { ScreenScaffold } from "./ScreenScaffold";

export function CompetitorSetScreen() {
  return (
    <ScreenScaffold
      eyebrow="Competitors"
      title="Competitor Set"
      summary="Maintain competitor hotels, comparable scores, room mapping assumptions, source channels and confidence."
      cards={[
        { title: "Gran Via Boutique", metric: "Score 0.88", status: "ok", body: "Comparable urban boutique hotel, 0.4 km away." },
        { title: "Centro Plaza Hotel", metric: "Score 0.81", status: "ok", body: "Comparable urban hotel, 0.7 km away." }
      ]}
    />
  );
}
