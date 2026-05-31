// Zod schemas for authentication endpoints.
//
// The runtime parse is performed via `parse()` from ../lib/validate.js, which
// throws a typed BadRequestError on failure. The schemas live here to make
// them re-usable across handlers and trivially testable in isolation.

import { z } from "zod";

export const LoginSchema = z.object({
  email: z.string().email("must be a valid email"),
  password: z.string().min(1, "required"),
  deviceId: z.string().min(1).optional()
});

export type LoginInput = z.infer<typeof LoginSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.string().email()
});

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(20),
  newPassword: z.string().min(8)
});

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

// PILOT-D1 — creación inicial de usuarios desde el wizard de onboarding.
export const CreateUserSchema = z.object({
  organizationId: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1).max(120),
  phone: z.string().max(40).optional(),
  propertyId: z.string().optional(),
  roleId: z.string().optional()
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
