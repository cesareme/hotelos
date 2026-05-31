import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@hotelos/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
      "@hotelos/compliance": path.join(repoRoot, "packages/compliance/src/index.ts"),
      "@hotelos/ai-tools": path.join(repoRoot, "packages/ai-tools/src/index.ts"),
      "@hotelos/integrations": path.join(repoRoot, "packages/integrations/src/index.ts"),
      "@hotelos/onboarding": path.join(repoRoot, "packages/onboarding/src/index.ts"),
      "@hotelos/product": path.join(repoRoot, "packages/product/src/index.ts"),
      "@hotelos/revenue": path.join(repoRoot, "packages/revenue/src/index.ts"),
      "@hotelos/ui/timeline": path.join(repoRoot, "packages/ui/src/components/timeline/index.ts"),
      "@hotelos/ui/panels": path.join(repoRoot, "packages/ui/src/components/panels/index.ts"),
      "@hotelos/ui": path.join(repoRoot, "packages/ui/src/index.ts"),
      "@hotelos/config": path.join(repoRoot, "packages/config/src/index.ts")
    }
  },
  server: {
    host: "0.0.0.0",
    port: 5173
  },
  optimizeDeps: {
    exclude: [
      "@hotelos/shared",
      "@hotelos/compliance",
      "@hotelos/ai-tools",
      "@hotelos/integrations",
      "@hotelos/onboarding",
      "@hotelos/product",
      "@hotelos/revenue",
      "@hotelos/ui",
      "@hotelos/ui/timeline",
      "@hotelos/ui/panels",
      "@hotelos/config"
    ]
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("react/jsx-runtime") ||
              id.includes("/scheduler/")
            ) {
              return "vendor-react";
            }
            if (id.includes("@sentry")) return "vendor-sentry";
            if (
              id.includes("recharts") ||
              id.includes("victory") ||
              id.includes("/d3-")
            ) {
              return "vendor-charts";
            }
            if (
              id.includes("date-fns") ||
              id.includes("lodash") ||
              id.includes("/zod/")
            ) {
              return "vendor-utils";
            }
            return "vendor";
          }
          if (id.includes("/screens/revenue/")) return "screens-revenue";
          if (
            id.includes("/screens/compliance/") ||
            id.includes("/screens/complianceCenter/")
          ) {
            return "screens-compliance";
          }
          if (id.includes("/screens/aiOperations/")) return "screens-aiOps";
          if (id.includes("/screens/backoffice/")) return "screens-backoffice";
          if (
            id.includes("/screens/reservations/ReservationsListScreen") ||
            id.includes("/screens/reservations/ReservationCreateScreen") ||
            id.includes("/screens/reservations/ReservationWorkspaceScreen") ||
            id.includes("/screens/reservations/QuickActionsDialogs")
          ) {
            return "screens-operations-reservations";
          }
          if (
            id.match(
              /\/screens\/operations\/(GroupsEventsDashboard|GroupsCalendarScreen|NewGroupDialog|GroupDetailDialog|RoomBlockGridDialog|NewEventDialog|RoomingListImportDialog|GroupsPickupCard)\.tsx$/
            )
          ) {
            return "screens-operations-groups";
          }
          if (
            id.match(
              /\/screens\/operations\/(FrontDeskDashboard|RoomRackScreen|FrontDeskCopilotScreen)\.tsx$/
            )
          ) {
            return "screens-operations-front";
          }
          if (id.includes("/screens/operations/")) return "screens-operations-rest";
          if (
            id.includes("/screens/marketplace/") ||
            id.includes("/screens/developer/")
          ) {
            return "screens-marketplace";
          }
          return undefined;
        }
      }
    }
  }
});
