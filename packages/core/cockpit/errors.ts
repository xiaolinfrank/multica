/** The HTTP write completed but its response did not acknowledge the requested state. */
export class CockpitUnconfirmedWriteError extends Error {
  constructor() {
    super("cockpit_write_not_confirmed");
    this.name = "CockpitUnconfirmedWriteError";
  }
}

/** A successful HTTP response failed its resource or scope validation. */
export class CockpitUnconfirmedReadError extends Error {
  constructor() {
    super("cockpit_read_not_confirmed");
    this.name = "CockpitUnconfirmedReadError";
  }
}

export function requireCockpitReadResult<T>(value: T | null | undefined): T {
  if (value == null) throw new CockpitUnconfirmedReadError();
  return value;
}
