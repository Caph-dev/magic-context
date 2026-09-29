//! Provider token cost of inline images, read from the image header.
//!
//! Providers bill an image by its pixel dimensions, not by the length of its base64 text, so
//! counting a data URL with the text tokenizer overstates it by one to two orders of magnitude
//! (and costs a full tokenizer pass over megabytes of base64). These helpers decode only the
//! first few hundred base64 characters to read PNG, GIF, JPEG or WebP dimensions. They mirror
//! `packages/plugin/src/hooks/magic-context/image-token-estimate.ts`; the shared fixture
//! `testdata/image-token-parity.json` keeps the two in agreement.

use mc_store::{MediaBlock, MediaKind};

const IMAGE_TOKEN_DIVISOR: u64 = 750;
/// Used when an image's dimensions cannot be read (about a 950x950 image).
pub(crate) const IMAGE_FALLBACK_TOKENS: i64 = 1_200;
/// The provider's maximum for a single image.
const IMAGE_TOKEN_CAP: i64 = 4_500;
/// Base64 characters decoded to find the dimensions: enough for the PNG, GIF and WebP headers
/// and the usual JPEG frame-marker offsets.
const PREVIEW_BASE64_CHARS: usize = 512;

fn decode_base64_preview(payload: &str) -> Option<Vec<u8>> {
    // Only a short prefix is decoded, so size the buffer for that prefix, not the payload.
    let mut output = Vec::with_capacity(PREVIEW_BASE64_CHARS * 3 / 4);
    let mut quartet = [0u8; 4];
    let mut filled = 0usize;
    for byte in payload.bytes().take(PREVIEW_BASE64_CHARS) {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        quartet[filled] = value;
        filled += 1;
        if filled == 4 {
            output.push((quartet[0] << 2) | (quartet[1] >> 4));
            output.push((quartet[1] << 4) | (quartet[2] >> 2));
            output.push((quartet[2] << 6) | quartet[3]);
            filled = 0;
        }
    }
    if filled >= 2 {
        output.push((quartet[0] << 2) | (quartet[1] >> 4));
    }
    if filled >= 3 {
        output.push((quartet[1] << 4) | (quartet[2] >> 2));
    }
    Some(output)
}

fn image_dimensions(header: &str, bytes: &[u8]) -> Option<(u64, u64)> {
    if header.contains("image/png")
        && bytes.len() >= 24
        && bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
    {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?) as u64;
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?) as u64;
        return (width > 0 && height > 0).then_some((width, height));
    }
    if header.contains("image/gif") && bytes.len() >= 10 && bytes.starts_with(b"GIF") {
        let width = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u64;
        let height = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u64;
        return (width > 0 && height > 0).then_some((width, height));
    }
    if (header.contains("image/jpeg") || header.contains("image/jpg"))
        && bytes.starts_with(&[0xff, 0xd8])
    {
        let mut index = 2usize;
        while index + 8 < bytes.len() {
            if bytes[index] != 0xff {
                index += 1;
                continue;
            }
            let marker = bytes[index + 1];
            let is_sof = matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf);
            if is_sof {
                let height = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u64;
                let width = u16::from_be_bytes([bytes[index + 7], bytes[index + 8]]) as u64;
                return (width > 0 && height > 0).then_some((width, height));
            }
            if matches!(marker, 0xd8 | 0xd9 | 0x01) {
                index += 2;
                continue;
            }
            let segment_len = u16::from_be_bytes([bytes[index + 2], bytes[index + 3]]) as usize;
            if segment_len < 2 {
                return None;
            }
            index = index.saturating_add(2 + segment_len);
        }
    }
    if header.contains("image/webp")
        && bytes.len() >= 30
        && bytes.starts_with(b"RIFF")
        && &bytes[8..12] == b"WEBP"
    {
        let variant = &bytes[12..16];
        let (width, height) = if variant == b"VP8 " {
            (
                u16::from_le_bytes([bytes[26], bytes[27]]) as u64 & 0x3fff,
                u16::from_le_bytes([bytes[28], bytes[29]]) as u64 & 0x3fff,
            )
        } else if variant == b"VP8L" {
            let width = 1 + (u16::from_le_bytes([bytes[21], bytes[22]]) as u64 & 0x3fff);
            let height = 1
                + (((bytes[22] as u64 >> 6)
                    | ((bytes[23] as u64) << 2)
                    | ((bytes[24] as u64) << 10))
                    & 0x3fff);
            (width, height)
        } else if variant == b"VP8X" {
            (
                1 + bytes[24] as u64 + ((bytes[25] as u64) << 8) + ((bytes[26] as u64) << 16),
                1 + bytes[27] as u64 + ((bytes[28] as u64) << 8) + ((bytes[29] as u64) << 16),
            )
        } else {
            return None;
        };
        return (width > 0 && height > 0).then_some((width, height));
    }
    None
}

