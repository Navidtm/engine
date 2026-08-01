//! Data-oriented simulation core for Lume.
//!
//! Structural changes may allocate. Systems operating on an initialized world
//! do not allocate when configured capacities are respected.

#![forbid(unsafe_code)]

pub mod components;
pub mod ecs;
pub mod math;
pub mod memory;
pub mod render_world;
pub mod systems;
pub mod world;

pub use components::{Camera, Material, MeshRenderer, Transform};
pub use ecs::{Entity, EntityAllocator, SparseSet};
pub use render_world::{ExtractionError, ExtractionStats, GpuCamera, GpuInstance, RenderWorld};
pub use world::{World, WorldCapacity};
