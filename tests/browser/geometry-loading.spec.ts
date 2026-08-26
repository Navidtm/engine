import { expect, test } from "@playwright/test";

interface GeometryExampleResult {
  readonly status: "ready" | "error";
  readonly successfulLoads: number;
  readonly retainedDecodedBytes: number;
  readonly message: string;
}

test("loads constrained GLB through worker decode and GPU residency", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const pending = (
      window as typeof window & {
        __LUME_GEOMETRY_EXAMPLE_RESULT__?: Promise<GeometryExampleResult>;
      }
    ).__LUME_GEOMETRY_EXAMPLE_RESULT__;
    if (pending === undefined) throw new Error("Geometry example result hook was not installed.");
    return pending;
  });

  expect(result, result.message).toMatchObject({
    status: "ready",
    successfulLoads: 1,
  });
  expect(result.retainedDecodedBytes, result.message).toBeGreaterThan(0);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready");
});
