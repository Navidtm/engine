import { describe, expect, it } from "vitest";

import { writeFrustumPlanes } from "./frustum-planes.js";
import { VISIBILITY_SHADER } from "./shaders/visibility.wgsl.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

describe("frustum plane preparation", () => {
  it("extracts normalized WebGPU clip planes from view and projection", () => {
    const camera = new Float32Array(32);
    camera.set(IDENTITY, 0);
    camera.set(IDENTITY, 16);
    const output = new Float32Array(28);

    writeFrustumPlanes(output, 4, camera, new Float32Array(16));

    expect([...output.subarray(4)]).toEqual([
      1, 0, 0, 1, -1, 0, 0, 1, 0, 1, 0, 1, 0, -1, 0, 1, 0, 0, 1, 0, 0, 0, -1, 1,
    ]);
  });

  it("writes conservative zero planes when the camera is degenerate", () => {
    const output = new Float32Array(28).fill(7);

    writeFrustumPlanes(output, 4, new Float32Array(32), new Float32Array(16));

    expect([...output.subarray(0, 4)]).toEqual([7, 7, 7, 7]);
    expect([...output.subarray(4)]).toEqual(new Array<number>(24).fill(0));
  });

  it("makes candidate invocations consume prepared planes", () => {
    expect(VISIBILITY_SHADER).toContain("parameters.frustum_planes[0]");
    expect(VISIBILITY_SHADER).not.toContain("camera.projection * camera.view");
    expect(VISIBILITY_SHADER).not.toContain("inverseSqrt");
  });
});
