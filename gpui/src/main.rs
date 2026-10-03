//! Orbital's desktop window drawn with GPUI (a spike, see README.md). The window draws; the JavaScript engine
//! (sidecar.js, answering window.api's calls) knows Tana. Keyboard first: arrows move, Enter opens or edits, Tab and
//! Shift-Tab indent, ⌘Enter ticks, ⌘K searches, Esc goes back.
mod engine;
mod icons;
mod input;
mod time;
mod timeline;
mod tracked;

use engine::{Engine, Push};
use futures::StreamExt;
use futures::channel::mpsc;
use gpui::prelude::FluentBuilder;
use gpui::*;
use input::{InputEvent, TextInput};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

actions!(orbital, [Up, Down, Open, Back, Toggle, Indent, Outdent, Palette, Undo, Redo, Collapse, Expand, Quit, SwitchTheme]);

#[derive(Clone, PartialEq, Debug)]
enum Place {
    View(String),
    Doc(String),
}

#[derive(Clone, Copy)]
struct Theme {
    dark: bool,
    bg: Hsla,
    fg: Hsla,
    muted: Hsla,
    faint: Hsla,
    line: Hsla,
    select: Hsla,
    surface: Hsla,
    accent: Hsla,
    green: Hsla,
    link: Hsla,
    chip: Hsla,
    scrim: Hsla,
    // the window's header and title (shell.css .head, styles.css .titlebar h1)
    head_bg: Hsla,
    head_btn: Hsla,
    head_hover: Hsla,
    title: Hsla,
    create_bg: Hsla,
    create_fg: Hsla,
    // the Timeline (styles.css "Timeline"): an entry's words, the markers, the rail, a finished entry's disc
    entry: Hsla,
    marker: Hsla,
    marker_new: Hsla,
    marker_robot_new: Hsla,
    accent_live: Hsla,
    rail: Hsla,
    done: Hsla,
    unread: Hsla,
    check: Hsla,
    check_on: Hsla,
    face_text: Hsla,
    face_more: Hsla,
    detail_border: Hsla,
    detail_bg: Hsla,
    detail_text: Hsla,
    detail_strong: Hsla,
}

fn theme(dark: bool) -> Theme {
    let c = |x: u32| -> Hsla { rgb(x).into() };
    let ca = |x: u32| -> Hsla { rgba(x).into() };
    if dark {
        Theme { dark, bg: c(0x1b1d1e), fg: c(0xc9c9c9), muted: c(0xa0a5a8), faint: c(0x5c6266), line: c(0x2e3235),
            select: ca(0x6ea8dc2e), surface: c(0x242729), accent: c(0x6ea8dc), green: c(0x5abe78), link: c(0x8ab8e8), chip: c(0x2c3033), scrim: ca(0x00000085),
            head_bg: c(0x232627), head_btn: c(0xaaaaaa), head_hover: c(0x3a3f42), title: c(0xe8eaec), create_bg: c(0x242729), create_fg: c(0xa6a6a6),
            entry: c(0xccd0d3), marker: c(0x8a8f95), marker_new: c(0x5a5d60), marker_robot_new: c(0x5a5d60), accent_live: c(0x3b9eff), rail: c(0x34373a),
            done: c(0x5a9670), unread: c(0x0090ff), check: c(0x3a3e40), check_on: c(0x5b976c), face_text: c(0xbbbbbb), face_more: c(0x33383b),
            detail_border: c(0x45484b), detail_bg: c(0x242628), detail_text: c(0xb4b6b8), detail_strong: c(0xd4d6d8) }
    } else {
        Theme { dark, bg: c(0xffffff), fg: c(0x1a1a1a), muted: c(0x666666), faint: c(0xb4b4b4), line: c(0xebebeb),
            select: ca(0x508fbb24), surface: c(0xffffff), accent: c(0x508fbb), green: c(0x34a853), link: c(0x2f6db5), chip: c(0xf0f0f0), scrim: ca(0x0000001f),
            head_bg: c(0xf6f6f6), head_btn: c(0x777777), head_hover: c(0xdddddd), title: c(0x1c2024), create_bg: c(0xffffff), create_fg: c(0x6b6b6b),
            entry: c(0x3c3e42), marker: c(0x8e9297), marker_new: c(0xc4c4c4), marker_robot_new: c(0xaeb1b5), accent_live: c(0x0090ff), rail: c(0xe6e6e6),
            done: c(0x5a9670), unread: c(0x0090ff), check: c(0xe4e4e4), check_on: c(0x6fae82), face_text: c(0x666666), face_more: c(0xeeeeee),
            detail_border: c(0xdcdcdc), detail_bg: c(0xf6f6f6), detail_text: c(0x555555), detail_strong: c(0x333333) }
    }
}

/// A type's hue is an OKLCH angle, as Tana stores it (styles.css): converted here, since GPUI takes sRGB.
fn oklch(l: f32, c: f32, hue: f32) -> Hsla {
    let (a, b) = (c * hue.to_radians().cos(), c * hue.to_radians().sin());
    let l_ = (l + 0.396_337_8 * a + 0.215_803_76 * b).powi(3);
    let m_ = (l - 0.105_561_35 * a - 0.063_854_17 * b).powi(3);
    let s_ = (l - 0.089_484_18 * a - 1.291_485_5 * b).powi(3);
    let enc = |x: f32| {
        let x = x.clamp(0., 1.);
        if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1. / 2.4) - 0.055 }
    };
    Rgba {
        r: enc(4.076_741_7 * l_ - 3.307_711_6 * m_ + 0.230_969_94 * s_),
        g: enc(-1.268_438 * l_ + 2.609_757_4 * m_ - 0.341_319_38 * s_),
        b: enc(-0.004_196_086 * l_ - 0.703_418_6 * m_ + 1.707_614_7 * s_),
        a: 1.,
    }
    .into()
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn title_of(v: &Value) -> String {
    [s(v, "text"), s(v, "title")].into_iter().find(|t| !t.is_empty()).unwrap_or("Untitled").to_string()
}

