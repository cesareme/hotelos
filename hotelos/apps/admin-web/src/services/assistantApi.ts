// Frontend client for the conversational AI Assistant.
import { apiRequest } from "./api-client";

export type AssistantToolCall = {
  name: string;
  ok: boolean;
  source: string;
  summary: string;
};

export type AssistantTurn = {
  question: string;
  answer: string;
  toolCalls: AssistantToolCall[];
  mode: "deterministic" | "llm";
  generatedAt: string;
  correlationId: string;
};

export type AssistantTool = {
  name: string;
  description: string;
  keywords: string[];
};

export function askAssistant(question: string): Promise<AssistantTurn> {
  return apiRequest<AssistantTurn>("/assistant/chat", { method: "POST", body: { question } });
}

export async function fetchAssistantTools(): Promise<AssistantTool[]> {
  const res = await apiRequest<{ items: AssistantTool[] }>("/assistant/tools");
  return res.items;
}
