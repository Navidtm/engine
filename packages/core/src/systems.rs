use crate::ecs::{Entity, SparseSet};
use crate::math::{compose, perspective, view_from_transform};
use crate::{Camera, Transform};

/// Recomputes all transform world matrices in dense storage order.
///
/// The caller owns the component storage; this system allocates nothing.
pub fn update_transforms(transforms: &mut SparseSet<Transform>) {
    update_transforms_with(transforms, |_| {});
}

/// Recomputes matrices and reports only records whose derived matrix changed.
///
/// This internal publication hook lets [`crate::World`] advance render
/// revisions after derived data changes without allocating a dirty list.
pub(crate) fn update_transforms_with(
    transforms: &mut SparseSet<Transform>,
    mut publish_changed: impl FnMut(Entity),
) {
    for (entity, transform) in transforms.iter_mut() {
        let previous = transform.world_matrix;
        compose(
            &mut transform.world_matrix,
            &transform.local_position,
            &transform.rotation,
            &transform.scale,
        );
        if transform.world_matrix != previous {
            publish_changed(entity);
        }
    }
}

/// Recomputes camera projection and view matrices from their ECS components.
///
/// A camera without a transform receives the identity view matrix. This system
/// performs no allocation and does not mutate the transform storage.
pub fn update_cameras(cameras: &mut SparseSet<Camera>, transforms: &SparseSet<Transform>) {
    for (entity, camera) in cameras.iter_mut() {
        perspective(
            &mut camera.projection,
            camera.vertical_fov_radians,
            camera.aspect,
            camera.near,
            camera.far,
        );
        if let Some(transform) = transforms.get(entity) {
            view_from_transform(
                &mut camera.view,
                &transform.local_position,
                &transform.rotation,
            );
        } else {
            camera.view = Default::default();
        }
    }
}
