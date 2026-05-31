import type { EventEnvelope } from "@hotelos/shared";
import { recordWithholdingFromEvent } from "./withholding-tax.js";
import { recordCommissionFromEvent } from "./commission.js";
import { recordPayrollFromEvent } from "./payroll.js";

// Registry of projection rules that run on every domain event.
//
// The journal-side projection lives in `../projection.ts` (which evaluates
// the rules in `../posting-rules.ts`). The handlers here own *non-journal*
// projections such as the IRPF withholding-tax record used by Modelo 111
// and OTA commission accruals (Sprint 22 / Track 4).
//
// Keep each handler:
//   - idempotent (so we can re-drive the event log without dup-inserts);
//   - non-throwing for irrelevant events (return early).
const HANDLERS: Array<(event: EventEnvelope) => Promise<void>> = [
  recordWithholdingFromEvent,
  recordCommissionFromEvent,
  recordPayrollFromEvent
];

let projectionChain: Promise<void> = Promise.resolve();

export function queueExtraProjections(event: EventEnvelope): void {
  projectionChain = projectionChain.then(async () => {
    for (const handler of HANDLERS) {
      try {
        await handler(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `[accounting/posting-rules] handler failed for ${event.eventId} (${event.eventType}): ${message}`
        );
      }
    }
  });
}

export async function flushExtraProjections(): Promise<void> {
  await projectionChain;
}

export { recordWithholdingFromEvent } from "./withholding-tax.js";
export { recordCommissionFromEvent } from "./commission.js";
export { recordPayrollFromEvent } from "./payroll.js";
