import { describe, expect, it, vi } from "vitest";

import {
  createQuaternionControl,
  createVector3Control,
  mutableTransform,
} from "./transform-controls.js";

describe("transform controls", () => {
  it("owns copies of authoring tuples", () => {
    const position: [number, number, number] = [1, 2, 3];
    const value = mutableTransform({ position });
    position[0] = 9;

    expect(value.position).toEqual([1, 2, 3]);
    expect(value.rotation).toEqual([0, 0, 0, 1]);
    expect(value.scale).toEqual([1, 1, 1]);
  });

  it("commits vector storage only after publishing succeeds", () => {
    const value: [number, number, number] = [0, 0, 0];
    const publish = vi.fn((next: [number, number, number]) => {
      expect(next).toEqual([1, 2, 3]);
      expect(value).toEqual([0, 0, 0]);
    });
    const control = createVector3Control(value, publish);

    control.set(1, 2, 3);

    expect([control.x, control.y, control.z]).toEqual([1, 2, 3]);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("preserves vector and quaternion mirrors when publication fails", () => {
    const position: [number, number, number] = [1, 2, 3];
    const rotation: [number, number, number, number] = [0, 0, 0, 1];
    const failure = () => {
      throw new Error("publish failed");
    };
    const vector = createVector3Control(position, failure);
    const quaternion = createQuaternionControl(rotation, failure);

    expect(() => vector.set(4, 5, 6)).toThrow("publish failed");
    expect(() => quaternion.set(0, 1, 0, 0)).toThrow("publish failed");
    expect(position).toEqual([1, 2, 3]);
    expect(rotation).toEqual([0, 0, 0, 1]);
  });

  it("does not mutate or publish an invalid quaternion update", () => {
    const value: [number, number, number, number] = [0, 0, 0, 1];
    const publish = vi.fn();
    const control = createQuaternionControl(value, publish);

    expect(() => control.set(0, Number.NaN, 0, 1)).toThrow("quaternion");
    expect(() => control.set(0, 0, 0, 0)).toThrow("non-zero");
    expect(value).toEqual([0, 0, 0, 1]);
    expect(publish).not.toHaveBeenCalled();
  });
});