fn done_of(v: &Value) -> Option<bool> {
    match v.get("done") {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::Number(n)) => Some(n.as_i64() == Some(1)),
        _ => None,
    }
}

fn is_doc(v: &Value) -> bool {
    s(v, "kind") == "document"
}

fn children_of(v: &Value) -> &[Value] {
    v.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// A row's words as GPUI text runs: marks to weights and styles, mentions and links in the link colour.
fn rich(v: &Value, t: &Theme) -> StyledText {
    let mut text = String::new();
    let mut highlights = Vec::new();
    for seg in v.get("segments").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let reference = seg.get("mention").or_else(|| seg.get("reference"));
        let piece = match reference {
            Some(r) => s(r, "label"),
            None => s(seg, "text"),
        };
        if piece.is_empty() {
            continue;
        }
        let start = text.len();
        text.push_str(piece);
        let marks = seg.get("marks");
        let on = |k: &str| marks.and_then(|m| m.get(k)).is_some_and(|x| !x.is_null() && *x != Value::Bool(false));
        let mut style = HighlightStyle::default();
        if on("bold") {
            style.font_weight = Some(FontWeight::SEMIBOLD);
        }
        if on("italic") {
            style.font_style = Some(FontStyle::Italic);
        }
        if on("strike") {
            style.strikethrough = Some(StrikethroughStyle { thickness: px(1.), color: None });
        }
        if on("code") {
            style.background_color = Some(t.chip);
        }
        if reference.is_some() || on("link") {
            style.color = Some(t.link);
        }
        if style != HighlightStyle::default() {
            highlights.push((start..text.len(), style));
        }
    }
    if text.is_empty() && highlights.is_empty() {
        text = if is_doc(v) { title_of(v) } else { s(v, "text").to_string() };
    }
    StyledText::new(text).with_highlights(highlights)
}

#[derive(Clone)]
struct Line {
    id: String,
    depth: usize,
    node: Value,
    /// the document a block lives in; None for a list's rows
    doc: Option<String>,
}

struct Page {
    title: String,
    meta: String,
    rows: Vec<Value>,
    doc: Option<String>,
    /// the days each document is pinned to (api.pinDates), for the Timeline's "Pinned to Today" line
    pins: HashMap<String, Vec<String>>,
}

/// What the page's virtual list holds, item by item. A page is its head and its rows; the Timeline interleaves day
/// headings, its entries and the rows they list, Add more, the rule after the top blocks and Show three more days.
#[derive(Clone)]
enum Slot {
    PageHead,
    Row(usize),
    DayHead { key: String, title: String, top: f32, open: bool },
    Entry(usize),
    Child { ix: usize, last: bool, boxes: bool },
    AddMore,
    Divider,
    Older,
}

#[derive(Clone)]
enum Act {
    Go(Place),
    Theme,
    Undo,
    Redo,
}

#[derive(Clone)]
struct Item {
    title: String,
    meta: String,
    act: Act,
}

struct PaletteState {
    input: Entity<TextInput>,
    items: Vec<Item>,
    sel: usize,
    seq: u64,
    _sub: Subscription,
}

struct Orbital {
    engine: Arc<Engine>,
    focus: FocusHandle,
    views: Vec<(Place, String)>,
    pinned: Vec<(Place, String)>,
    place: Place,
    back: Vec<Place>,
    page: Option<Page>,
    lines: Vec<Line>,
    collapsed: HashSet<String>,
    cursor: usize,
    keep_cursor: bool,
    editing: Option<(String, Entity<TextInput>)>,
    pending_edit: Option<(String, usize)>,
    /// splits the engine has not answered yet; reads that arrive meanwhile wait (stale), so a row being typed into
    /// never disappears under the caret
    splitting: usize,
    stale: bool,
    palette: Option<PaletteState>,
    dark: bool,
    follow_system: bool,
    note: Option<(u64, SharedString)>,
    seq: u64,
    /// the page as a virtual list of slots (Slot). Only what is on screen is laid out, so a frame costs the same at 50
    /// rows or 50,000.
    list: ListState,
    slots: Vec<Slot>,
    /// the Timeline's folded days, its date pins, how many three-day pages it reads, and whether a key moved the caret
    /// (the page draws no caret until one does, as the web page shows none)
    tl_folded: HashSet<String>,
    pins: HashMap<String, Vec<String>>,
    tl_pages: u32,
    tl_loading: bool,
    keyed: bool,
    started: Option<Instant>,
    timing: bool,
    window: Option<AnyWindowHandle>,
    _subs: Vec<Subscription>,
    _pushes: Task<()>,
}

fn appears_dark(window: &Window) -> bool {
    matches!(window.appearance(), WindowAppearance::Dark | WindowAppearance::VibrantDark)
}

