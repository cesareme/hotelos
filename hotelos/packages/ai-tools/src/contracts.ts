import type { ZodSchema } from "zod";
import type { PermissionKey, RiskLevel, ToolContext } from "@hotelos/shared";
import type { HotelModuleCode } from "@hotelos/product";

export type AiTool<Input, Output> = {
  name: string;
  moduleCode: HotelModuleCode;
  description: string;
  riskLevel: RiskLevel;
  requiredPermissions: PermissionKey[];
  inputSchema: ZodSchema<Input>;
  outputSchema: ZodSchema<Output>;
  requiresConfirmation: boolean;
  execute(input: Input, context: ToolContext): Promise<Output>;
};

export type ToolExecutionEnvelope<Input> = {
  toolName: string;
  input: Input;
  context: ToolContext;
};
