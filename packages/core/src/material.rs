use crate::ecs::{Entity, SparseSet, SparseSetInsertError};
use crate::math::Color;

/// Reserved renderer pipeline for unlit vertex-color/basic materials.
pub const BASIC_PIPELINE_ID: PipelineId = PipelineId::from_raw(1);

/// Compact, renderer-defined identifier for a material pipeline.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct PipelineId(u32);

impl PipelineId {
    /// Wraps a pipeline identifier supplied by the renderer.
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Returns the numeric identifier used in render extraction.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }
}

/// Stable entity-backed handle used to look up a material.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct MaterialHandle(u32);

impl MaterialHandle {
    /// Wraps the packed entity representation used for a material.
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Creates a handle for `entity`, preserving its generation.
    #[must_use]
    pub const fn from_entity(entity: Entity) -> Self {
        Self(entity.raw())
    }

    /// Returns the packed representation shared with transport code.
    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// Returns the entity identity represented by this handle.
    #[must_use]
    pub const fn entity(self) -> Entity {
        Entity::from_raw(self.0)
    }
}

/// Data required by the engine's basic material pipeline.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct BasicMaterial {
    /// Linear RGBA color multiplied into the mesh output.
    pub color: Color,
    /// Pipeline that interprets this material's GPU data.
    pub pipeline: PipelineId,
    /// ABI padding; callers must leave these values at zero.
    pub _padding: [u32; 3],
}

impl Default for BasicMaterial {
    fn default() -> Self {
        Self {
            color: Color::default(),
            pipeline: BASIC_PIPELINE_ID,
            _padding: [0; 3],
        }
    }
}

/// Data-oriented material storage addressed by compact handles.
pub struct MaterialRegistry {
    storage: SparseSet<BasicMaterial>,
}

impl MaterialRegistry {
    /// Creates fixed-capacity material storage indexed by entity identity.
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, material_capacity: usize) -> Self {
        Self {
            storage: SparseSet::with_capacity(entity_capacity, material_capacity),
        }
    }

    /// Inserts or replaces a material without allocating.
    pub fn insert(
        &mut self,
        handle: MaterialHandle,
        material: BasicMaterial,
    ) -> Result<Option<BasicMaterial>, SparseSetInsertError> {
        self.storage.insert(handle.entity(), material)
    }

    /// Returns whether the registry can accept or replace `handle`.
    #[must_use]
    pub fn can_insert(&self, handle: MaterialHandle) -> bool {
        self.storage.can_insert(handle.entity())
    }

    /// Borrows the material associated with `handle`, if it is present.
    #[must_use]
    pub fn get(&self, handle: MaterialHandle) -> Option<&BasicMaterial> {
        self.storage.get(handle.entity())
    }

    /// Removes and returns the material associated with `handle`.
    pub fn remove(&mut self, handle: MaterialHandle) -> Option<BasicMaterial> {
        self.storage.remove(handle.entity())
    }

    /// Returns the number of stored materials.
    #[must_use]
    pub fn len(&self) -> usize {
        self.storage.len()
    }

    /// Returns whether no material is stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.storage.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_replaces_and_removes_material_by_handle() {
        let mut registry = MaterialRegistry::with_capacity(8, 4);
        let handle = MaterialHandle::from_raw(3);
        assert!(
            registry
                .insert(handle, BasicMaterial::default())
                .unwrap()
                .is_none()
        );
        let blue = BasicMaterial {
            color: Color::new([0.0, 0.0, 1.0, 1.0]),
            ..BasicMaterial::default()
        };
        assert!(registry.insert(handle, blue).unwrap().is_some());
        assert_eq!(registry.get(handle), Some(&blue));
        assert_eq!(registry.remove(handle), Some(blue));
        assert!(registry.is_empty());
    }
}
