//! Orbital's own glyphs for GPUI: icons.js (scripts/build-icons.js, the Nucleo line set) compiled in, so every glyph
//! is the path the web page draws. "name.svg" is a glyph; "name@bold.svg" the same at stroke width 2.5, as styles.css
//! draws a finished entry's check (.tl-done svg g); "tick.svg" is the checkbox's tick from styles.css .check:checked.
use gpui::{AssetSource, Result, SharedString};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::OnceLock;

const TICK: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.7l3.3 3.3 6.9-6.9"/></svg>"##;

fn glyphs() -> &'static HashMap<String, String> {
    static GLYPHS: OnceLock<HashMap<String, String>> = OnceLock::new();
    GLYPHS.get_or_init(|| {
        let source = include_str!("../../icons.js");
        let (start, end) = (source.find('{').unwrap_or(0), source.rfind('}').unwrap_or(0));
        serde_json::from_str(&source[start..=end]).unwrap_or_default()
    })
}

pub struct Icons;

impl AssetSource for Icons {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let name = path.trim_end_matches(".svg");
        if name == "tick" {
            return Ok(Some(Cow::Borrowed(TICK.as_bytes())));
        }
        let (name, bold) = match name.strip_suffix("@bold") {
            Some(n) => (n, true),
            None => (name, false),
        };
        Ok(glyphs().get(name).map(|svg| {
            let svg = if bold { svg.replace("stroke-width=\"1\"", "stroke-width=\"2.5\"") } else { svg.clone() };
            Cow::Owned(svg.into_bytes())
        }))
    }

    fn list(&self, _: &str) -> Result<Vec<SharedString>> {
        Ok(glyphs().keys().map(|k| SharedString::from(format!("{k}.svg"))).collect())
    }
}

pub fn has(name: &str) -> bool {
    glyphs().contains_key(name)
}
