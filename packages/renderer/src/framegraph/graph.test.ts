import { describe, expect, it } from "vitest";

import {
  addFramePass,
  addFrameResource,
  compileFrameGraph,
  createFrameGraph,
  executeFrameGraph,
} from "./graph.js";
import { defineFramePass } from "./pass.js";
import { createFrameResource } from "./resource.js";

describe("frame graph", () => {
  it("executes resource dependencies in declaration order", () => {
    const graph = createFrameGraph<string[]>();
    const uploaded = addFrameResource(graph, "uploaded-frame");
    addFramePass(
      graph,
      defineFramePass({
        name: "upload",
        writes: [uploaded],
        execute: (order) => order.push("upload"),
      }),
    );
    addFramePass(
      graph,
      defineFramePass({
        name: "main-render",
        reads: [uploaded],
        execute: (order) => order.push("main-render"),
      }),
    );

    const compiled = compileFrameGraph(graph);
    expect(graph.compiled).toBe(true);
    const order: string[] = [];
    executeFrameGraph(compiled, order);
    executeFrameGraph(compiled, order);

    expect(order).toEqual(["upload", "main-render", "upload", "main-render"]);
  });

  it("rejects unknown resources and dependency cycles", () => {
    const invalid = createFrameGraph<undefined>();
    const foreign = createFrameResource(0, "foreign");
    addFramePass(
      invalid,
      defineFramePass({
        name: "invalid",
        reads: [foreign],
        execute: () => undefined,
      }),
    );
    expect(() => compileFrameGraph(invalid)).toThrow("unregistered resource");
    expect(invalid.compiled).toBe(false);

    const cyclic = createFrameGraph<undefined>();
    addFramePass(
      cyclic,
      defineFramePass({
        name: "first",
        after: ["second"],
        execute: () => undefined,
      }),
    );
    addFramePass(
      cyclic,
      defineFramePass({
        name: "second",
        after: ["first"],
        execute: () => undefined,
      }),
    );
    expect(() => compileFrameGraph(cyclic)).toThrow("dependency cycle");
    expect(cyclic.compiled).toBe(false);
    expect(() => addFrameResource(cyclic, "retry-marker")).not.toThrow();
  });
});
