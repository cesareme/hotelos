import { prisma } from "@hotelos/database";

export type ConciergeDashboard = {
  kpis: {
    openConversations: number;
    messagesLast24h: number;
    avgResponseMinutes: number;
    aiResolutionRatePct: number;
    sentimentAggregate: { positive: number; neutral: number; negative: number };
  };
  conversationsByChannel: Array<{ channel: string; count: number }>;
  recentConversations: Array<{
    id: string;
    guestId?: string;
    channel: string;
    status: string;
    aiEnabled: boolean;
    lastMessageAt?: string;
    messageCount: number;
  }>;
  topGuestRequests: Array<{ category: string; count: number }>;
};

type ConversationRow = {
  id: string;
  propertyId: string;
  guestId: string | null;
  channel: string;
  status: string;
  aiEnabled: boolean;
  createdAt: Date;
};

type MessageRow = {
  id: string;
  conversationId: string;
  senderType: string;
  sentAt: Date;
  metadataJson: unknown;
};

const SAFE_EMPTY: ConciergeDashboard = {
  kpis: {
    openConversations: 0,
    messagesLast24h: 0,
    avgResponseMinutes: 0,
    aiResolutionRatePct: 0,
    sentimentAggregate: { positive: 0, neutral: 0, negative: 0 }
  },
  conversationsByChannel: [],
  recentConversations: [],
  topGuestRequests: []
};

function pickSentiment(metadataJson: unknown): "positive" | "neutral" | "negative" | null {
  if (!metadataJson || typeof metadataJson !== "object") return null;
  const raw = (metadataJson as { sentiment?: unknown }).sentiment;
  if (raw === "positive" || raw === "neutral" || raw === "negative") {
    return raw;
  }
  return null;
}

function pickCategory(metadataJson: unknown): string | null {
  if (!metadataJson || typeof metadataJson !== "object") return null;
  const raw = (metadataJson as { category?: unknown }).category;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return null;
}

