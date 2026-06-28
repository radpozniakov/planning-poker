import { test, expect } from "@playwright/test";

// Smoke test: the SPA loads, renders the hero, and shows both action panels.
// No WebSocket traffic needed — this just proves the FE dev server + routing work.
test.describe("Landing page", () => {
  test("renders hero and both room panels", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Plan together, pick faster." }),
    ).toBeVisible();

    await expect(
      page.getByRole("heading", { name: "Create a room" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Join a room" }),
    ).toBeVisible();
  });

  test("create button is disabled until a name is entered", async ({
    page,
  }) => {
    await page.goto("/");

    const createButton = page.getByRole("button", { name: "Create room" });
    await expect(createButton).toBeDisabled();

    // The Create panel's name input has the "e.g. Alex" placeholder (the Join panel
    // uses "e.g. Sam"), so it's unique without scoping to the form.
    await page.getByPlaceholder("e.g. Alex").fill("Alex");

    await expect(createButton).toBeEnabled();
  });
});
