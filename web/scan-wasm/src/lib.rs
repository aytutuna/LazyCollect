//! What the client page's scanner needs from LazyKit's Rust scanner, as plain numbers and byte arrays.
//! Required Notice: Copyright (c) 2026 Alazy Inc. (https://alazy.app)

use lazy_image::Rgba;
use lazy_scan::{
    CornerModel, DEFAULT_THRESHOLD, EnhanceMode, Issue, Quad, decode_heatmap, enhance,
    frame_issues, model_input, page_issues, refine,
};
use lazy_scan_model::TractModel;
use wasm_bindgen::prelude::*;

fn image(rgba: Vec<u8>, width: u32, height: u32) -> Result<Rgba, JsError> {
    let (w, h) = (width as usize, height as usize);
    // usize is 32 bits here, so a huge size could wrap around to the length it was given
    let len = w.checked_mul(h).and_then(|n| n.checked_mul(4));
    if w == 0 || h == 0 || len != Some(rgba.len()) {
        return Err(JsError::new("the pixels do not match the size"));
    }
    Ok(Rgba::new(w, h, rgba))
}

fn quad(corners: &[f64]) -> Result<Quad, JsError> {
    match corners {
        [a, b, c, d, e, f, g, h] => Ok(Quad::from_xy([[*a, *b], [*c, *d], [*e, *f], [*g, *h]])),
        _ => Err(JsError::new("an outline is eight numbers")),
    }
}

fn corners(q: &Quad) -> impl Iterator<Item = f64> {
    q.0.into_iter().flat_map(|p| [p.x, p.y])
}

fn issue_names(issues: Vec<Issue>) -> Vec<String> {
    issues
        .into_iter()
        .map(|i| {
            match i {
                Issue::Blur => "blur",
                Issue::Glare => "glare",
                Issue::Dark => "dark",
                Issue::Cut => "cut",
                Issue::Small => "small",
            }
            .to_string()
        })
        .collect()
}

/// The corner model, loaded once.
#[wasm_bindgen]
pub struct Scanner {
    model: TractModel,
}

#[wasm_bindgen]
impl Scanner {
    /// `onnx` is the model with tract's Einsum fix (tools/patch_einsum.py in LazyKit).
    #[wasm_bindgen(constructor)]
    pub fn new(onnx: &[u8]) -> Result<Scanner, JsError> {
        let model = TractModel::load(onnx).map_err(|e| JsError::new(&e.to_string()))?;
        Ok(Scanner { model })
    }

    /// The page the model sees in the frame: its eight corner coordinates as shares of the frame, then the confidence;
    /// empty when the model has no page. The caller's sanity checks come after.
    pub fn detect(&self, rgba: Vec<u8>, width: u32, height: u32) -> Result<Vec<f64>, JsError> {
        let frame = image(rgba, width, height)?;
        let heat = self
            .model
            .run(&model_input(&frame))
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(decode_heatmap(&heat.values, heat.width, heat.height)
            .map(|f| corners(&f.quad).chain([f.confidence]).collect())
            .unwrap_or_default())
    }
}

/// `outline` (eight pixel coordinates) moved onto the page's edges in the photo: the new outline, then 1 when it moved or
/// 0 when it did not, then how well edges back the weakest side.
#[wasm_bindgen]
pub fn refine_edges(
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    outline: &[f64],
) -> Result<Vec<f64>, JsError> {
    let r = refine(&image(rgba, width, height)?, &quad(outline)?);
    Ok(corners(&r.quad)
        .chain([f64::from(r.refined), r.support])
        .collect())
}

/// The page cleaned up as `mode` says: enhanced, whiteboard, gray or bw.
#[wasm_bindgen]
pub fn clean_up(rgba: Vec<u8>, width: u32, height: u32, mode: &str) -> Result<Vec<u8>, JsError> {
    let mode = match mode {
        "enhanced" => EnhanceMode::Auto,
        "whiteboard" => EnhanceMode::Whiteboard,
        "gray" => EnhanceMode::Gray,
        "bw" => EnhanceMode::BlackAndWhite,
        _ => return Err(JsError::new("unknown filter")),
    };
    Ok(
        enhance(&image(rgba, width, height)?, mode, DEFAULT_THRESHOLD)
            .image
            .data,
    )
}

/// What is wrong with a flattened page: blur, glare, dark.
#[wasm_bindgen]
pub fn page_problems(rgba: Vec<u8>, width: u32, height: u32) -> Result<Vec<String>, JsError> {
    Ok(issue_names(page_issues(&image(rgba, width, height)?)))
}

/// What is wrong with where the page sits in a frame: cut, small. `confidence` is the model's, when there is one.
#[wasm_bindgen]
pub fn frame_problems(
    outline: &[f64],
    confidence: Option<f64>,
    width: f64,
    height: f64,
) -> Result<Vec<String>, JsError> {
    Ok(issue_names(frame_issues(
        &quad(outline)?,
        confidence,
        width,
        height,
    )))
}
