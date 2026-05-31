export type RateRestrictions = {
  minLos?: number;
  maxLos?: number;
  cta?: boolean;  // closed to arrival
  ctd?: boolean;  // closed to departure
  closed?: boolean;
  stopSell?: boolean;
};

export type RateGridCell = {
  roomTypeId: string;
  date: string;  // YYYY-MM-DD
  channelId?: string;  // null = base BAR
  basePrice: number;
  effectivePrice: number;  // basePrice + markup si channelId
  restrictions: RateRestrictions;
  source: 'manual' | 'rms' | 'derived';
  lastModifiedAt?: string;
  lastModifiedBy?: string;
};

export type RateGridBulkUpdateRequest = {
  cells: Array<{
    roomTypeId: string;
    date: string;
    channelId?: string;
    price?: number;
    restrictions?: RateRestrictions;
  }>;
  reason?: string;
};

export type RateGridPushRequest = {
  from: string;
  to: string;
  channelIds: string[];
  roomTypeIds?: string[];
};

export type RateChangeJournalEntry = {
  id: string;
  propertyId: string;
  userId: string;
  userEmail: string | null;
  timestamp: string;
  changesCount: number;
  reason: string | null;
  pushedTo: string[];
  pushStatus: 'draft' | 'pushed' | 'failed';
};
