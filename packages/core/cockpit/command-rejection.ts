import { ApiError, errorCode } from "../api/client";

/** Authentication, timeouts and throttling cannot resolve an earlier lost response. */
export function isCockpitDefinitiveCommandRejection(error: unknown): boolean {
  return error instanceof ApiError && ([400, 409, 410, 422].includes(error.status)
    || (error.status === 403 && errorCode(error) === "private_storage_required"));
}