export async function buildConciergeDashboard(input: { propertyId: string; days?: number }): Promise<ConciergeDashboard> {
  const propertyId = input.propertyId;
  if (!propertyId) {
    return SAFE_EMPTY;
  }

  const days = input.days && input.days > 0 ? input.days : 7;
  const now = Date.now();
  const windowStart = now - days * 24 * 60 * 60 * 1000;
  const last24hStart = now - 24 * 60 * 60 * 1000;

  const conversations: ConversationRow[] = await prisma.conversation.findMany({
    where: { propertyId },
    select: {
      id: true,
      propertyId: true,
      guestId: true,
      channel: true,
      status: true,
      aiEnabled: true,
      createdAt: true
    }
  });

  if (conversations.length === 0) {
    return SAFE_EMPTY;
  }

  const conversationIds = conversations.map((conversation) => conversation.id);
  const messages: MessageRow[] = await prisma.message.findMany({
    where: { conversationId: { in: conversationIds } },
    select: {
      id: true,
      conversationId: true,
      senderType: true,
      sentAt: true,
      metadataJson: true
    }
  });

  const messagesInWindow = messages.filter((message) => message.sentAt.getTime() >= windowStart);

  // KPI: open conversations
  const openConversations = conversations.filter((conversation) => conversation.status === "open").length;

  // KPI: messages in last 24h
  const messagesLast24h = messages.filter((message) => message.sentAt.getTime() >= last24hStart).length;

  // KPI: avg response time — for each guest message in window, find next staff/ai reply in same conversation.
  const messagesByConversation = new Map<string, MessageRow[]>();
  for (const message of messages) {
    const bucket = messagesByConversation.get(message.conversationId) ?? [];
    bucket.push(message);
    messagesByConversation.set(message.conversationId, bucket);
  }
  for (const bucket of messagesByConversation.values()) {
    bucket.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  }

  let totalResponseMs = 0;
  let responsePairs = 0;
  for (const bucket of messagesByConversation.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      const message = bucket[i];
      if (message.senderType !== "guest") continue;
      if (message.sentAt.getTime() < windowStart) continue;
      for (let j = i + 1; j < bucket.length; j += 1) {
        const reply = bucket[j];
        if (reply.senderType === "staff" || reply.senderType === "ai") {
          totalResponseMs += reply.sentAt.getTime() - message.sentAt.getTime();
          responsePairs += 1;
          break;
        }
      }
    }
  }
  const avgResponseMinutes = responsePairs > 0 ? Math.round(totalResponseMs / responsePairs / 60000) : 0;

  // KPI: AI resolution rate — conversations within window with at least one AI message and no staff message.
  const conversationsInWindow = conversations.filter((conversation) => {
    const bucket = messagesByConversation.get(conversation.id);
    if (!bucket || bucket.length === 0) return conversation.createdAt.getTime() >= windowStart;
    return bucket.some((message) => message.sentAt.getTime() >= windowStart);
  });
  const aiResolvedCount = conversationsInWindow.filter((conversation) => {
    const bucket = messagesByConversation.get(conversation.id) ?? [];
    const hasAi = bucket.some((message) => message.senderType === "ai");
    const hasStaff = bucket.some((message) => message.senderType === "staff");
    return hasAi && !hasStaff;
  }).length;
  const aiResolutionRatePct =
    conversationsInWindow.length > 0 ? Math.round((aiResolvedCount / conversationsInWindow.length) * 100) : 0;

  // KPI: sentiment aggregate — read Message.metadataJson.sentiment if present.
  let positive = 0;
  let neutral = 0;
  let negative = 0;
  for (const message of messagesInWindow) {
    const sentiment = pickSentiment(message.metadataJson);
    if (sentiment === "positive") positive += 1;
    else if (sentiment === "neutral") neutral += 1;
    else if (sentiment === "negative") negative += 1;
  }
  const sentimentTotal = positive + neutral + negative;
  const sentimentAggregate =
    sentimentTotal > 0
      ? {
          positive: Math.round((positive / sentimentTotal) * 100),
          neutral: Math.round((neutral / sentimentTotal) * 100),
          negative: Math.round((negative / sentimentTotal) * 100)
        }
      : { positive: 0, neutral: 0, negative: 0 };

  // Conversations by channel.
  const channelCounts = new Map<string, number>();
  for (const conversation of conversations) {
    channelCounts.set(conversation.channel, (channelCounts.get(conversation.channel) ?? 0) + 1);
  }
  const conversationsByChannel = Array.from(channelCounts.entries())
    .map(([channel, count]) => ({ channel, count }))
    .sort((a, b) => b.count - a.count);

  // Recent conversations — sort by last message timestamp desc, top 10.
  const recentConversations = conversations
    .map((conversation) => {
      const bucket = messagesByConversation.get(conversation.id) ?? [];
      const lastMessage = bucket[bucket.length - 1];
      return {
        id: conversation.id,
        guestId: conversation.guestId ?? undefined,
        channel: conversation.channel,
        status: conversation.status,
        aiEnabled: conversation.aiEnabled,
        lastMessageAt: lastMessage?.sentAt.toISOString(),
        messageCount: bucket.length
      };
    })
    .sort((a, b) => {
      const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return bt - at;
    })
    .slice(0, 10);

  // Top guest requests — by metadataJson.category on guest messages in window.
  const categoryCounts = new Map<string, number>();
  for (const message of messagesInWindow) {
    if (message.senderType !== "guest") continue;
    const category = pickCategory(message.metadataJson);
    if (!category) continue;
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const topGuestRequests = Array.from(categoryCounts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    kpis: {
      openConversations,
      messagesLast24h,
      avgResponseMinutes,
      aiResolutionRatePct,
      sentimentAggregate
    },
    conversationsByChannel,
    recentConversations,
    topGuestRequests
  };
}
