//! One line of text with letter-spacing, which GPUI's styles do not have: shaped once, then each glyph painted
//! shifted by the tracking, as CSS letter-spacing adds it after every character. Orbital tracks its page title
//! (styles.css .titlebar h1, -0.5px) and its section headings (.ghead, 0.06em).
use gpui::*;

pub struct Tracked {
    text: SharedString,
    tracking: f32,
}

pub fn tracked(text: impl Into<SharedString>, tracking: f32) -> Tracked {
    Tracked { text: text.into(), tracking }
}

impl IntoElement for Tracked {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

pub struct Shaped {
    layout: std::sync::Arc<LineLayout>,
    color: Hsla,
}

impl Element for Tracked {
    type RequestLayoutState = Shaped;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, window: &mut Window, cx: &mut App) -> (LayoutId, Shaped) {
        let style = window.text_style();
        let size = style.font_size.to_pixels(window.rem_size());
        let run = TextRun { len: self.text.len(), font: style.font(), color: style.color, background_color: None, underline: None, strikethrough: None };
        let layout = window.text_system().layout_line(&self.text, size, &[run], None);
        let glyphs: usize = layout.runs.iter().map(|r| r.glyphs.len()).sum();
        let mut box_style = Style::default();
        box_style.size.width = (layout.width + px(self.tracking * glyphs as f32)).into();
        box_style.size.height = window.line_height().into();
        box_style.flex_shrink = 0.;
        (window.request_layout(box_style, [], cx), Shaped { layout, color: style.color })
    }

    fn prepaint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, _: Bounds<Pixels>, _: &mut Shaped, _: &mut Window, _: &mut App) {}

    fn paint(&mut self, _: Option<&GlobalElementId>, _: Option<&InspectorElementId>, bounds: Bounds<Pixels>, shaped: &mut Shaped, _: &mut (), window: &mut Window, _: &mut App) {
        let layout = &shaped.layout;
        let baseline = bounds.top() + (window.line_height() - layout.ascent - layout.descent) / 2. + layout.ascent;
        let mut n = 0.;
        for run in &layout.runs {
            for glyph in &run.glyphs {
                let origin = point(bounds.left() + glyph.position.x + px(self.tracking * n), baseline);
                window.paint_glyph(origin, run.font_id, glyph.id, layout.font_size, shaped.color).ok();
                n += 1.;
            }
        }
    }
}