/// Provider token cost of an image given as a data URL, from its pixel dimensions: one token
/// per 750 pixels, rounded up and clamped to 1..=4,500, or 1,200 when the header cannot be
/// read. Mirrors `estimateImageTokensFromDataUrl` in the TypeScript plugin.
pub(crate) fn estimate_image_tokens(data_url: &str) -> i64 {
    let Some((header, payload)) = data_url.split_once(',') else {
        return IMAGE_FALLBACK_TOKENS;
    };
    estimate_image_tokens_from_parts(header, payload)
}

/// [`estimate_image_tokens`] for a data URL already split at its comma: `header` is the
/// `data:<mime>;base64` part and `payload` the base64 bytes.
pub(crate) fn estimate_image_tokens_from_parts(header: &str, payload: &str) -> i64 {
    let Some(bytes) = decode_base64_preview(payload) else {
        return IMAGE_FALLBACK_TOKENS;
    };
    let Some((width, height)) = image_dimensions(header, &bytes) else {
        return IMAGE_FALLBACK_TOKENS;
    };
    let pixels = width.saturating_mul(height);
    let tokens = pixels.saturating_add(IMAGE_TOKEN_DIVISOR - 1) / IMAGE_TOKEN_DIVISOR;
    (tokens as i64).clamp(1, IMAGE_TOKEN_CAP)
}

