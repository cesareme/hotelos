import { hotelOSTokens } from "./index.js";

export const hotelOSFlowTokens = {
  ...hotelOSTokens,
  product: {
    name: "HotelOS Flow Design System",
    principles: [
      "timeline-first",
      "ai-native-command",
      "guest-journey-visible",
      "marketplace-first",
      "setup-center-not-settings",
      "no-silent-module-hiding"
    ]
  },
  flowColor: {
    canvas: hotelOSTokens.color.surface.canvas,
    surface: hotelOSTokens.color.surface.raised,
    primary: hotelOSTokens.color.brand.deepIndigo,
    ai: hotelOSTokens.color.brand.violet,
    success: hotelOSTokens.color.semantic.success,
    warning: hotelOSTokens.color.semantic.warning,
    danger: hotelOSTokens.color.semantic.danger,
    action: "#e76f51"
  }
} as const;

export type HotelOSFlowTokens = typeof hotelOSFlowTokens;
