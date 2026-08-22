//! Data-oriented simulation core for Lume.
//!
//! Structural changes may allocate. Systems operating on an initialized world
//! do not allocate when configured capacities are respected.

#![forbid(unsafe_code)]

pub mod components;
pub mod ecs;
pub mod material;
pub mod math;
pub mod memory;
pub mod render_world;
pub mod resource;
pub mod systems;
pub mod visibility;
pub mod world;

pub use components::{Bounds, Camera, MeshRenderer, Transform};
pub use ecs::{Entity, EntityAllocator, SparseSet, SparseSetInsertError};
pub use material::{BASIC_PIPELINE_ID, BasicMaterial, MaterialRegistry, PipelineId};
pub use resource::{GeometryHandle, MaterialHandle};
pub type Material = BasicMaterial;
pub use render_world::{
    ExtractionError, ExtractionStats, GpuBounds, GpuCamera, GpuInstance, RenderWorld,
};
pub use visibility::{Frustum, VisibilityError, VisibilityStats, VisibleRenderBuffer};
pub use world::{World, WorldCapacity};