/// Provider token cost of an image media block, or `None` for non-image media (whose cost the
/// caller estimates from its bytes). Covers the ways the codecs carry image bytes: a
/// `data_base64` source with the payload alone, a `url` source holding a data URL, or a bare
/// data-URL string. A remote URL or any other shape counts as the fallback size.
pub(crate) fn media_image_tokens(media: &MediaBlock) -> Option<usize> {
    if !matches!(media.kind, MediaKind::Image) {
        return None;
    }
    let source = &media.source;
    let tokens = if let Some(url) = source.as_str() {
        estimate_image_tokens(url)
    } else {
        match source.get("type").and_then(|kind| kind.as_str()) {
            Some("data_base64") => match source.get("data").and_then(|data| data.as_str()) {
                Some(data) => estimate_image_tokens_from_parts(
                    &format!("data:{};base64", media.media_type),
                    data,
                ),
                None => IMAGE_FALLBACK_TOKENS,
            },
            Some("url") => match source.get("url").and_then(|url| url.as_str()) {
                Some(url) if url.starts_with("data:") => estimate_image_tokens(url),
                _ => IMAGE_FALLBACK_TOKENS,
            },
            _ => IMAGE_FALLBACK_TOKENS,
        }
    };
    Some(tokens as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(serde::Deserialize)]
    struct ParityCase {
        name: String,
        url: String,
        tokens: i64,
    }

    /// The TypeScript estimator's test reads the same fixture, so both implementations agree
    /// on every case: each format, the cap, the one-token floor and each fallback.
    #[test]
    fn image_tokens_match_shared_parity_fixture() {
        let cases: Vec<ParityCase> =
            serde_json::from_str(include_str!("../testdata/image-token-parity.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in &cases {
            assert_eq!(
                estimate_image_tokens(&case.url),
                case.tokens,
                "{}",
                case.name
            );
        }
    }

    /// Before/after trigger accounting for real image carriers. `CEREB_MEDIA_FIXTURE` names a
    /// local JSON array of data URLs exported read-only from a host database. Prints, per
    /// carrier, the text-token count of the projected block bytes (what the trigger used to
    /// count) and the pixel-based count it uses now.
    #[test]
    #[ignore = "requires CEREB_MEDIA_FIXTURE pointing to a local JSON array of data URLs"]
    fn real_carrier_trigger_token_counts() {
        use crate::ck_wire::{CkIngressMessage, CkKind, CkWireBlock, CkWireMessage};
        let urls: Vec<String> = serde_json::from_slice(
            &std::fs::read(std::env::var("CEREB_MEDIA_FIXTURE").unwrap()).unwrap(),
        )
        .unwrap();
        let (mut before_total, mut after_total) = (0, 0);
        for (index, url) in urls.iter().enumerate() {
            let (header, data) = url.split_once(',').unwrap();
            let media = MediaBlock {
                kind: MediaKind::Image,
                media_type: header
                    .trim_start_matches("data:")
                    .trim_end_matches(";base64")
                    .to_string(),
                filename: None,
                source: json!({ "type": "data_base64", "data": data }),
            };
            let message = CkIngressMessage {
                mid: format!("carrier-{index}"),
                ordinal: index as u64 + 1,
                ck: CkWireMessage::from_parts(
                    "user",
                    vec![CkWireBlock::bare(CkKind::Media(media.clone()))],
                    None,
                    Default::default(),
                    Default::default(),
                ),
            };
            let projection = crate::ck_wire::project_messages(&[message]).unwrap();
            let before = mc_tokenizer::estimate_tokens(&projection.blocks[0].bytes);
            let after = media_image_tokens(&media).unwrap();
            before_total += before;
            after_total += after;
            eprintln!(
                "real-carrier index={index} url_bytes={} before_bpe_tokens={before} after_pixel_tokens={after}",
                url.len()
            );
        }
        eprintln!(
            "real-carrier carriers={} before_total={before_total} after_total={after_total}",
            urls.len()
        );
    }

    /// Every source shape the codecs produce is counted from the same header.
    #[test]
    fn media_image_tokens_reads_each_source_shape() {
        let cases: Vec<ParityCase> =
            serde_json::from_str(include_str!("../testdata/image-token-parity.json")).unwrap();
        let png = cases
            .iter()
            .find(|case| case.name == "png-1920x1080")
            .unwrap();
        let (header, data) = png.url.split_once(',').unwrap();
        let media_type = header
            .trim_start_matches("data:")
            .trim_end_matches(";base64")
            .to_string();
        let image = |source| MediaBlock {
            kind: MediaKind::Image,
            media_type: media_type.clone(),
            filename: None,
            source,
        };
        let expected = Some(png.tokens as usize);
        assert_eq!(
            media_image_tokens(&image(json!({"type": "data_base64", "data": data}))),
            expected
        );
        assert_eq!(
            media_image_tokens(&image(json!({"type": "url", "url": png.url}))),
            expected
        );
        assert_eq!(media_image_tokens(&image(json!(png.url))), expected);
        assert_eq!(
            media_image_tokens(&image(
                json!({"type": "url", "url": "https://example.com/a.png"})
            )),
            Some(IMAGE_FALLBACK_TOKENS as usize)
        );
        let mut pdf = image(json!({"type": "data_base64", "data": data}));
        pdf.kind = MediaKind::Document;
        assert_eq!(media_image_tokens(&pdf), None);
    }
}
