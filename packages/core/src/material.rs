use crate::math::Color;
use crate::resource::MaterialHandle;

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
    slots: Vec<Option<BasicMaterial>>,
    generations: Vec<u16>,
    len: usize,
}

impl MaterialRegistry {
    /// Creates fixed-capacity material storage indexed by resource identity.
    #[must_use]
    pub fn with_capacity(material_capacity: usize) -> Self {
        Self {
            slots: vec![None; material_capacity],
            generations: vec![0; material_capacity],
            len: 0,
        }
    }

    /// Inserts or replaces a material without allocating.
    pub fn insert(
        &mut self,
        handle: MaterialHandle,
        material: BasicMaterial,
    ) -> Result<Option<BasicMaterial>, BasicMaterial> {
        let index = handle.index();
        if index == 0 || index >= self.slots.len() || self.generations[index] != handle.generation()
        {
            return Err(material);
        }
        let previous = self.slots[index].replace(material);
        if previous.is_none() {
            self.len += 1;
        }
        Ok(previous)
    }

    /// Returns whether the registry can accept or replace `handle`.
    #[must_use]
    pub fn can_insert(&self, handle: MaterialHandle) -> bool {
        let index = handle.index();
        index > 0 && index < self.slots.len() && self.generations[index] == handle.generation()
    }

    /// Borrows the material associated with `handle`, if it is present.
    #[must_use]
    pub fn get(&self, handle: MaterialHandle) -> Option<&BasicMaterial> {
        let index = handle.index();
        if index == 0 || index >= self.slots.len() || self.generations[index] != handle.generation()
        {
            return None;
        }
        self.slots[index].as_ref()
    }

    /// Removes and returns the material associated with `handle`.
    pub fn remove(&mut self, handle: MaterialHandle) -> Option<BasicMaterial> {
        let index = handle.index();
        if index == 0 || index >= self.slots.len() || self.generations[index] != handle.generation()
        {
            return None;
        }
        let removed = self.slots[index].take()?;
        self.generations[index] = if self.generations[index] < 0x0fff {
            self.generations[index] + 1
        } else {
            0x1000
        };
        self.len -= 1;
        Some(removed)
    }

    /// Returns the number of stored materials.
    #[must_use]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Returns whether no material is stored.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_replaces_and_removes_material_by_handle() {
        let mut registry = MaterialRegistry::with_capacity(4);
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
        assert!(registry.insert(handle, BasicMaterial::default()).is_err());
        let recycled = MaterialHandle::from_raw((1 << 20) | 3);
        assert!(registry.insert(recycled, BasicMaterial::default()).is_ok());
    }

    #[test]
    fn registry_retires_a_slot_before_generation_wrap() {
        let mut registry = MaterialRegistry::with_capacity(2);
        for generation in 0..=0x0fff {
            let handle = MaterialHandle::from_raw((generation << 20) | 1);
            assert!(registry.insert(handle, BasicMaterial::default()).is_ok());
            assert!(registry.remove(handle).is_some());
        }

        assert!(
            registry
                .insert(MaterialHandle::from_raw(1), BasicMaterial::default())
                .is_err()
        );
    }
}
