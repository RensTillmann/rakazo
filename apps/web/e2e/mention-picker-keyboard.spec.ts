import { expect, type Page, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  signup,
} from "./helpers";

async function createBot(page: Page, name: string) {
  return createNamedBot(page, name);
}

test("mention picker completes with Enter and Tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mention-keys-${stamp}@rakazo.test`, "password12", "Mention Keys");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");
  expect(researcherId).toBeTruthy();
  expect(writerId).toBeTruthy();

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Mention keys team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("checkbox", { name: "Add Researcher to the group" }).click();
  await panel.getByRole("checkbox", { name: "Add Research Writer to the group" }).click();
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: "Message Mention keys team" });
  await expect(composer).toBeVisible();

  await composer.fill("@Res");
  const picker = page.getByTestId("mention-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveAttribute("aria-expanded", "true");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-open");

  await composer.press("ArrowDown");
  await expect(picker.getByRole("option", { name: "@Research Writer" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await composer.press("Enter");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("@Research Writer ");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, testInfo, "mention-picker-keyboard-completed");

  await composer.fill("");
  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Tab");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("@Researcher ");
  await expect(composer).toBeFocused();

  await composer.fill("");
  await composer.fill("@Res");
  await expect(page.getByTestId("mention-picker")).toBeVisible();
  await composer.press("Escape");
  await expect(page.getByTestId("mention-picker")).toHaveCount(0);
  await expect(composer).toHaveValue("@Res");
  await expect(page.getByTestId("mention-chip")).toHaveCount(0);
  await expect(composer).toBeFocused();

  // Retain two picker-selected occurrences through a draft reload and send.
  await composer.fill("É🙂 Ask @Res");
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  await composer.fill(`${await composer.inputValue()}here; again @Res`);
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  const inline = "É🙂 Ask @Researcher here; again @Researcher ";
  await expect(composer).toHaveValue(inline);
  await page.reload();
  await expect(composer).toHaveValue(inline);
  const request = page.waitForRequest("**/rpc/threads/send");
  await composer.press("Enter");
  const sent = (await request).postDataJSON().json;
  expect(sent.text).toBe(inline.trimEnd());
  expect(sent.mentions).toEqual([{ kind: "bot", id: researcherId }]);
  await expect(page.getByTestId("transcript")).toContainText(inline.trimEnd());
  await page.reload();
  await expect(page.getByTestId("transcript")).toContainText(inline.trimEnd());

  await composer.fill("hello without a picker");
  await composer.press("Enter");
  await expect(page.getByTestId("transcript")).toContainText("hello without a picker", {
    timeout: 60_000,
  });
});
