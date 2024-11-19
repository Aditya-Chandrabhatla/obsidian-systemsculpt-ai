import { TFile } from "obsidian";
import { ChatMessage } from "../ChatMessage";
import { Notice } from "obsidian";

export async function sendMessage(
  inputEl: HTMLTextAreaElement,
  addMessage: (message: ChatMessage) => void,
  createChatFile: (messageText: string) => Promise<TFile>,
  updateChatFile: (content: string) => Promise<void>,
  updateTokenCount: () => Promise<void>,
  chatFile: TFile | null,
  brainModule: any,
  chatModule: any,
  constructMessageHistory: () => Promise<
    {
      role: string;
      content:
        | string
        | { type: string; text?: string; image_url?: { url: string } }[];
    }[]
  >,
  appendToLastMessage: (content: string) => void,
  showLoading: () => void,
  hideLoading: () => void
) {
  const messageText = inputEl.value.trim();
  if (messageText === "") return;

  const modelId = brainModule.settings.defaultModelId;
  const messageHistory = await constructMessageHistory();

  if (
    modelId.includes("haiku") &&
    messageHistory.some(
      (msg) =>
        Array.isArray(msg.content) &&
        msg.content.some((c) => c.type === "image_url")
    )
  ) {
    new Notice(
      "Claude 3.5 Haiku does not support image analysis. Please use Claude 3.5 Sonnet or Claude 3 Opus for image-related tasks.",
      15000
    );
    return;
  }

  const userMessage = new ChatMessage("user", messageText);
  addMessage(userMessage);
  inputEl.value = "";

  if (!chatFile) {
    chatFile = await createChatFile(messageText);
  } else {
    await updateChatFile(`\`\`\`\`\`user\n${messageText}\n\`\`\`\`\`\n\n`);
  }

  const aiService = brainModule.AIService;
  const maxOutputTokens = brainModule.getMaxOutputTokens();

  const systemPrompt = chatModule.settings.systemPrompt;

  const processPDFContent = async (msg: {
    role: string;
    content:
      | string
      | { type: string; text?: string; image_url?: { url: string } }[];
  }) => {
    if (
      msg.role === "user" &&
      typeof msg.content === "string" &&
      msg.content.includes("CONTEXT FILES:")
    ) {
      const lines = msg.content.split("\n");
      const processedLines = await Promise.all(
        lines.map(async (line) => {
          if (line.startsWith("### ") && line.endsWith(".pdf")) {
            const pdfFileName = line.slice(4, -4);
            const extractedFolder = `${chatModule.settings.attachmentsPath}/${pdfFileName}`;
            const extractedMarkdownFile = app.vault.getAbstractFileByPath(
              `${extractedFolder}/extracted_content.md`
            );
            if (extractedMarkdownFile instanceof TFile) {
              const content = await app.vault.read(extractedMarkdownFile);
              return `### ${pdfFileName} (Extracted Content)\n${content}`;
            }
          }
          return line;
        })
      );
      return { ...msg, content: processedLines.join("\n") };
    }
    return msg;
  };

  const updatedMessageHistory = await Promise.all(
    messageHistory.map(processPDFContent)
  );

  showLoading();

  updatedMessageHistory.forEach((msg) => {
    if (msg.role.startsWith("ai-")) {
      msg.role = "assistant";
    }
  });

  const modelInfo = await brainModule.getModelById(modelId);
  const modelName = modelInfo ? modelInfo.name : modelId;

  try {
    let accumulatedResponse = "";
    await aiService.createStreamingConversationWithCallback(
      systemPrompt,
      updatedMessageHistory,
      modelId,
      maxOutputTokens,
      async (chunk: string) => {
        accumulatedResponse += chunk;
        appendToLastMessage(chunk);
      }
    );

    await updateChatFile(
      `\`\`\`\`\`ai-${modelName}\n${accumulatedResponse}\n\`\`\`\`\`\n\n`
    );
  } finally {
    hideLoading();
  }

  await updateTokenCount();
}
