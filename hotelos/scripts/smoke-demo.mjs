import { readFileSync } from "node:fs";

const checks = [
  {
    file: "apps/api/src/lib/demo-store.ts",
    patterns: ["RES-18392", "room_432", "guest_maria", "wo_108_leak"]
  },
  {
    file: "packages/database/prisma/seed.ts",
    patterns: ["RES-18392", "room_432", "guest_maria", "DEMO_SEED_READY", "idDocumentImagesStored: false"]
  },
  {
    file: "apps/api/src/modules/ai/check-in.command.ts",
    patterns: ["ID_IMAGE_DISCARDED", "confirmation_required", "queueSesHospedajesSubmission"]
  },
  {
    file: "apps/mobile/src/screens/AICommandCenterScreen.tsx",
    patterns: ["Check in this customer in room 432", "scanDocumentForGuestRegister", "Signature"]
  }
];

const missing = [];

for (const check of checks) {
  const text = readFileSync(check.file, "utf8");
  for (const pattern of check.patterns) {
    if (!text.includes(pattern)) {
      missing.push(`${check.file}: ${pattern}`);
    }
  }
}

if (missing.length > 0) {
  console.error("Demo smoke contract failed:");
  for (const item of missing) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log("Demo smoke contract ok: flagship check-in path is wired.");
