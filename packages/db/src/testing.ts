/** Shared test fixtures. Never imported by production code. */
import { caseCoordinationFromEnv } from "./case-coordinators.js";

/** No coordinators configured: to-do checks go to the bot that asked; recovery names nobody. */
export const noCoordinators = caseCoordinationFromEnv({});