impl Orbital {
    fn new(engine: Arc<Engine>, mut pushes: mpsc::UnboundedReceiver<Push>, started: Instant, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus);
        let task = cx.spawn_in(window, async move |this, cx| {
            while let Some((name, args)) = pushes.next().await {
                if this.update_in(cx, |this, window, cx| this.on_push(&name, &args, window, cx)).is_err() {
                    break;
                }
            }
        });
        let appearance = cx.observe_window_appearance(window, |this, window, cx| {
            if this.follow_system {
                this.dark = appears_dark(window);
                cx.notify();
            }
        });
        let views = [("timeline", "Timeline"), ("inbox", "Inbox"), ("library", "Library"), ("types", "Types")]
            .map(|(id, title)| (Place::View(id.into()), title.to_string()))
            .to_vec();
        let mut this = Orbital {
            engine,
            focus,
            views,
            pinned: vec![],
            place: Place::View(std::env::var("ORBITAL_START").unwrap_or_else(|_| "timeline".into())),
            back: vec![],
            page: None,
            lines: vec![],
            collapsed: HashSet::new(),
            cursor: 0,
            keep_cursor: false,
            editing: None,
            pending_edit: None,
            splitting: 0,
            stale: false,
            palette: None,
            dark: std::env::var("ORBITAL_THEME").map(|t| t == "dark").unwrap_or_else(|_| appears_dark(window)),
            follow_system: std::env::var("ORBITAL_THEME").is_err(),
            note: None,
            seq: 0,
            list: ListState::new(1, ListAlignment::Top, px(600.)),
            slots: vec![],
            tl_folded: HashSet::new(),
            pins: HashMap::new(),
            tl_pages: 1,
            tl_loading: false,
            keyed: false,
            started: Some(started),
            timing: std::env::var("ORBITAL_TIMING").is_ok(),
            window: Some(window.window_handle()),
            _subs: vec![appearance],
            _pushes: task,
        };
        if let Ok(doc) = std::env::var("ORBITAL_OPEN") {
            this.place = Place::Doc(doc);
        }
        this.reload(window, cx);
        this.load_pins(window, cx);
        // the free time counts down while the Timeline is on screen (renderer/timeline.js, every 15 s)
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(15)).await;
                if this.update(cx, |this, cx| if this.is_timeline() { cx.notify() }).is_err() {
                    break;
                }
            }
        })
        .detach();
        this
    }

    fn theme(&self) -> Theme {
        theme(self.dark)
    }

    // ---- talking to the engine ----

    fn title_for(&self, place: &Place) -> String {
        self.views.iter().chain(&self.pinned).find(|(p, _)| p == place).map(|(_, t)| t.clone()).unwrap_or_default()
    }

    fn reload(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.seq += 1;
        let seq = self.seq;
        let place = self.place.clone();
        let title = self.title_for(&place);
        let engine = self.engine.clone();
        let asked = Instant::now();
        cx.spawn_in(window, async move |this, cx| {
            let page = load(&engine, &place, title).await;
            this.update_in(cx, |this, window, cx| {
                if this.seq != seq {
                    return; // a newer read was asked for: an answer that arrives late never paints over it
                }
                match page {
                    Ok(mut page) => {
                        let keep = this.keep_cursor.then(|| this.lines.get(this.cursor).map(|l| l.id.clone())).flatten();
                        this.pins = std::mem::take(&mut page.pins);
                        this.page = Some(page);
                        this.flatten();
                        this.relist(!this.keep_cursor);
                        this.cursor = keep.and_then(|id| this.lines.iter().position(|l| l.id == id)).unwrap_or(if this.keep_cursor { this.cursor } else { 0 });
                        this.cursor = this.cursor.min(this.lines.len().saturating_sub(1));
                        this.apply_pending(window, cx);
                    }
                    Err(e) => this.toast(e, cx),
                }
                let answered = asked.elapsed();
                let first = this.started.take();
                let rows = this.lines.len();
                let timing = this.timing;
                window.on_next_frame(move |_, _| {
                    if let Some(start) = first {
                        eprintln!("[timing] first page drawn {} ms after launch ({rows} rows)", start.elapsed().as_millis());
                    } else if timing {
                        eprintln!("[timing] page: engine {} ms, drawn {} ms ({rows} rows)", answered.as_millis(), asked.elapsed().as_millis());
                    }
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn load_pins(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let engine = self.engine.clone();
        cx.spawn_in(window, async move |this, cx| {
            let ids = engine.call("pinIds", json!([])).await.unwrap_or(Value::Null);
            let ids: Vec<String> = ids.as_array().map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(Value::as_str).map(String::from).collect();
            let asked = Instant::now();
            let infos = futures::future::join_all(ids.iter().map(|id| engine.call("node", json!([id])))).await; // all asked at once
            let pinned: Vec<_> = ids.iter().zip(infos).filter_map(|(id, info)| info.ok().map(|i| (Place::Doc(id.clone()), title_of(&i)))).collect();
            eprintln!("[timing] {} of {} pins named in {} ms", pinned.len(), ids.len(), asked.elapsed().as_millis());
            this.update(cx, |this, cx| {
                this.pinned = pinned;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// A write: answered in the background. Its effect arrives as a "changed" push; a refusal is a toast, and the page
    /// is read again so what was drawn ahead of the answer goes back to what is stored.
    fn write(&mut self, method: &str, params: Value, cx: &mut Context<Self>) {
        let call = self.engine.call(method, params);
        let Some(window) = self.window else { return };
        cx.spawn(async move |this, cx| {
            if let Err(e) = call.await {
                window
                    .update(cx, |_, window, cx| {
                        this.update(cx, |this, cx| {
                            this.toast(e, cx);
                            this.keep_cursor = true;
                            this.reload(window, cx);
                        })
                    })
                    .ok();
            }
        })
        .detach();
    }

    fn on_push(&mut self, name: &str, args: &[Value], window: &mut Window, cx: &mut Context<Self>) {
        let doc = args.first().and_then(Value::as_str);
        match name {
            "changed" => {
                let relevant = match &self.place {
                    Place::Doc(id) => doc.is_none_or(|d| d == id),
                    Place::View(_) => true,
                };
                if relevant {
                    self.keep_cursor = true;
                    if self.splitting > 0 {
                        self.stale = true;
                    } else {
                        self.reload(window, cx);
                    }
                }
            }
            "removed" if matches!(&self.place, Place::Doc(id) if Some(id.as_str()) == doc) => self.go_back(window, cx),
            _ => {}
        }
    }

    fn toast(&mut self, message: impl Into<SharedString>, cx: &mut Context<Self>) {
        let id = rand_id();
        let message = message.into();
        eprintln!("[toast] {message}");
        self.note = Some((id, message));
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(3)).await;
            this.update(cx, |this, cx| {
                if this.note.as_ref().is_some_and(|(n, _)| *n == id) {
                    this.note = None;
                    cx.notify();
                }
            })
            .ok();
        })
        .detach();
    }

    // ---- the outline ----

    fn flatten(&mut self) {
        fn walk(rows: &[Value], depth: usize, doc: &Option<String>, collapsed: &HashSet<String>, out: &mut Vec<Line>) {
            for (i, r) in rows.iter().enumerate() {
                let id = match s(r, "id") {
                    "" => format!("{depth}.{i}"),
                    id => id.to_string(),
                };
                let open = !collapsed.contains(&id);
                out.push(Line { id: id.clone(), depth, node: r.clone(), doc: if is_doc(r) { None } else { doc.clone() } });
                if open {
                    walk(children_of(r), depth + 1, doc, collapsed, out);
                }
            }
        }
        let mut out = Vec::new();
        if let Some(page) = &self.page {
            walk(&page.rows, 0, &page.doc, &self.collapsed, &mut out);
        }
        self.lines = out;
    }

    /// Tells the list its rows changed. A new page starts at the top; a page that changed under you stays where it was.
    fn is_timeline(&self) -> bool {
        matches!(&self.place, Place::View(id) if id == "timeline")
    }

    fn relist(&mut self, fresh: bool) {
        self.slots = if self.is_timeline() {
            timeline::slots(&self.lines, &self.tl_folded)
        } else {
            std::iter::once(Slot::PageHead).chain((0..self.lines.len()).map(Slot::Row)).collect()
        };
        let count = self.slots.len().max(1);
        if fresh {
            return self.list.reset(count);
        }
        let mut top = self.list.logical_scroll_top();
        self.list.splice(0..self.list.item_count(), count);
        top.item_ix = top.item_ix.min(count - 1);
        self.list.scroll_to(top);
    }

    /// the list item that draws a row
    fn slot_of(&self, line: usize) -> Option<usize> {
        self.slots.iter().position(|s| matches!(s, Slot::Row(i) | Slot::Entry(i) | Slot::Child { ix: i, .. } if *i == line))
    }

    fn reveal(&self) {
        if let Some(ix) = self.slot_of(self.cursor) {
            self.list.scroll_to_reveal_item(ix);
        }
    }

    fn go(&mut self, place: Place, push: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.commit(window, cx);
        if push && place != self.place {
            self.back.push(self.place.clone());
        }
        self.place = place;
        self.keep_cursor = false;
        self.cursor = 0;
        self.keyed = false;
        self.reload(window, cx);
        cx.notify();
    }

    fn go_back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(place) = self.back.pop() {
            self.go(place, false, window, cx);
        }
    }

    fn editable(line: &Line) -> bool {
        line.doc.is_some() && !is_doc(&line.node) && line.node.get("editable") != Some(&Value::Bool(false)) && s(&line.node, "block") != "divider"
    }

    fn edit_at(&mut self, ix: usize, caret: Option<usize>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(line) = self.lines.get(ix).cloned() else { return };
        if !Self::editable(&line) {
            self.editing = None;
            window.focus(&self.focus);
            cx.notify();
            return;
        }
        let t = self.theme();
        let text = s(&line.node, "text").to_string();
        let input = cx.new(|cx| {
            let mut i = TextInput::new(&text, "", caret, cx);
            (i.caret, i.quiet, i.selection) = (t.accent, t.muted, t.select);
            i
        });
        window.focus(&input.focus_handle(cx));
        self.cursor = ix;
        // A row only takes typing once it is painted: the list keeps a focused row drawn even off screen, and once it
        // has been measured it is scrolled into view again (a new row is first revealed at no height).
        if let Some(slot) = self.slot_of(ix) {
            self.list.splice_focusable(slot..slot + 1, [Some(input.focus_handle(cx))]);
        }
        cx.on_next_frame(window, |this, _, cx| {
            this.reveal();
            cx.notify();
        });
        self.editing = Some((line.id, input));
        cx.notify();
    }

    /// A row created or moved by a write is edited once the read after it brings it in.
    fn apply_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((id, caret)) = self.pending_edit.clone() else { return };
        if let Some(ix) = self.lines.iter().position(|l| l.id == id) {
            self.pending_edit = None;
            self.edit_at(ix, Some(caret), window, cx);
            self.reveal();
        }
    }

    /// Leaves the row being edited, writing its words when they changed. Marks on a changed row are not kept (the
    /// spike writes plain text).
    fn commit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some((id, input)) = self.editing.take() else { return };
        window.focus(&self.focus);
        let text = input.read(cx).text();
        let Some(line) = self.lines.iter_mut().find(|l| l.id == id) else { return };
        if s(&line.node, "text") == text {
            return;
        }
        line.node["text"] = json!(text);
        line.node["segments"] = json!([{ "text": text }]);
        // a row the engine has not named yet is written once it has (adopt)
        if let Some(doc) = line.doc.clone().filter(|_| !id.starts_with("pending:")) {
            self.write("setText", json!([doc, id, text]), cx);
        }
    }

    /// The engine named a row the window made on Enter: it takes the id, and what was typed into it meanwhile is written.
    fn adopt(&mut self, temp: &str, id: &str, doc: &str, made_with: &str, cx: &mut Context<Self>) {
        if let Some((editing, _)) = self.editing.as_mut().filter(|(e, _)| e == temp) {
            *editing = id.to_string();
        }
        if let Some(line) = self.lines.iter_mut().find(|l| l.id == temp) {
            line.id = id.to_string();
            line.node["id"] = json!(id);
            let typed = s(&line.node, "text").to_string();
            if typed != made_with {
                self.write("setText", json!([doc, id, typed]), cx);
            }
        }
    }

    fn timed(&self, what: &'static str, window: &mut Window) {
        if self.timing {
            let at = Instant::now();
            window.on_next_frame(move |_, _| eprintln!("[timing] {what}: key to frame {:.1} ms", at.elapsed().as_secs_f64() * 1000.));
        }
    }

    // ---- keys ----

    fn up(&mut self, _: &Up, window: &mut Window, cx: &mut Context<Self>) {
        self.timed("up", window);
        self.keyed = true;
        if let Some(p) = self.palette.as_mut() {
            p.sel = p.sel.saturating_sub(1);
            return cx.notify();
        }
        if self.cursor == 0 {
            return;
        }
        let editing = self.editing.is_some();
        self.commit(window, cx);
        self.cursor -= 1;
        self.reveal();
        if editing {
            self.edit_at(self.cursor, None, window, cx);
        }
        cx.notify();
    }

    fn down(&mut self, _: &Down, window: &mut Window, cx: &mut Context<Self>) {
        self.timed("down", window);
        self.keyed = true;
        if let Some(p) = self.palette.as_mut() {
            p.sel = (p.sel + 1).min(p.items.len().saturating_sub(1));
            return cx.notify();
        }
        if self.cursor + 1 >= self.lines.len() {
            return;
        }
        let editing = self.editing.is_some();
        self.commit(window, cx);
        self.cursor += 1;
        self.reveal();
        if editing {
            self.edit_at(self.cursor, None, window, cx);
        }
        cx.notify();
    }

    fn open(&mut self, _: &Open, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = &self.palette {
            if let Some(item) = p.items.get(p.sel).cloned() {
                self.run(item, window, cx);
            }
            return;
        }
        if let Some((id, input)) = self.editing.clone() {
            // Enter splits the row at the caret, as an outliner does, and goes on in the new row at once: the row is
            // drawn and typed into before the engine answers with its id, so no key typed meanwhile is lost
            let (text, at) = {
                let i = input.read(cx);
                (i.text(), i.caret())
            };
            let Some(ix) = self.lines.iter().position(|l| l.id == id) else { return };
            let Some(doc) = self.lines[ix].doc.clone() else { return };
            let (before, after) = (text[..at].to_string(), text[at..].to_string());
            let call = self.engine.call("split", json!([doc, id, before, after, false]));
            let line = &mut self.lines[ix];
            line.node["text"] = json!(before);
            line.node["segments"] = json!([{ "text": before }]);
            let depth = line.depth;
            let mut node = json!({ "id": "", "kind": "block", "text": after, "segments": [{ "text": after }] });
            if done_of(&line.node).is_some() {
                node["done"] = json!(0);
            }
            let mut end = ix + 1; // the new row goes after this one's children: it is the next sibling
            while end < self.lines.len() && self.lines[end].depth > depth {
                end += 1;
            }
            let temp = format!("pending:{}", rand_id());
            node["id"] = json!(temp);
            self.lines.insert(end, Line { id: temp.clone(), depth, node, doc: Some(doc.clone()) });
            self.relist(false);
            self.editing = None;
            self.edit_at(end, Some(0), window, cx);
            self.reveal();
            self.splitting += 1;
            cx.spawn_in(window, async move |this, cx| {
                let answer = call.await;
                this.update_in(cx, |this, window, cx| {
                    this.splitting -= 1;
                    match answer {
                        Ok(Value::String(new_id)) => this.adopt(&temp, &new_id, &doc, &after, cx),
                        Ok(_) => {}
                        Err(e) => this.toast(e, cx),
                    }
                    if this.splitting == 0 && std::mem::take(&mut this.stale) {
                        this.reload(window, cx);
                    }
                })
                .ok();
            })
            .detach();
            return cx.notify();
        }
        let Some(line) = self.lines.get(self.cursor).cloned() else { return };
        if is_doc(&line.node) {
            self.go(Place::Doc(line.id), true, window, cx);
        } else if Self::editable(&line) {
            self.edit_at(self.cursor, None, window, cx);
        } else if let Some(uri) = line.node.pointer("/timeline/uri").and_then(Value::as_str) {
            self.go(Place::Doc(uri.to_string()), true, window, cx);
        } else {
            self.fold(line.id, window, cx);
        }
    }

    fn back(&mut self, _: &Back, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            return self.close_palette(window, cx);
        }
        if self.editing.is_some() {
            self.commit(window, cx);
            return cx.notify();
        }
        self.go_back(window, cx);
    }

    fn toggle(&mut self, _: &Toggle, window: &mut Window, cx: &mut Context<Self>) {
        self.timed("toggle", window);
        self.toggle_at(self.cursor, cx);
    }

    fn toggle_at(&mut self, ix: usize, cx: &mut Context<Self>) {
        let Some(line) = self.lines.get_mut(ix) else { return };
        let Some(done) = done_of(&line.node) else { return };
        line.node["done"] = json!(if done { 0 } else { 1 }); // drawn now; the engine's answer follows as a push
        let (id, doc, task) = (line.id.clone(), line.doc.clone(), is_doc(&line.node));
        match (task, doc) {
            (true, _) => self.write("setDone", json!([id, !done]), cx),
            (false, Some(doc)) => self.write("toggleCheckbox", json!([doc, id]), cx),
            _ => {}
        }
        cx.notify();
    }

    fn shift(&mut self, method: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(line) = self.lines.get(self.cursor).cloned() else { return };
        let Some(doc) = line.doc.clone().filter(|_| !is_doc(&line.node)) else { return };
        if let Some((_, input)) = &self.editing {
            self.pending_edit = Some((line.id.clone(), input.read(cx).caret()));
        }
        self.commit(window, cx);
        self.keep_cursor = true;
        self.write(method, json!([doc, line.id]), cx);
    }

    fn indent(&mut self, _: &Indent, window: &mut Window, cx: &mut Context<Self>) {
        self.shift("indent", window, cx);
    }

    fn outdent(&mut self, _: &Outdent, window: &mut Window, cx: &mut Context<Self>) {
        self.shift("outdent", window, cx);
    }

    fn fold(&mut self, id: String, _: &mut Window, cx: &mut Context<Self>) {
        if !self.collapsed.remove(&id) {
            self.collapsed.insert(id.clone());
        }
        self.flatten();
        self.relist(false);
        self.cursor = self.lines.iter().position(|l| l.id == id).unwrap_or(self.cursor);
        cx.notify();
    }

    fn collapse(&mut self, _: &Collapse, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.lines.get(self.cursor).filter(|l| !children_of(&l.node).is_empty() && !self.collapsed.contains(&l.id)).map(|l| l.id.clone()) {
            self.fold(id, window, cx);
        }
    }

    fn expand(&mut self, _: &Expand, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.lines.get(self.cursor).filter(|l| self.collapsed.contains(&l.id)).map(|l| l.id.clone()) {
            self.fold(id, window, cx);
        }
    }

    fn undo(&mut self, _: &Undo, window: &mut Window, cx: &mut Context<Self>) {
        self.commit(window, cx);
        self.keep_cursor = true;
        self.write("undo", json!([]), cx);
    }

    fn redo(&mut self, _: &Redo, window: &mut Window, cx: &mut Context<Self>) {
        self.commit(window, cx);
        self.keep_cursor = true;
        self.write("redo", json!([]), cx);
    }

    fn switch_theme(&mut self, _: &SwitchTheme, _: &mut Window, cx: &mut Context<Self>) {
        self.follow_system = false;
        self.dark = !self.dark;
        cx.notify();
    }

    // ---- ⌘K ----

    fn palette(&mut self, _: &Palette, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            return self.close_palette(window, cx);
        }
        self.commit(window, cx);
        let t = self.theme();
        let input = cx.new(|cx| {
            let mut i = TextInput::new("", "Search Tana or run a command", None, cx);
            (i.caret, i.quiet, i.selection) = (t.accent, t.muted, t.select);
            i
        });
        let sub = cx.subscribe(&input, |this, _, _: &InputEvent, cx| this.refilter(cx));
        window.focus(&input.focus_handle(cx));
        self.palette = Some(PaletteState { input, items: vec![], sel: 0, seq: 0, _sub: sub });
        self.refilter(cx);
    }

    fn commands(&self) -> Vec<Item> {
        let mut items: Vec<Item> = self
            .views
            .iter()
            .chain(&self.pinned)
            .map(|(place, title)| Item { title: format!("Go to {title}"), meta: String::new(), act: Act::Go(place.clone()) })
            .collect();
        let other = if self.dark { "light" } else { "dark" };
        items.push(Item { title: format!("Switch to the {other} theme"), meta: "⇧⌘L".into(), act: Act::Theme });
        items.push(Item { title: "Undo".into(), meta: "⌘Z".into(), act: Act::Undo });
        items.push(Item { title: "Redo".into(), meta: "⇧⌘Z".into(), act: Act::Redo });
        items
    }

    fn refilter(&mut self, cx: &mut Context<Self>) {
        let commands = self.commands();
        let Some(p) = self.palette.as_mut() else { return };
        let query = p.input.read(cx).text();
        let q = query.trim().to_lowercase();
        p.items = commands.into_iter().filter(|i| q.is_empty() || i.title.to_lowercase().contains(&q)).collect();
        p.sel = 0;
        p.seq += 1;
        let seq = p.seq;
        cx.notify();
        if q.is_empty() {
            return;
        }
        let call = self.engine.call("search", json!([query]));
        cx.spawn(async move |this, cx| {
            let found = call.await;
            this.update(cx, |this, cx| {
                let Some(p) = this.palette.as_mut().filter(|p| p.seq == seq) else { return };
                for r in found.ok().as_ref().and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                    let meta = [s(r, "meta"), if r.get("related").is_some() { "related" } else { "" }].join(" ");
                    p.items.push(Item { title: title_of(r), meta: meta.trim().to_string(), act: Act::Go(Place::Doc(s(r, "id").to_string())) });
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        window.focus(&self.focus);
        cx.notify();
    }

    fn run(&mut self, item: Item, window: &mut Window, cx: &mut Context<Self>) {
        self.close_palette(window, cx);
        match item.act {
            Act::Go(place) => self.go(place, true, window, cx),
            Act::Theme => self.switch_theme(&SwitchTheme, window, cx),
            Act::Undo => self.undo(&Undo, window, cx),
            Act::Redo => self.redo(&Redo, window, cx),
        }
    }

    // ---- drawing ----

    fn row(&self, ix: usize, line: &Line, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let v = &line.node;
        let heading = v.get("heading").and_then(Value::as_u64);
        let block = s(v, "block");
        let kids = !children_of(v).is_empty();
        let folded = self.collapsed.contains(&line.id) && kids;
        let done = done_of(v);
        let selected = ix == self.cursor && self.palette.is_none();
        let hue = v.get("hue").and_then(Value::as_f64).map(|h| h as f32);
        let size = match heading {
            Some(1) => 24.,
            Some(2) => 20.,
            Some(3) => 17.,
            _ => 16.,
        };
        let id = line.id.clone();
        let line_h = px(size * 1.45);
        let chevron = div()
            .id(("chev", ix))
            .w(px(14.))
            .h(line_h)
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(9.))
            .text_color(t.muted)
            .when(kids, |d| {
                d.child(if folded { "▶" } else { "▼" })
                    .when(!folded, |d| d.opacity(0.).group_hover("row", |s| s.opacity(1.)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.fold(id.clone(), window, cx)
                    }))
            });
        let marker = match done {
            Some(done) => div()
                .id(("check", ix))
                .size(px(15.))
                .rounded(px(4.))
                .border_1()
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(11.))
                .text_color(white())
                .map(|d| if done { d.bg(t.green).border_color(t.green).child("✓") } else { d.border_color(t.faint) })
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.toggle_at(ix, cx)
                }))
                .into_any_element(),
            None if block == "divider" => div().into_any_element(),
            None => {
                let dot = hue.map(|h| oklch(if t.dark { 0.72 } else { 0.62 }, 0.13, h)).unwrap_or(if t.dark { t.muted } else { rgb(0x9a9a9a).into() });
                div()
                    .size(px(16.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(folded, |d| d.bg(t.line))
                    .child(div().size(px(6.)).rounded_full().bg(dot))
                    .into_any_element()
            }
        };
        let editing = self.editing.as_ref().filter(|(id, _)| *id == line.id).map(|(_, input)| input.clone());
        let words: AnyElement = match editing {
            Some(input) => div().flex_1().min_w_0().overflow_hidden().child(input).into_any_element(),
            None if block == "divider" => div().flex_1().h(px(1.)).bg(t.line).into_any_element(),
            None => div()
                .flex_1()
                .min_w_0()
                .when(block == "quote", |d| d.border_l_2().border_color(t.faint).pl(px(10.)).italic())
                .when(block == "code", |d| d.font_family("Menlo").text_size(px(13.)).bg(t.chip).px(px(6.)).rounded(px(4.)))
                .when(done == Some(true), |d| d.text_color(t.muted).line_through())
                .child(rich(v, t))
                .into_any_element(),
        };
        let tags: Vec<AnyElement> = v
            .get("tags")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|tag| {
                let (bg, fg) = match tag.get("hue").and_then(Value::as_f64) {
                    Some(h) => (oklch(if t.dark { 0.32 } else { 0.95 }, 0.04, h as f32), oklch(if t.dark { 0.8 } else { 0.5 }, 0.12, h as f32)),
                    None => (t.chip, t.muted),
                };
                div().flex_none().px(px(5.)).rounded(px(4.)).bg(bg).text_color(fg).text_size(px(12.)).line_height(px(20.)).child(format!("# {}", s(tag, "label"))).into_any_element()
            })
            .collect();
        let meta = [s(v, "meta"), s(v, "subtext")].into_iter().find(|m| !m.is_empty()).unwrap_or("").to_string();
        div()
            .id(("row", ix))
            .group("row")
            .w_full()
            .flex()
            .items_start() // the bullet sits on the first line of a row that wraps
            .gap(px(6.))
            .min_h(px(30.))
            .py(px(3.))
            .pl(px(line.depth as f32 * 26.))
            .pr(px(8.))
            .rounded(px(5.))
            .text_size(px(size))
            .line_height(line_h)
            .when(heading.is_some(), |d| d.font_weight(FontWeight::BOLD).mt(px(8.)))
            .when(selected, |d| d.bg(t.select))
            .child(chevron)
            .child(div().w(px(18.)).h(line_h).flex_none().flex().items_center().justify_center().child(marker))
            .child(words)
            .children(tags)
            .when(!meta.is_empty(), |d| d.child(div().flex_none().text_size(px(13.)).text_color(t.muted).child(meta)))
            .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                this.commit(window, cx);
                this.cursor = ix;
                if ev.click_count() >= 2 || this.lines.get(ix).is_some_and(Self::editable) {
                    this.open(&Open, window, cx);
                }
                cx.notify();
            }))
            .into_any_element()
    }

    fn palette_card(&self, p: &PaletteState, t: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let items: Vec<_> = p
            .items
            .iter()
            .take(12)
            .enumerate()
            .map(|(i, item)| {
                let run = item.clone();
                div()
                    .id(("item", i))
                    .flex()
                    .justify_between()
                    .gap(px(12.))
                    .px(px(14.))
                    .py(px(7.))
                    .rounded(px(6.))
                    .text_size(px(14.))
                    .when(i == p.sel, |d| d.bg(t.select))
                    .child(div().truncate().child(item.title.clone()))
                    .child(div().flex_none().text_color(t.muted).text_size(px(12.)).child(item.meta.clone()))
                    .on_click(cx.listener(move |this, _, window, cx| this.run(run.clone(), window, cx)))
            })
            .collect();
        div()
            .absolute()
            .inset_0()
            .bg(t.scrim)
            .flex()
            .justify_center()
            .items_start()
            .pt(px(90.))
            .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| this.close_palette(window, cx)))
            .child(
                div()
                    .w(px(580.))
                    .bg(t.surface)
                    .rounded(px(12.))
                    .shadow_lg()
                    .border_1()
                    .border_color(t.line)
                    .p(px(6.))
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().px(px(12.)).py(px(10.)).text_size(px(17.)).line_height(px(24.)).child(p.input.clone()))
                    .child(div().h(px(1.)).bg(t.line).mb(px(6.)))
                    .children(items)
                    .when(p.items.is_empty(), |d| d.child(div().px(px(14.)).py(px(8.)).text_size(px(14.)).text_color(t.muted).child("Nothing matches"))),
            )
    }

    fn list_item(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        if self.is_timeline() {
            return self.tl_slot(ix, cx);
        }
        let t = self.theme();
        let last = ix + 1 == self.slots.len();
        match self.slots.get(ix).cloned() {
            Some(Slot::Row(i)) => {
                let line = self.lines[i].clone();
                let row = self.row(i, &line, &t, cx);
                div().px(px(36.)).when(last, |d| d.pb(px(160.))).child(row).into_any_element()
            }
            _ => {
                let meta = self.page.as_ref().map(|p| p.meta.clone()).unwrap_or_default();
                let empty = self.lines.is_empty() && self.page.is_some();
                div()
                    .pt(px(4.))
                    .pb(px(12.))
                    .pl(px(32.))
                    .when(!meta.is_empty(), |d| d.child(div().text_size(px(13.)).text_color(t.muted).child(meta)))
                    .when(empty, |d| d.child(div().mt(px(24.)).text_size(px(15.)).text_color(t.muted).child("Nothing here yet. ⌘K finds something to open.")))
                    .into_any_element()
            }
        }
    }

    /// The window's header (shell.css .head): 38px over the whole width, the traffic lights at its left, the app's
    /// switches at its right — Work View, sensitive items, ⌘K, Help — each a 24px button at half opacity.
    fn header(&self, t: &Theme, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let button = |id: &'static str, icon: &'static str| {
            div()
                .id(id)
                .size(px(24.))
                .flex_none()
                .rounded(px(4.))
                .flex()
                .items_center()
                .justify_center()
                .opacity(0.5)
                .hover(|d| d.bg(t.head_hover).opacity(1.))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(svg().path(format!("{icon}.svg")).size(px(18.)).text_color(t.head_btn))
        };
        div()
            .h(px(38.))
            .w_full()
            .flex_none()
            .bg(t.head_bg)
            .flex()
            .items_center()
            .justify_end()
            .gap(px(2.))
            .pl(px(80.))
            .pr(px(12.))
            .on_mouse_down(MouseButton::Left, |ev: &MouseDownEvent, window, _| {
                if ev.click_count >= 2 { window.titlebar_double_click() } else { window.start_window_move() }
            })
            .child(button("head-home", "home").on_click(cx.listener(|this, _, window, cx| this.go(Place::View("timeline".into()), true, window, cx))))
            .child(button("head-sensitive", "hidden"))
            .child(button("head-palette", "command").on_click(cx.listener(|this, _, window, cx| this.palette(&Palette, window, cx))))
            .child(button("head-help", "help"))
    }
}

