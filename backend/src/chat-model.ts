import { ChatGroq } from "@langchain/groq";

export function createChatModel(apiKey: string, modelName: string) {
  return new ChatGroq({
    apiKey,
    model: modelName,
    temperature: 0,
    maxRetries: 0,
    timeout: 12000,
  });
}
