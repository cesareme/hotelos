export const hotelOSTokens = {
  color: {
    brand: {
      nightBlue: "#0b1026",
      deepIndigo: "#1d2a73",
      electricBlue: "#2563eb",
      violet: "#7c3aed"
    },
    surface: {
      canvas: "#f6f4ef",
      base: "#fffdf8",
      raised: "#ffffff",
      soft: "#eef2f7",
      aiGlass: "rgba(29, 42, 115, 0.86)",
      night: "#10172f"
    },
    text: {
      primary: "#111827",
      secondary: "#475467",
      muted: "#667085",
      inverse: "#ffffff"
    },
    semantic: {
      success: "#0f9f6e",
      warning: "#b7791f",
      danger: "#c2413a",
      info: "#2563eb"
    },
    status: {
      clean: "#dcfce7",
      dirty: "#fef3c7",
      inspected: "#dbeafe",
      occupied: "#ede9fe",
      blocked: "#fee2e2",
      ai: "#ede9fe"
    },
    border: {
      subtle: "#d9e0ea",
      strong: "#aab6ca"
    }
  },
  radius: {
    xs: 6,
    sm: 10,
    md: 14,
    lg: 18,
    xl: 24,
    pill: 999
  },
  space: {
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 20,
    xl: 24,
    xxl: 32
  },
  font: {
    size: {
      caption: 12,
      body: 15,
      bodyLarge: 17,
      title: 20,
      display: 34
    },
    weight: {
      regular: "400",
      semibold: "700",
      bold: "800",
      black: "900"
    }
  },
  motion: {
    fast: 120,
    normal: 220,
    slow: 360,
    emphasized: "cubic-bezier(0.2, 0.8, 0.2, 1)"
  },
  elevation: {
    card: {
      shadowColor: "#0f172a",
      shadowOpacity: 0.1,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 10 },
      elevation: 2
    },
    command: {
      shadowColor: "#2563eb",
      shadowOpacity: 0.22,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 14 },
      elevation: 4
    }
  },
  zIndex: {
    base: 1,
    dock: 20,
    sheet: 40,
    modal: 60,
    toast: 80
  },
  opacity: {
    disabled: 0.42,
    muted: 0.68,
    overlay: 0.72
  },
  breakpoints: {
    compact: 0,
    medium: 640,
    expanded: 900
  }
} as const;

export type HotelOSTokens = typeof hotelOSTokens;

export const auroraColors = hotelOSTokens.color;
export const auroraSpace = hotelOSTokens.space;
export const auroraRadius = hotelOSTokens.radius;
export const auroraMotion = hotelOSTokens.motion;
