import type { PermissionKey, RoleKey } from "./types.js";
export declare const PERMISSIONS: Record<PermissionKey, string>;
export declare const ROLE_PERMISSION_MAP: Record<RoleKey, PermissionKey[]>;
export declare function hasPermission(userPermissions: PermissionKey[], permission: PermissionKey): boolean;
export declare function missingPermissions(userPermissions: PermissionKey[], required: PermissionKey[]): PermissionKey[];
export declare function assertPermissions(userPermissions: PermissionKey[], required: PermissionKey[]): void;
