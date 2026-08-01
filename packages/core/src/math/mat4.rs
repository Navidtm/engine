use super::{Mat4, Quat, Vec3};

/// Writes a column-major TRS matrix without allocating.
pub fn compose(out: &mut Mat4, translation: &Vec3, rotation: &Quat, scale: &Vec3) {
    let [x, y, z, w] = rotation.0;
    let [sx, sy, sz] = scale.0;
    let x2 = x + x;
    let y2 = y + y;
    let z2 = z + z;
    let xx = x * x2;
    let xy = x * y2;
    let xz = x * z2;
    let yy = y * y2;
    let yz = y * z2;
    let zz = z * z2;
    let wx = w * x2;
    let wy = w * y2;
    let wz = w * z2;

    out.0 = [
        (1.0 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0.0,
        (xy - wz) * sy,
        (1.0 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0.0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1.0 - (xx + yy)) * sz,
        0.0,
        translation.0[0],
        translation.0[1],
        translation.0[2],
        1.0,
    ];
}

/// Writes a WebGPU-compatible right-handed perspective projection.
pub fn perspective(out: &mut Mat4, vertical_fov: f32, aspect: f32, near: f32, far: f32) {
    debug_assert!(aspect > 0.0 && near > 0.0 && far > near);
    let focal = 1.0 / (vertical_fov * 0.5).tan();
    let range = far / (near - far);
    out.0 = [
        focal / aspect,
        0.0,
        0.0,
        0.0,
        0.0,
        focal,
        0.0,
        0.0,
        0.0,
        0.0,
        range,
        -1.0,
        0.0,
        0.0,
        near * range,
        0.0,
    ];
}

/// Writes the inverse rigid transform used as a camera view matrix.
/// Camera scale is intentionally ignored.
pub fn view_from_transform(out: &mut Mat4, translation: &Vec3, rotation: &Quat) {
    let mut world = Mat4::default();
    compose(
        &mut world,
        translation,
        rotation,
        &Vec3::new([1.0, 1.0, 1.0]),
    );
    let matrix = world.0;
    let [tx, ty, tz] = translation.0;
    out.0 = [
        matrix[0],
        matrix[4],
        matrix[8],
        0.0,
        matrix[1],
        matrix[5],
        matrix[9],
        0.0,
        matrix[2],
        matrix[6],
        matrix[10],
        0.0,
        -(matrix[0] * tx + matrix[1] * ty + matrix[2] * tz),
        -(matrix[4] * tx + matrix[5] * ty + matrix[6] * tz),
        -(matrix[8] * tx + matrix[9] * ty + matrix[10] * tz),
        1.0,
    ];
}

/// Multiplies two column-major matrices into caller-owned storage.
pub fn multiply(out: &mut Mat4, left: &Mat4, right: &Mat4) {
    let a = &left.0;
    let b = &right.0;
    let mut result = [0.0; 16];
    for column in 0..4 {
        let offset = column * 4;
        for row in 0..4 {
            result[offset + row] = a[row] * b[offset]
                + a[4 + row] * b[offset + 1]
                + a[8 + row] * b[offset + 2]
                + a[12 + row] * b[offset + 3];
        }
    }
    out.0 = result;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_trs_preserves_translation() {
        let mut matrix = Mat4::default();
        compose(
            &mut matrix,
            &Vec3::new([2.0, 3.0, 4.0]),
            &Quat::default(),
            &Vec3::new([1.0, 1.0, 1.0]),
        );
        assert_eq!(matrix.0[12..16], [2.0, 3.0, 4.0, 1.0]);
    }

    #[test]
    fn camera_view_inverts_translation() {
        let mut view = Mat4::default();
        view_from_transform(&mut view, &Vec3::new([0.0, 0.0, 3.0]), &Quat::default());
        assert_eq!(view.0[12..16], [0.0, 0.0, -3.0, 1.0]);
    }

    #[test]
    fn identity_multiplication_preserves_matrix() {
        let mut projection = Mat4::default();
        perspective(&mut projection, 1.0, 16.0 / 9.0, 0.1, 100.0);
        let mut result = Mat4::default();
        multiply(&mut result, &Mat4::IDENTITY, &projection);
        assert_eq!(result, projection);
    }
}
