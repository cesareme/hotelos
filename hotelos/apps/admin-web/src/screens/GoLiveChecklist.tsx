function navigateTo(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

export function GoLiveChecklist() {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2>Go-live checklist</h2>
        <span className="bo-status error">blocked</span>
      </div>
      <ul className="bo-list">
        <li className="bo-row">
          <strong>Property legal profile</strong>
          <span className="bo-status ok">ready</span>
          <button type="button" className="ghost" onClick={() => navigateTo("PropertyProfileSetupForm")}>Review</button>
        </li>
        <li className="bo-row">
          <strong>At least one active sellable room</strong>
          <span className="bo-status ok">ready</span>
          <button type="button" className="ghost" onClick={() => navigateTo("RoomSetupForm")}>Review</button>
        </li>
        <li className="bo-row">
          <strong>Invoice sequence if billing is enabled</strong>
          <span className="bo-status error">blocking</span>
          <button type="button" className="ghost" onClick={() => navigateTo("BillingSettings")}>Configure</button>
        </li>
        <li className="bo-row">
          <strong>SES.HOSPEDAJES credentials if Spain compliance is enabled</strong>
          <span className="bo-status error">blocking</span>
          <button type="button" className="ghost" onClick={() => navigateTo("SesHospedajesSettings")}>Configure</button>
        </li>
        <li className="bo-row">
          <strong>Payment provider if Payment Vault is enabled</strong>
          <span className="bo-status ok">ready</span>
          <button type="button" className="ghost" onClick={() => navigateTo("PaymentSettings")}>Review</button>
        </li>
      </ul>
      <div className="bo-actions">
        <button className="primary" type="button" onClick={() => navigateTo("OnboardingGoLiveReadiness")}>Recalculate readiness</button>
        <button type="button" onClick={() => navigateTo("OnboardingGoLiveReadiness")}>Request go-live approval</button>
      </div>
    </section>
  );
}
