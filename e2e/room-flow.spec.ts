import { test, expect, type Page } from "@playwright/test";

/**
 * Full real-time flow over the live WebSocket stack:
 *   host creates a room  ->  guest joins via the code  ->  both vote  ->
 *   host reveals  ->  stats appear for everyone.
 *
 * Two isolated browser contexts model two distinct clients (separate localStorage,
 * so sessions don't collide). This is the test that actually exercises the BE.
 */

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto("/");
  // "e.g. Alex" is the Create panel's placeholder (Join uses "e.g. Sam"), so unique.
  await page.getByPlaceholder("e.g. Alex").fill(name);
  await page.getByRole("button", { name: "Create room" }).click();

  // After creation we navigate to /:roomCode; the code is shown in the room header.
  await expect(page).toHaveURL(/\/[A-Z0-9]{6}$/);
  const code = page.url().split("/").pop();
  if (!code) throw new Error("room code not found in URL");
  return code;
}

test("two participants vote and the host reveals", async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  // 1. Host creates a room and is dropped straight into it.
  const code = await createRoom(host, "Alex");
  await expect(host.getByText(code)).toBeVisible();
  // Host sees the voting deck (proves the join ack + room state arrived over WS).
  await expect(host.getByRole("button", { name: "Pick 5" })).toBeVisible();

  // 2. Guest navigates to the room URL, hits the name gate, and joins.
  await guest.goto(`/${code}`);
  await guest.getByPlaceholder("e.g. Jordan").fill("Sam");
  await guest.getByRole("button", { name: "Join", exact: true }).click();
  await expect(guest.getByRole("button", { name: "Pick 8" })).toBeVisible();

  // 3. Host should now see 2 participants via the presence broadcast.
  await expect(host.getByText("0/2 voted")).toBeVisible();

  // 4. Both cast votes; the "voted" counter updates for the host.
  await host.getByRole("button", { name: "Pick 5" }).click();
  await guest.getByRole("button", { name: "Pick 8" }).click();
  await expect(host.getByText("2/2 voted")).toBeVisible();

  // 5. Host reveals; the reveal broadcast flips both clients into revealed state.
  await host.getByRole("button", { name: "Reveal" }).click();
  await expect(host.getByText("Votes revealed")).toBeVisible();
  await expect(guest.getByText("Votes revealed")).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});
