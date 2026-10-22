import { commandVariableName } from "@rakazo/contracts";
import { t } from "./i18n";

/**
 * The destination line a credential request card shows beneath its prompt. A command credential
 * has no site: it says the bot's shell commands receive it as an environment variable, by name.
 * Every other credential type shows its saved site.
 */
export function secretDestinationLabel(
  credential: { name: string; origin: string; auth: { type: string } },
  botName: string | undefined,
): string {
  if (credential.auth.type === "command") {
    return t("Saved encrypted for {bot}'s commands as {variable}; never shown in chat.", {
      bot: botName ?? t("the bot"),
      variable: `$${commandVariableName(credential.name)}`,
    });
  }
  return credential.origin;
}
