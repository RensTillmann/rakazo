import { afterEach, describe, expect, it } from "vitest";
import { resetI18nForTests } from "./i18n";
import { secretDestinationLabel } from "./secret-destination";

const command = { name: "google-maps-test-key", origin: "", auth: { type: "command" } };

describe("mobile credential destination label", () => {
  afterEach(() => {
    resetI18nForTests("en");
  });

  it("says the bot's commands get a command key, under its variable name", () => {
    expect(secretDestinationLabel(command, "Josy")).toBe(
      "Saved encrypted for Josy's commands as $GOOGLE_MAPS_TEST_KEY; never shown in chat.",
    );
    expect(secretDestinationLabel(command, undefined)).toBe(
      "Saved encrypted for the bot's commands as $GOOGLE_MAPS_TEST_KEY; never shown in chat.",
    );
  });

  it("shows the site origin for every other credential type", () => {
    expect(
      secretDestinationLabel(
        { name: "example_api", origin: "https://api.example.test", auth: { type: "bearer" } },
        "Josy",
      ),
    ).toBe("https://api.example.test");
  });

  it("localizes the command line for the active locale, keeping the variable", () => {
    resetI18nForTests("zh-CN");
    const label = secretDestinationLabel({ ...command, name: "api-token" }, "Josy");
    expect(label).toContain("Josy");
    expect(label).toContain("$API_TOKEN");
    expect(label).not.toContain("Saved encrypted");
  });
});
