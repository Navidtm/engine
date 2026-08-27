import { expect, test } from "@playwright/test";

interface ShowcaseResult {
  readonly status: "ready" | "error";
  readonly encodedBytes: number;
  readonly retainedDecodedBytes: number;
  readonly visibilityBackend: "cpu" | "gpu";
  readonly message: string;
}

test("loads the heavy GLB and exercises GPU visibility in the showcase", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const pending = (
      window as typeof window & {
        __LUME_ASSET_SHOWCASE_RESULT__?: Promise<ShowcaseResult>;
      }
    ).__LUME_ASSET_SHOWCASE_RESULT__;
    if (pending === undefined) throw new Error("Asset showcase result hook was not installed.");
    return pending;
  });

  expect(result, result.message).toMatchObject({ status: "ready", visibilityBackend: "gpu" });
  expect(result.encodedBytes, result.message).toBeGreaterThan(4_000_000);
  expect(result.retainedDecodedBytes, result.message).toBeGreaterThan(4_000_000);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
