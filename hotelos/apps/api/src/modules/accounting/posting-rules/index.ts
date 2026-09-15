import type { EventEnvelope } from "@hotelos/shared";
import { reportProjectionFailure } from "../projection.js";
import { recordWithholdingFromEvent } from "./withholding-tax.js";
import { accrueCommissionFromEvent } from "../../commissions/commission-accrual.service.js";

// Registry of the event-driven handlers that run on every domain event next
// to the journal projection (../projection.ts):
//   · withholding-tax.ts — WithholdingTaxRecord projection (Modelo 111);
//   · commissions/commission-accrual.service accrueCommissionFromEvent —
//     channel commission accrual + asiento D 629.1 / H 410 on GuestCheckedOut
//     (the event pms.service really emits) and InvoiceIssued (integration
//     2026-09-16: it replaces posting-rules/commission.ts recordCommissionFromEvent,
//     which listened to an event name that never fires).
//   · payroll: NO handler any more — payroll/periods.service calculatePeriod
//     posts (and reverses before recalculating) synchronously inside the
//     calculation; the legacy recordPayrollFromEvent stays exported below for
//     replays but is not queued on every event.
// Each handler is idempotent (re-driving the event log never duplicates) and
// returns early on irrelevant events. A failure is never swallowed: it is
// logged with the event id and recorded as an ACCOUNTING_PROJECTION_FAILED
// audit event (projection.reportProjectionFailure), the same trail the
// journal projection uses.
const HANDLERS: Array<{ name: string; run: (event: EventEnvelope) => Promise<void> }> = [
  { name: "withholding-tax", run: recordWithholdingFromEvent },
  {
    name: "commission",
    run: async (event) => {
      await accrueCommissionFromEvent(event);
    }
  }
];

let projectionChain: Promise<void> = Promise.resolve();

export function queueExtraProjections(event: EventEnvelope): void {
  projectionChain = projectionChain.then(async () => {
    for (const handler of HANDLERS) {
      try {
        await handler.run(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[accounting/posting-rules] handler ${handler.name} failed for ${event.eventId} (${event.eventType}): ${message}`
        );
        reportProjectionFailure(event, error, 1, handler.name, event.entityId);
      }
    }
  });
}

export async function flushExtraProjections(): Promise<void> {
  await projectionChain;
}

export { recordWithholdingFromEvent } from "./withholding-tax.js";
export { recordCommissionFromEvent, postCommissionAccrual } from "./commission.js";
export { recordPayrollFromEvent, postPayrollPeriod } from "./payroll.js";
