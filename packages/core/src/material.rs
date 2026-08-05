use crate::ecs::{Entity, SparseSet, SparseSetInsertError};
use crate::math::Color;

pub const BASIC_PIPELINE_ID: PipelineId = PipelineId::from_raw(1);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct PipelineId(u32);

impl PipelineId {
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(transparent)]
pub struct MaterialHandle(u32);

impl MaterialHandle {
    #[must_use]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    #[must_use]
    pub const fn from_entity(entity: Entity) -> Self {
        Self(entity.raw())
    }

    #[must_use]
    pub const fn raw(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn entity(self) -> Entity {
        Entity::from_raw(self.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C, align(16))]
pub struct BasicMaterial {
    pub color: Color,
    pub pipeline: PipelineId,
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
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, material_capacity: usize) -> Self {
        Self {
            storage: SparseSet::with_capacity(entity_capacity, material_capacity),
        }
    }

    pub fn insert(
        &mut self,
        handle: MaterialHandle,
        material: BasicMaterial,
    ) -> Result<Option<BasicMaterial>, SparseSetInsertError> {
        self.storage.insert(handle.entity(), material)
    }

    #[must_use]
    pub fn can_insert(&self, handle: MaterialHandle) -> bool {
        self.storage.can_insert(handle.entity())
    }

    #[must_use]
    pub fn get(&self, handle: MaterialHandle) -> Option<&BasicMaterial> {
        self.storage.get(handle.entity())
    }

    pub fn remove(&mut self, handle: MaterialHandle) -> Option<BasicMaterial> {
        self.storage.remove(handle.entity())
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.storage.len()
    }

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