async fn load(engine: &Engine, place: &Place, title: String) -> Result<Page, String> {
    let list = |v: Value| v.as_array().cloned().unwrap_or_default();
    match place {
        Place::View(id) if id == "timeline" => {
            let rows = engine.call("children", json!(["orbital:timeline"])).await?;
            let pins = engine.call("pinDates", json!([])).await.ok().and_then(|p| serde_json::from_value(p).ok()).unwrap_or_default();
            Ok(Page { title: "Timeline".into(), meta: String::new(), rows: list(rows), doc: None, pins })
        }
        Place::View(id) => {
            let filter = engine.call("viewFilter", json!([id])).await?;
            let found = engine.call("viewList", json!([id, filter])).await?;
            let rows = list(found["nodes"].clone());
            Ok(Page { title, meta: format!("{} items", rows.len()), rows, doc: None, pins: HashMap::new() })
        }
        Place::Doc(id) => {
            let info = engine.call("node", json!([id])).await?;
            let rows = engine.call("children", json!([id])).await?;
            let tags: Vec<String> = info["tags"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().map(|t| format!("#{}", s(t, "label"))).collect();
            let meta = [tags.join(" "), s(&info, "meta").to_string()].into_iter().filter(|m| !m.is_empty()).collect::<Vec<_>>().join("  ·  ");
            Ok(Page { title: title_of(&info), meta, rows: list(rows), doc: Some(id.clone()), pins: HashMap::new() })
        }
    }
}

fn rand_id() -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(Instant::now())
}

