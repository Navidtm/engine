use crate::ecs::SparseSet;
use crate::math::{compose, perspective, view_from_transform};
use crate::{Camera, Transform};

pub fn update_transforms(transforms: &mut SparseSet<Transform>) {
    for transform in transforms.values_mut() {
        compose(
            &mut transform.world_matrix,
            &transform.local_position,
            &transform.rotation,
            &transform.scale,
        );
    }
}

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
