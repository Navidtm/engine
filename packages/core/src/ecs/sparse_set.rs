use super::Entity;

const VACANT: usize = usize::MAX;

/// Sparse entity lookup backed by tightly packed component values.
pub struct SparseSet<T> {
    sparse: Vec<usize>,
    entities: Vec<Entity>,
    values: Vec<T>,
}

impl<T> SparseSet<T> {
    #[must_use]
    pub fn with_capacity(entity_capacity: usize, component_capacity: usize) -> Self {
        Self {
            sparse: vec![VACANT; entity_capacity],
            entities: Vec::with_capacity(component_capacity),
            values: Vec::with_capacity(component_capacity),
        }
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.values.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    #[must_use]
    pub fn contains(&self, entity: Entity) -> bool {
        self.dense_index(entity).is_some()
    }

    pub fn insert(&mut self, entity: Entity, value: T) -> Option<T> {
        self.ensure_sparse(entity.index());
        if let Some(index) = self.dense_index(entity) {
            return Some(core::mem::replace(&mut self.values[index], value));
        }

        let dense_index = self.values.len();
        self.sparse[entity.index()] = dense_index;
        self.entities.push(entity);
        self.values.push(value);
        None
    }

    #[must_use]
    pub fn get(&self, entity: Entity) -> Option<&T> {
        self.dense_index(entity).map(|index| &self.values[index])
    }

    pub fn get_mut(&mut self, entity: Entity) -> Option<&mut T> {
        self.dense_index(entity)
            .map(|index| &mut self.values[index])
    }

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

    #[must_use]
    pub fn entities(&self) -> &[Entity] {
        &self.entities
    }

    #[must_use]
    pub fn values(&self) -> &[T] {
        &self.values
    }

    pub fn values_mut(&mut self) -> &mut [T] {
        &mut self.values
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (Entity, &T)> {
        self.entities.iter().copied().zip(self.values.iter())
    }

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

    fn ensure_sparse(&mut self, index: usize) {
        if index >= self.sparse.len() {
            self.sparse.resize(index + 1, VACANT);
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
        set.insert(a, 10);
        set.insert(b, 20);
        assert_eq!(set.remove(a), Some(10));
        assert_eq!(set.get(b), Some(&20));
        assert_eq!(set.entities(), &[b]);
    }

    #[test]
    fn generation_must_match() {
        let current = Entity::from_parts(0, 1).unwrap();
        let stale = Entity::from_parts(0, 0).unwrap();
        let mut set = SparseSet::with_capacity(1, 1);
        set.insert(current, 42);
        assert_eq!(set.get(stale), None);
    }
}
