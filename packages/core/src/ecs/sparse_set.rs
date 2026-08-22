use super::{Entity, MAX_ENTITY_CAPACITY};

const VACANT: usize = usize::MAX;

/// Reason a fixed-capacity sparse-set insertion could not add a new value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SparseSetInsertError {
    /// The entity index is outside the configured sparse lookup capacity.
    EntityCapacity,
    /// The dense component array is full.
    ComponentCapacity,
}

/// Sparse entity lookup backed by tightly packed component values.
pub struct SparseSet<T> {
    sparse: Vec<usize>,
    entities: Vec<Entity>,
    values: Vec<T>,
    component_capacity: usize,
}

impl<T> SparseSet<T> {
    /// Creates a sparse lookup and dense value storage with immutable capacities.
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, component_capacity: usize) -> Self {
        let entity_capacity = entity_capacity.min(MAX_ENTITY_CAPACITY);
        let component_capacity = component_capacity.min(entity_capacity);
        Self {
            sparse: vec![VACANT; entity_capacity],
            entities: Vec::with_capacity(component_capacity),
            values: Vec::with_capacity(component_capacity),
            component_capacity,
        }
    }

    /// Returns the number of stored components.
    #[must_use]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// Returns whether this set currently contains no components.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Returns whether `entity` currently has a value in this set.
    #[must_use]
    pub fn contains(&self, entity: Entity) -> bool {
        self.dense_index(entity).is_some()
    }

    /// Inserts or replaces `entity`'s value without growing either backing array.
    ///
    /// At most one generation may occupy an entity index. Inserting another
    /// generation replaces that index's existing entity and value, returning
    /// the previous value. `World` liveness validation determines which
    /// generation is canonical before it calls this storage primitive. A new
    /// insertion can fail when the lookup or dense capacity is exhausted.
    pub fn insert(&mut self, entity: Entity, value: T) -> Result<Option<T>, SparseSetInsertError> {
        if entity.index() >= self.sparse.len() {
            return Err(SparseSetInsertError::EntityCapacity);
        }
        let occupied_index = self.sparse[entity.index()];
        if occupied_index != VACANT {
            self.entities[occupied_index] = entity;
            return Ok(Some(core::mem::replace(
                &mut self.values[occupied_index],
                value,
            )));
        }
        if self.values.len() == self.component_capacity {
            return Err(SparseSetInsertError::ComponentCapacity);
        }

        let dense_index = self.values.len();
        self.sparse[entity.index()] = dense_index;
        self.entities.push(entity);
        self.values.push(value);
        Ok(None)
    }

    /// Returns whether inserting `entity` could succeed at the current capacity.
    #[must_use]
    pub fn can_insert(&self, entity: Entity) -> bool {
        entity.index() < self.sparse.len()
            && (self.sparse[entity.index()] != VACANT
                || self.values.len() < self.component_capacity)
    }

    /// Borrows the value associated with `entity`, if present and generation-valid.
    #[must_use]
    pub fn get(&self, entity: Entity) -> Option<&T> {
        self.dense_index(entity).map(|index| &self.values[index])
    }

    /// Mutably borrows the value associated with `entity`, if present.
    pub fn get_mut(&mut self, entity: Entity) -> Option<&mut T> {
        self.dense_index(entity)
            .map(|index| &mut self.values[index])
    }

    /// Removes `entity`'s value with `swap_remove` and returns it when present.
    ///
    /// Dense iteration order is not preserved.
    pub fn remove(&mut self, entity: Entity) -> Option<T> {
        let dense_index = self.dense_index(entity)?;
        self.sparse[entity.index()] = VACANT;
        self.entities.swap_remove(dense_index);
        let removed = self.values.swap_remove(dense_index);

        if dense_index < self.entities.len() {
            let moved = self.entities[dense_index];
            self.sparse[moved.index()] = dense_index;
        }
        Some(removed)
    }

    /// Returns entities in dense component order.
    #[must_use]
    pub fn entities(&self) -> &[Entity] {
        &self.entities
    }

    /// Returns component values in the same order as [`Self::entities`].
    #[must_use]
    pub fn values(&self) -> &[T] {
        &self.values
    }

    /// Mutably returns component values in dense order.
    pub fn values_mut(&mut self) -> &mut [T] {
        &mut self.values
    }

    /// Iterates entity/value pairs in dense order without allocation.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (Entity, &T)> {
        self.entities.iter().copied().zip(self.values.iter())
    }

    /// Mutably iterates entity/value pairs in dense order without allocation.
    pub fn iter_mut(&mut self) -> impl ExactSizeIterator<Item = (Entity, &mut T)> {
        self.entities.iter().copied().zip(self.values.iter_mut())
    }

    fn dense_index(&self, entity: Entity) -> Option<usize> {
        let dense_index = *self.sparse.get(entity.index())?;
        if dense_index == VACANT || self.entities.get(dense_index) != Some(&entity) {
            None
        } else {
            Some(dense_index)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swap_remove_repairs_sparse_index() {
        let a = Entity::from_raw(0);
        let b = Entity::from_raw(1);
        let mut set = SparseSet::with_capacity(2, 2);
        set.insert(a, 10).unwrap();
        set.insert(b, 20).unwrap();
        assert_eq!(set.remove(a), Some(10));
        assert_eq!(set.get(b), Some(&20));
        assert_eq!(set.entities(), &[b]);
    }

    #[test]
    fn generation_must_match() {
        let current = Entity::from_parts(0, 1).unwrap();
        let stale = Entity::from_parts(0, 0).unwrap();
        let mut set = SparseSet::with_capacity(1, 1);
        set.insert(current, 42).unwrap();
        assert_eq!(set.get(stale), None);
    }

    #[test]
    fn generation_replacement_cannot_orphan_the_previous_dense_entry() {
        let stale = Entity::from_parts(0, 0).unwrap();
        let current = Entity::from_parts(0, 1).unwrap();
        let mut set = SparseSet::with_capacity(1, 1);
        set.insert(stale, 10).unwrap();

        assert!(set.can_insert(current));
        assert_eq!(set.insert(current, 20), Ok(Some(10)));
        assert_eq!(set.len(), 1);
        assert_eq!(set.entities(), &[current]);
        assert_eq!(set.values(), &[20]);
        assert_eq!(set.get(stale), None);
        assert_eq!(set.get(current), Some(&20));
    }

    #[test]
    fn insertion_rejects_entity_and_component_capacity_overflow() {
        let mut set = SparseSet::with_capacity(1, 1);
        set.insert(Entity::from_raw(0), 1).unwrap();
        assert_eq!(
            set.insert(Entity::from_raw(1), 2),
            Err(SparseSetInsertError::EntityCapacity)
        );
        assert_eq!(
            set.insert(Entity::from_parts(0, 1).unwrap(), 2),
            Ok(Some(1))
        );
    }
}
