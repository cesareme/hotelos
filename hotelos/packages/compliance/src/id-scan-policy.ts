import type { CheckInFromScanRequest } from "@hotelos/shared";

export type IdScanPolicyResult = {
  allowed: boolean;
  errors: string[];
  auditAction?: "ID_IMAGE_DISCARDED";
};

export function enforceSpanishIdScanPolicy(request: CheckInFromScanRequest): IdScanPolicyResult {
  const errors: string[] = [];

  if (request.documentImageStored !== false) {
    errors.push("ID document images must not be stored for hospedaje compliance.");
  }

  if (request.idImageDiscarded !== true) {
    errors.push("The original ID image must be discarded and the deletion event logged.");
  }

  if (errors.length > 0) {
    return { allowed: false, errors };
  }

  return {
    allowed: true,
    errors: [],
    auditAction: "ID_IMAGE_DISCARDED"
  };
}

