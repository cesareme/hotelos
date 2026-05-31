import { Text } from "react-native";
import { CameraActionButton, HotelCard, StatusChip } from "@hotelos/ui";
import { CheckInFlowScaffold } from "./CheckInFlowScaffold";

export function DocumentScanScreen() {
  return (
    <CheckInFlowScaffold
      activeStep="scan"
      title="Temporary document scan"
      subtitle="The ID image is used only for OCR/MRZ extraction and is discarded before the flow continues."
      stateLabel="camera"
    >
      <HotelCard title="Privacy boundary" subtitle="Spain ID minimisation rule">
        <Text>Do not store DNI or passport images by default.</Text>
        <Text>Do not send raw identity document photos to a general LLM.</Text>
        <Text>Extract required fields, discard the image, then log deletion.</Text>
      </HotelCard>
      <HotelCard title="Capture action">
        <CameraActionButton label="Scan document for guest register" onPress={() => undefined} />
        <StatusChip label="imageStored: false" tone="success" />
        <StatusChip label="imageDiscarded: true" tone="success" />
      </HotelCard>
    </CheckInFlowScaffold>
  );
}