impl Render for Orbital {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = self.theme();
        let palette = self.palette.as_ref().map(|p| self.palette_card(p, &t, cx));
        let note = self.note.as_ref().map(|(_, n)| n.clone());
        let title = self.page.as_ref().map(|p| p.title.clone()).unwrap_or_default();
        let shadow = |c: u32, y: f32, blur: f32, spread: f32| BoxShadow { color: rgba(c).into(), offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(spread) };
        let create_shadow = if t.dark {
            vec![shadow(0x00000073, 6., 24., 0.), shadow(0xffffff14, 0., 0., 1.)]
        } else {
            vec![shadow(0x0000001a, 6., 24., 0.), shadow(0x0000000f, 1., 3., 0.), shadow(0x0000000f, 0., 0., 1.)]
        };
        div()
            .id("orbital")
            .key_context("Orbital")
            .track_focus(&self.focus)
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::open))
            .on_action(cx.listener(Self::back))
            .on_action(cx.listener(Self::toggle))
            .on_action(cx.listener(Self::indent))
            .on_action(cx.listener(Self::outdent))
            .on_action(cx.listener(Self::palette))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::collapse))
            .on_action(cx.listener(Self::expand))
            .on_action(cx.listener(Self::switch_theme))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .bg(t.bg)
            .text_color(t.fg)
            .font_family(".SystemUIFont")
            .text_size(px(16.))
            .child(self.header(&t, cx))
            // the page's title bar (styles.css .titlebar): 18px over the title, 32px in, 6px under it; it does not scroll
            .child(
                div()
                    .flex_none()
                    .pt(px(19.5)) // 18px in CSS; GPUI centres a 34px line 1.5px higher in its 40px than Chromium does
                    .px(px(32.))
                    .pb(px(4.5))
                    .child(div().text_size(px(34.)).line_height(px(40.)).font_weight(FontWeight::BOLD).text_color(t.title).overflow_hidden().child(tracked::tracked(title, -0.5))),
            )
            .child(div().flex_1().min_h_0().child(list(self.list.clone(), cx.processor(|this, ix: usize, _, cx| this.list_item(ix, cx))).size_full()))
            // Create new (shell.css .create): a round button floating in the window's corner
            .child(
                div()
                    .id("create")
                    .absolute()
                    .right(px(20.))
                    .bottom(px(20.))
                    .size(px(40.))
                    .rounded_full()
                    .bg(t.create_bg)
                    .shadow(create_shadow)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(svg().path("textPlus.svg").size(px(16.)).text_color(t.create_fg)),
            )
            .children(palette)
            .children(note.map(|n| {
                div().absolute().bottom(px(24.)).left_0().right_0().flex().justify_center().child(
                    div().px(px(14.)).py(px(8.)).rounded(px(8.)).bg(t.surface).border_1().border_color(t.line).shadow_md().text_size(px(13.)).child(n),
                )
            }))
    }
}

