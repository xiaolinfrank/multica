/** The HTTP write completed but its response did not acknowledge the requested state. */
export class CockpitUnconfirmedWriteError extends Error {
  constructor() {
    super("cockpit_write_not_confirmed");
    this.name = "CockpitUnconfirmedWriteError";
  }
}
