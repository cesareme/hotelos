import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Camera, FileText, Image as ImageIcon, MessageCircle, Mic, Paperclip, Send, Sparkles } from "lucide-react-native";
import type { ChatAttachmentDraft } from "@hotelos/shared";
import { getConciergeSnapshot, sendConciergeMessage, type MobileConversation, type MobileMessage } from "../services/api";
import {
  captureChatCameraPhoto,
  pickChatFileAttachment,
  pickChatPhotoAttachment,
  startVoiceNote,
  stopVoiceNote
} from "../services/nativeCapabilities";
import { colors } from "../theme/colors";

type AiDraft = {
  disclosure: string;
  draft: string;
  requiresHumanReview: boolean;
};

export function ConciergeScreen() {
  const [conversations, setConversations] = useState<MobileConversation[]>([]);
  const [messages, setMessages] = useState<MobileMessage[]>([]);
  const [aiDraft, setAiDraft] = useState<AiDraft | null>(null);
  const [draftText, setDraftText] = useState("Parking is available. I can add it to your reservation.");
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachmentDraft[]>([]);
  const [composerStatus, setComposerStatus] = useState("Ready to send.");

  useEffect(() => {
    void getConciergeSnapshot().then((snapshot) => {
      setConversations(snapshot.conversations);
      setMessages(snapshot.messages);
      setAiDraft(snapshot.aiDraft);
    });
  }, []);

  const activeConversationId = conversations[0]?.id ?? "conv_maria";

  async function addAttachment(loader: () => Promise<ChatAttachmentDraft>, status: string) {
    const attachment = await loader();
    setPendingAttachments((current) => [...current, attachment]);
    setComposerStatus(status);
  }

  async function addVoiceNote() {
    await startVoiceNote("en-GB");
    const voiceNote = await stopVoiceNote();
    setPendingAttachments((current) => [...current, voiceNote]);
    setComposerStatus("Voice note attached.");
  }

  async function sendMessage() {
    if (!draftText.trim() && pendingAttachments.length === 0) {
      setComposerStatus("Add text, a photo, a file, or a voice note before sending.");
      return;
    }

    const message = await sendConciergeMessage(activeConversationId, {
      body: draftText.trim(),
      attachments: pendingAttachments
    });

    setMessages((current) => [...current, message]);
    setDraftText("");
    setPendingAttachments([]);
    setComposerStatus("Sent to the guest conversation.");
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.kicker}>Concierge</Text>
          <Text style={styles.title}>Inbox</Text>
        </View>
        <MessageCircle color={colors.primary} size={28} />
      </View>

      <View style={styles.summary}>
        <Sparkles color={colors.primary} size={22} />
        <View style={styles.summaryText}>
          <Text style={styles.summaryTitle}>AI reply draft</Text>
          <Text style={styles.summaryMeta}>{aiDraft?.draft ?? "Preparing draft."}</Text>
        </View>
      </View>

      <Text style={styles.sectionTitle}>Conversations</Text>
      {conversations.map((conversation) => (
        <View key={conversation.id} style={styles.row}>
          <Text style={styles.rowTitle}>{conversation.channel}</Text>
          <Text style={styles.rowMeta}>
            {conversation.status} - AI {conversation.aiEnabled ? "enabled" : "off"}
          </Text>
        </View>
      ))}

      <Text style={styles.sectionTitle}>Latest messages</Text>
      {messages.map((message) => (
        <View key={message.id} style={styles.messageRow}>
          <Text style={styles.rowTitle}>{message.senderType}</Text>
          <Text style={styles.rowMeta}>{message.body}</Text>
          {!!message.attachments?.length && (
            <View style={styles.attachmentList}>
              {message.attachments.map((attachment) => (
                <Text key={attachment.id} style={styles.attachmentText}>
                  {attachment.attachmentType} - {attachment.fileName ?? attachment.mimeType}
                </Text>
              ))}
            </View>
          )}
        </View>
      ))}

      <View style={styles.composer}>
        <Text style={styles.sectionTitle}>Reply</Text>
        <TextInput
          value={draftText}
          onChangeText={setDraftText}
          multiline
          placeholder="Write a reply"
          placeholderTextColor={colors.muted}
          style={styles.input}
        />
        {!!pendingAttachments.length && (
          <View style={styles.attachmentTray}>
            {pendingAttachments.map((attachment, index) => (
              <View key={`${attachment.objectKey}-${index}`} style={styles.attachmentChip}>
                <Paperclip color={colors.primary} size={15} />
                <Text style={styles.attachmentChipText}>
                  {attachment.attachmentType} {attachment.fileName ? `- ${attachment.fileName}` : ""}
                </Text>
              </View>
            ))}
          </View>
        )}
        <View style={styles.toolGrid}>
          <Pressable
            onPress={() => addAttachment(pickChatPhotoAttachment, "Photo attached.")}
            style={styles.toolButton}
            accessibilityLabel="Attach photo"
          >
            <ImageIcon color={colors.primary} size={18} />
            <Text style={styles.toolLabel}>Photo</Text>
          </Pressable>
          <Pressable
            onPress={() => addAttachment(captureChatCameraPhoto, "Camera photo attached.")}
            style={styles.toolButton}
            accessibilityLabel="Use camera"
          >
            <Camera color={colors.primary} size={18} />
            <Text style={styles.toolLabel}>Camera</Text>
          </Pressable>
          <Pressable
            onPress={() => addAttachment(pickChatFileAttachment, "File attached.")}
            style={styles.toolButton}
            accessibilityLabel="Attach file"
          >
            <FileText color={colors.primary} size={18} />
            <Text style={styles.toolLabel}>File</Text>
          </Pressable>
          <Pressable onPress={addVoiceNote} style={styles.toolButton} accessibilityLabel="Record voice note">
            <Mic color={colors.primary} size={18} />
            <Text style={styles.toolLabel}>Voice note</Text>
          </Pressable>
          <Pressable onPress={sendMessage} style={[styles.toolButton, styles.sendButton]} accessibilityLabel="Send message">
            <Send color="#ffffff" size={18} />
            <Text style={[styles.toolLabel, styles.sendLabel]}>Send</Text>
          </Pressable>
        </View>
        <Text style={styles.composerStatus}>{composerStatus}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    gap: 14
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center"
  },
  kicker: {
    color: colors.muted,
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 0
  },
  title: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: "800",
    letterSpacing: 0
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0
  },
  summary: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#eef7f4",
    borderWidth: 1,
    borderColor: "#b7d8d1",
    borderRadius: 8,
    padding: 14
  },
  summaryText: {
    flex: 1,
    gap: 4
  },
  summaryTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0
  },
  summaryMeta: {
    color: colors.muted,
    lineHeight: 20,
    letterSpacing: 0
  },
  row: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 12,
    paddingHorizontal: 2
  },
  rowTitle: {
    color: colors.ink,
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0
  },
  rowMeta: {
    color: colors.muted,
    marginTop: 4,
    lineHeight: 20,
    letterSpacing: 0
  },
  messageRow: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 12
  },
  attachmentList: {
    gap: 6,
    marginTop: 10
  },
  attachmentText: {
    color: colors.primary,
    fontWeight: "800",
    letterSpacing: 0
  },
  composer: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 14,
    gap: 12
  },
  input: {
    minHeight: 86,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 12,
    color: colors.ink,
    textAlignVertical: "top",
    letterSpacing: 0
  },
  toolGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9
  },
  toolButton: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: colors.surface
  },
  toolLabel: {
    color: colors.ink,
    fontWeight: "800",
    letterSpacing: 0
  },
  sendButton: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  sendLabel: {
    color: "#ffffff"
  },
  attachmentTray: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  attachmentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "#b7d8d1",
    backgroundColor: "#eef7f4",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  attachmentChipText: {
    color: colors.primary,
    fontWeight: "800",
    letterSpacing: 0
  },
  composerStatus: {
    color: colors.muted,
    fontWeight: "700",
    letterSpacing: 0
  }
});
