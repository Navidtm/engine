mod entity;
mod sparse_set;

pub use entity::{Entity, EntityAllocator, MAX_ENTITY_CAPACITY};
pub use sparse_set::{SparseSet, SparseSetInsertError};