fn main() {
    let started = Instant::now();
    Application::new().with_assets(icons::Icons).run(move |cx: &mut App| {
        input::bind_keys(cx);
        let c = Some("Orbital");
        cx.bind_keys([
            KeyBinding::new("up", Up, c),
            KeyBinding::new("down", Down, c),
            KeyBinding::new("enter", Open, c),
            KeyBinding::new("escape", Back, c),
            KeyBinding::new("cmd-[", Back, c),
            KeyBinding::new("cmd-enter", Toggle, c),
            KeyBinding::new("tab", Indent, c),
            KeyBinding::new("shift-tab", Outdent, c),
            KeyBinding::new("cmd-k", Palette, c),
            KeyBinding::new("cmd-z", Undo, c),
            KeyBinding::new("cmd-shift-z", Redo, c),
            KeyBinding::new("cmd-up", Collapse, c),
            KeyBinding::new("cmd-down", Expand, c),
            KeyBinding::new("cmd-shift-l", SwitchTheme, c),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.set_menus(vec![Menu { name: "Orbital".into(), items: vec![MenuItem::action("Quit Orbital", Quit)] }]);
        let (engine, pushes) = Engine::start().expect("could not start the engine (node gpui/sidecar.js)");
        let (w, h) = std::env::var("ORBITAL_SIZE").ok().and_then(|s| s.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?)))).unwrap_or((1100., 760.));
        let bounds = Bounds::centered(None, size(px(w), px(h)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // where Electron's hiddenInset puts them in Orbital's window, measured: the close button at 12, 11
            titlebar: Some(TitlebarOptions { title: Some("Orbital".into()), appears_transparent: true, traffic_light_position: Some(point(px(12.), px(11.))) }),
            ..Default::default()
        };
        cx.open_window(options, |window, cx| cx.new(|cx| Orbital::new(engine, pushes, started, window, cx))).expect("window");
        cx.activate(true);
    });
}
