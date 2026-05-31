import type { ChatAttachmentDraft, DocumentExtractionResult, PhotoUploadDraft, VoiceNoteDraft, VoiceTranscript } from "@hotelos/shared";

export type NativeCapabilityBridge = {
  voice?: {
    startVoiceCommand(locale: string): Promise<void>;
    stopVoiceCommand(): Promise<VoiceTranscript>;
  };
  documentScanner?: {
    scanDocumentForGuestRegister(): Promise<DocumentExtractionResult & Record<string, unknown>>;
  };
  maintenanceCamera?: {
    captureMaintenancePhoto(): Promise<PhotoUploadDraft>;
  };
  chatMedia?: {
    pickChatPhoto(): Promise<ChatAttachmentDraft>;
    captureChatCameraPhoto(): Promise<ChatAttachmentDraft>;
    pickChatFile(): Promise<ChatAttachmentDraft>;
    startVoiceNote(locale: string): Promise<void>;
    stopVoiceNote(): Promise<VoiceNoteDraft>;
  };
};

export const nativeCapabilityPlan = {
  voice: {
    ios: "Apple Speech framework",
    android: "Android SpeechRecognizer"
  },
  guestDocumentScan: {
    ios: "VisionKit document camera with Vision text and data recognition",
    android: "Google ML Kit Text Recognition v2",
    retention: "Temporary scan only. Save extracted fields, discard image, log ID_IMAGE_DISCARDED."
  },
  maintenancePhoto: {
    ios: "Expo Camera or native camera module",
    android: "Expo Camera or native camera module",
    retention: "Maintenance photos may be uploaded after privacy review."
  },
  chatAttachments: {
    photoLibrary: "Expo ImagePicker or native photo picker",
    camera: "Expo Camera or native camera module for guest-message photos",
    filePicker: "Expo DocumentPicker or native document picker",
    voiceNotes: "Native microphone permission with audio recording, stored as object-storage media after send",
    retention: "Guest-message attachments are stored as message media. ID documents still use the temporary guest-register scan flow only."
  }
} as const;

let nativeBridge: NativeCapabilityBridge | undefined;

export function setNativeCapabilityBridge(bridge: NativeCapabilityBridge | undefined): void {
  nativeBridge = bridge;
}

export function assertGuestDocumentImageDiscarded(
  result: DocumentExtractionResult & Record<string, unknown>
): DocumentExtractionResult {
  if (result.imageStored !== false || result.imageDiscarded !== true) {
    throw new Error("Guest document scans must discard the source image before returning extracted fields.");
  }

  if ("imageUri" in result || "localUri" in result || "objectKey" in result || "documentObjectKey" in result) {
    throw new Error("Guest document scan results must not expose stored image references.");
  }

  return {
    fields: result.fields,
    confidence: result.confidence,
    imageStored: false,
    imageDiscarded: true
  };
}

export async function startVoiceCommand(locale: string): Promise<void> {
  if (nativeBridge?.voice) {
    await nativeBridge.voice.startVoiceCommand(locale);
  }
}

export async function stopVoiceCommand(): Promise<VoiceTranscript> {
  if (nativeBridge?.voice) {
    return nativeBridge.voice.stopVoiceCommand();
  }

  return {
    transcript: "Check in this customer in room 432",
    confidence: 0.93,
    locale: "en-GB",
    durationMs: 2100
  };
}

export async function scanDocumentForGuestRegister(): Promise<DocumentExtractionResult> {
  if (nativeBridge?.documentScanner) {
    return assertGuestDocumentImageDiscarded(await nativeBridge.documentScanner.scanDocumentForGuestRegister());
  }

  return assertGuestDocumentImageDiscarded({
    fields: {
      firstName: "Maria",
      surname1: "Lopez",
      surname2: "Garcia",
      documentType: "DNI",
      documentNumber: "12345678X",
      nationality: "ES",
      dateOfBirth: "1986-04-18"
    },
    confidence: {
      firstName: 0.98,
      surname1: 0.97,
      surname2: 0.96,
      documentNumber: 0.98,
      dateOfBirth: 0.94
    },
    imageStored: false,
    imageDiscarded: true
  });
}

export async function captureMaintenancePhoto(): Promise<PhotoUploadDraft> {
  if (nativeBridge?.maintenanceCamera) {
    const draft = await nativeBridge.maintenanceCamera.captureMaintenancePhoto();
    return { ...draft, privacyReviewRequired: true };
  }

  return {
    localUri: "file:///local/maintenance-photo.jpg",
    mediaType: "image",
    privacyReviewRequired: true
  };
}

export async function pickChatPhotoAttachment(): Promise<ChatAttachmentDraft> {
  if (nativeBridge?.chatMedia) {
    const draft = await nativeBridge.chatMedia.pickChatPhoto();
    return { ...draft, attachmentType: "photo", privacyReviewRequired: true };
  }

  return {
    attachmentType: "photo",
    localUri: "file:///local/chat-photo.jpg",
    objectKey: "chat/conv_maria/photo-demo.jpg",
    fileName: "photo-demo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 842000,
    width: 1600,
    height: 1200,
    privacyReviewRequired: true
  };
}

export async function captureChatCameraPhoto(): Promise<ChatAttachmentDraft> {
  if (nativeBridge?.chatMedia) {
    const draft = await nativeBridge.chatMedia.captureChatCameraPhoto();
    return { ...draft, attachmentType: "camera_photo", privacyReviewRequired: true };
  }

  return {
    attachmentType: "camera_photo",
    localUri: "file:///local/chat-camera-photo.jpg",
    objectKey: "chat/conv_maria/camera-demo.jpg",
    fileName: "camera-demo.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 915000,
    width: 1600,
    height: 1200,
    privacyReviewRequired: true
  };
}

export async function pickChatFileAttachment(): Promise<ChatAttachmentDraft> {
  if (nativeBridge?.chatMedia) {
    const draft = await nativeBridge.chatMedia.pickChatFile();
    return { ...draft, attachmentType: "file" };
  }

  return {
    attachmentType: "file",
    localUri: "file:///local/parking-instructions.pdf",
    objectKey: "chat/conv_maria/parking-instructions.pdf",
    fileName: "parking-instructions.pdf",
    mimeType: "application/pdf",
    sizeBytes: 128000,
    privacyReviewRequired: false
  };
}

export async function startVoiceNote(locale: string): Promise<void> {
  if (nativeBridge?.chatMedia) {
    await nativeBridge.chatMedia.startVoiceNote(locale);
  }
}

export async function stopVoiceNote(): Promise<VoiceNoteDraft> {
  if (nativeBridge?.chatMedia) {
    const draft = await nativeBridge.chatMedia.stopVoiceNote();
    return { ...draft, attachmentType: "voice_note" };
  }

  return {
    attachmentType: "voice_note",
    localUri: "file:///local/voice-note.m4a",
    objectKey: "chat/conv_maria/voice-note-demo.m4a",
    fileName: "voice-note-demo.m4a",
    mimeType: "audio/m4a",
    sizeBytes: 94000,
    durationMs: 12000,
    privacyReviewRequired: false
  };
}
