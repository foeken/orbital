//! The Timeline page drawn as the web page draws it (renderer/timeline.js, styles.css "Timeline"): a time column, a rail
//! down the page with a marker per entry, the entry's words with a grey line under them, and the rows an entry lists
//! hanging under its words. Every offset here was measured off the web page in Chromium (gpui/README.md): the node box
//! starts 16px in (the scroll's padding), the rail sits 101px into it, the words 126px.
use crate::time;
use crate::{Line, Orbital, Place, Slot, Theme, done_of, s};
use gpui::prelude::FluentBuilder;
use gpui::*;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const RAIL: f32 = 101.;
const WORDS: f32 = 126.;
const KIDS: f32 = 132.;

fn tl<'a>(v: &'a Value) -> &'a Value {
    v.get("timeline").unwrap_or(&Value::Null)
}
fn flag(v: &Value, key: &str) -> bool {
    let x = &tl(v)[key];
    !x.is_null() && *x != Value::Bool(false)
}
fn created(v: &Value) -> i64 {
    time::parse_iso(s(v, "createdAt")).unwrap_or_else(time::now_ms)
}

/// renderer/timeline.js timelineTopEnds: the rule under the blocks at the top (Today's Tasks, free time, Upcoming meetings)
fn top_ends(n: &Value, next: Option<&Value>) -> bool {
    (flag(n, "today") || flag(n, "free") || flag(n, "upcoming")) && !next.is_some_and(|x| flag(x, "free") || flag(x, "upcoming"))
}

/// The page's rows in the order they are drawn: a heading per local day (renderer/timeline.js timelineGroups), each
/// entry, the rows it lists, Add more under today's tasks, the rule after the top blocks, and Show three more days.
pub fn slots(lines: &[Line], folded: &HashSet<String>) -> Vec<Slot> {
    let mut out = Vec::new();
    let entries: Vec<usize> = (0..lines.len()).filter(|&i| lines[i].depth == 0).collect();
    let (mut day, mut first, mut after_rule) = (None::<String>, true, false);
    for (k, &e) in entries.iter().enumerate() {
        let n = &lines[e].node;
        let key = time::day_key(created(n));
        if day.as_deref() != Some(&key) {
            // the scroll's own 4px over the first; a heading under the rule gives up its 18px (styles.css .tl-divider + .ghead)
            out.push(Slot::DayHead { title: time::day_title(&key), top: if first { 4. } else if after_rule { 0. } else { 18. }, open: !folded.contains(&key), key: key.clone() });
            day = Some(key.clone());
            first = false;
        }
        after_rule = false;
        if folded.contains(&key) {
            continue;
        }
        out.push(Slot::Entry(e));
        let end = entries.get(k + 1).copied().unwrap_or(lines.len());
        let kids: Vec<usize> = (e + 1..end).filter(|&i| lines[i].depth == 1).collect();
        let boxes = kids.iter().any(|&i| done_of(&lines[i].node).is_some());
        let today = flag(n, "today");
        for (j, &c) in kids.iter().enumerate() {
            out.push(Slot::Child { ix: c, last: j + 1 == kids.len() && !today, boxes });
        }
        if today {
            out.push(Slot::AddMore);
        }
        if top_ends(n, entries.get(k + 1).map(|&x| &lines[x].node)) {
            out.push(Slot::Divider);
            after_rule = true;
        }
    }
    if !lines.is_empty() {
        out.push(Slot::Older);
    }
    out
}

/// renderer/timeline.js timelineFreeSegs: "No meetings for 45 more minutes", in whole minutes rounded up
fn free_segments(free: &Value) -> Value {
    let (from, until) = (free["from"].as_f64().unwrap_or(0.) as i64, free["until"].as_f64().unwrap_or(0.) as i64);
    let now = time::now_ms();
    let later = from > now;
    let more = if later { "" } else { "more " };
    let m = ((until - now.max(from)) as f64 / 6e4).ceil().max(1.) as i64;
    let h = m / 60;
    let unit = |n: i64, w: &str| format!("{n} {w}{}", if n == 1 { "" } else { "s" });
    let mins = |n: i64| if n == 1 { "minute" } else { "minutes" };
    let left = if m < 60 {
        format!("{m} {more}{}", mins(m))
    } else if m % 60 != 0 {
        format!("{} and {} {more}{}", unit(h, "hour"), m % 60, mins(m % 60))
    } else {
        format!("{h} {more}{}", if h == 1 { "hour" } else { "hours" })
    };
    let mut segs = vec![json!({ "text": "No meetings for " }), json!({ "text": left, "marks": { "bold": true } })];
    if later {
        segs.push(json!({ "text": " after this one" }));
    }
    Value::Array(segs)
}

/// The words of a row as GPUI runs: bold is the page's <strong> (700), a struck part greys as .tl-done s does
fn words(v: &Value, muted: Hsla) -> StyledText {
    let fallback = vec![json!({ "text": s(v, "text") })];
    let free = tl(v).get("free").filter(|f| f.is_object()).map(free_segments);
    let segs: Vec<Value> = match (free, v.get("segments").and_then(Value::as_array)) {
        (Some(Value::Array(f)), _) => f,
        (_, Some(segs)) if !segs.is_empty() => segs.clone(),
        _ => fallback,
    };
    let (mut text, mut runs) = (String::new(), Vec::new());
    for seg in &segs {
        let piece = seg.get("mention").or_else(|| seg.get("reference")).map(|r| s(r, "label")).unwrap_or_else(|| s(seg, "text"));
        if piece.is_empty() {
            continue;
        }
        let start = text.len();
        text.push_str(piece);
        let on = |k: &str| seg.get("marks").and_then(|m| m.get(k)).is_some_and(|x| !x.is_null() && *x != Value::Bool(false));
        let mut style = HighlightStyle::default();
        if on("bold") {
            style.font_weight = Some(FontWeight::BOLD);
        }
        if on("italic") {
            style.font_style = Some(FontStyle::Italic);
        }
        if on("strike") {
            style.strikethrough = Some(StrikethroughStyle { thickness: px(1.), color: Some(muted) });
            style.color = Some(muted);
        }
        if style != HighlightStyle::default() {
            runs.push((start..text.len(), style));
        }
    }
    StyledText::new(text).with_highlights(runs)
}

/// renderer/nodes.js iconSvg: a meeting is drawn with the calendar, and a name with no glyph draws nothing
fn glyph(name: &str, size: f32, color: Hsla) -> AnyElement {
    let name = if name == "meeting" { "calendar" } else { name };
    let plain = name.trim_end_matches("@bold");
    if !crate::icons::has(plain) {
        return div().size(px(size)).flex_none().into_any_element();
    }
    svg().path(format!("{name}.svg")).size(px(size)).flex_none().text_color(color).into_any_element()
}

fn tabular(mut d: Div) -> Div {
    d.text_style().get_or_insert_with(Default::default).font_features = Some(FontFeatures(Arc::new(vec![("tnum".into(), 1)])));
    d
}

/// renderer/tasks.js facesEls: a bubble each for the first four people, then "+n" up to nine
fn faces(people: &[Value], t: &Theme) -> Div {
    let face = |label: String, bg: Hsla, fg: Hsla| {
        div()
            .size(px(18.))
            .flex_none()
            .rounded_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(bg)
            .text_color(fg)
            .text_size(px(8.))
            .line_height(px(8.))
            .font_weight(FontWeight(650.))
            .shadow(vec![BoxShadow { color: t.bg, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(1.5) }])
            .child(label)
    };
    let mut row = div().flex().flex_none();
    for (i, p) in people.iter().take(4).enumerate() {
        let (uri, name) = (s(p, "uri"), s(p, "name"));
        let initials: String = name.split_whitespace().filter_map(|w| w.chars().next()).take(2).collect::<String>().to_uppercase();
        let tone = uri.encode_utf16().fold(0u32, |t, c| (t * 31 + c as u32) % 6) as f32;
        let l = if t.dark { 0.28 + tone * 0.015 } else { 0.89 + tone * 0.012 };
        row = row.child(face(initials, crate::oklch(l, 0., 0.), t.face_text).when(i > 0, |d| d.ml(px(-2.))));
    }
    let rest = people.len() as i64 - 4;
    if rest > 0 && people.len() <= 9 {
        row = row.child(face(format!("+{rest}"), t.face_more, t.face_text).ml(px(-2.)));
    }
    row
}

/// renderer/views.js subtextOf for a Timeline row: main's own line, the entry's note, then the days it is pinned to;
/// the people after it (renderer/tasks.js peopleEl)
fn subtext(v: &Value, pins: &HashMap<String, Vec<String>>, t: &Theme) -> Option<Div> {
    let mut bits: Vec<String> = Vec::new();
    if !s(v, "subtext").is_empty() {
        bits.push(s(v, "subtext").into());
    }
    if !s(tl(v), "note").is_empty() {
        bits.push(s(tl(v), "note").into());
    }
    if let Some(dates) = pins.get(s(v, "id")).filter(|d| !d.is_empty()) {
        let mut dates = dates.clone();
        dates.sort();
        bits.push(format!("Pinned to {}", dates.iter().map(|d| time::pin_date_label(d)).collect::<Vec<_>>().join(", ")));
    }
    let people = v.get("people").and_then(Value::as_array).filter(|p| !p.is_empty());
    if bits.is_empty() && people.is_none() {
        return None;
    }
    let mut words = bits.join(" · ");
    if people.is_some() && !words.is_empty() {
        words.push_str(" · ");
    }
    Some(
        div()
            .flex()
            .items_center()
            // the faces' -4px vertical-align makes the line 25px, its words and faces 1px above its centre
            .h(px(if people.is_some() { 23. } else { 18. }))
            .when(people.is_some(), |d| d.mb(px(2.)))
            .text_size(px(14.))
            .line_height(px(18.))
            .text_color(t.muted)
            .when(!words.is_empty(), |d| d.child(div().whitespace_nowrap().child(words)))
            .when_some(people, |d, p| d.child(faces(p, t))),
    )
}

fn rail(t: &Theme, top: f32) -> Div {
    div().absolute().left(px(16. + RAIL)).top(px(top)).bottom_0().w(px(1.)).bg(t.rail) // 16px: the scroll's padding
}

fn join(t: &Theme) -> Div {
    div().w(px(24.)).h(px(22.)).mt(px(2.)).flex_none().flex().items_center().justify_center().opacity(0.45).child(glyph("tana", 16., t.marker))
}

/// renderer/meeting.js meetingLinkEl: a task that came from a meeting says so with a faint glyph after its title
fn meeting_link(t: &Theme) -> Div {
    let color: Hsla = if t.dark { t.marker } else { rgb(0x8a8a8a).into() };
    div().w(px(24.)).h(px(22.)).ml(px(2.)).mt(px(2.)).flex_none().flex().items_center().justify_center().opacity(0.45).child(glyph("meeting", 16., color))
}

impl Orbital {
    pub(crate) fn tl_slot(&mut self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let t = self.theme();
        let Some(slot) = self.slots.get(ix).cloned() else { return div().into_any_element() };
        let node = |d: Div| d.relative().w_full().pl(px(16.)).pr(px(32.));
        match slot {
            Slot::DayHead { key, title, top, open } => node(div())
                .pt(px(top))
                .pb(px(10.))
                .child(
                    div()
                        .id(SharedString::from(format!("day-{key}")))
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .pl(px(3.))
                        .pr(px(6.))
                        .py(px(10.))
                        .w(px(200.))
                        .text_size(px(12.))
                        .line_height(px(15.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(t.muted)
                        .child(
                            svg()
                                .path("chevronRight.svg")
                                .size(px(12.))
                                .flex_none()
                                .text_color(t.muted)
                                .when(open, |g| g.with_transformation(Transformation::rotate(radians(std::f32::consts::FRAC_PI_2)))),
                        )
                        .child(crate::tracked::tracked(title.to_uppercase(), 0.72))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.tl_folded.remove(&key) {
                                this.tl_folded.insert(key.clone());
                            }
                            this.relist(false);
                            cx.notify();
                        })),
                )
                .into_any_element(),
            Slot::Divider => node(div()).h(px(25.)).child(div().absolute().left(px(16.)).right(px(32.)).top(px(16.)).h(px(1.)).bg(t.rail)).into_any_element(),
            Slot::Older => node(div())
                .mt(px(18.))
                .mb(px(48.)) // 8px, then the scroll's own 40px under it
                .child(
                    div()
                        .id("older")
                        .pl(px(127.))
                        .py(px(4.))
                        .text_size(px(14.))
                        .line_height(px(17.))
                        .text_color(t.muted)
                        .hover(|d| d.text_color(t.accent))
                        .child(if self.tl_loading { "Loading…" } else { "Show three more days" })
                        .on_click(cx.listener(|this, _, window, cx| this.tl_older(window, cx))),
                )
                .into_any_element(),
            Slot::AddMore => node(div())
                .pb(px(8.))
                .child(rail(&t, 0.))
                .child(div().pl(px(KIDS + 6.)).mt(px(2.)).py(px(4.)).text_size(px(14.)).line_height(px(17.)).text_color(t.muted).child("Add more"))
                .into_any_element(),
            Slot::Entry(i) => self.tl_entry(i, &t, cx),
            Slot::Child { ix, last, boxes } => self.tl_child(ix, last, boxes, &t, cx),
            Slot::PageHead | Slot::Row(_) => div().into_any_element(),
        }
    }

    fn tl_entry(&mut self, i: usize, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let line = &self.lines[i];
        let v = &line.node;
        let tone = s(tl(v), "tone");
        let quiet = matches!(tone, "new" | "faint");
        let heading = flag(v, "today") || flag(v, "upcoming");
        let icon = s(v, "icon");
        let color = if quiet && !heading { t.muted } else if heading { t.fg } else { t.entry };
        let time = match tl(v).get("time").and_then(Value::as_str) {
            Some(time) => time.to_string(),
            None => time::hhmm(created(v)),
        };
        let marker_color = if flag(v, "recording") {
            t.accent_live
        } else if quiet && matches!(icon, "robot" | "tana") {
            t.marker_robot_new
        } else if quiet {
            t.marker_new
        } else {
            t.marker
        };
        let marker: AnyElement = if tone == "done" {
            div().absolute().left(px(91.)).top(px(16.)).size(px(20.)).rounded_full().bg(t.done).flex().items_center().justify_center().child(glyph("apply@bold", 12., white())).into_any_element()
        } else if matches!(icon, "updated" | "robot" | "tana" | "meeting" | "pinRoute") {
            div().absolute().left(px(92.)).top(px(17.)).size(px(18.)).rounded_full().bg(t.bg).child(glyph(icon, 18., marker_color)).into_any_element()
        } else {
            div().absolute().left(px(89.75)).top(px(14.75)).size(px(22.5)).rounded_full().bg(t.bg).child(glyph(icon, 22.5, marker_color)).into_any_element()
        };
        let detail = [s(tl(v), "change"), s(tl(v), "detail")];
        let has_detail = detail.iter().any(|d| !d.is_empty());
        let selected = self.keyed && self.cursor == i && self.palette.is_none();
        let uri = s(tl(v), "uri").to_string();
        div()
            .id(("entry", i))
            .relative()
            .w_full()
            .pl(px(16.))
            .pr(px(32.))
            .child(rail(t, if flag(v, "today") { 26. } else { 0. }))
            .when(selected, |d| d.child(div().absolute().left(px(6.)).right(px(32.)).top_0().bottom_0().rounded(px(6.)).bg(t.select)))
            .child(tabular(div()).absolute().left(px(40.)).top(px(14.)).text_size(px(14.)).line_height(px(24.)).text_color(t.muted).child(time))
            .when(v.get("unread") == Some(&Value::Bool(true)), |d| d.child(div().absolute().left(px(90.)).top(px(23.)).size(px(6.)).rounded_full().bg(t.unread)))
            .child(div().absolute().left(px(16.)).top_0().child(marker))
            .child(
                div()
                    .pl(px(WORDS))
                    .pt(px(14.))
                    .pb(px(14.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .items_start()
                            .text_size(px(16.))
                            .line_height(px(24.))
                            .text_color(color)
                            .child(div().min_w_0().child(words(v, t.muted)))
                            .when(v.get("join").is_some_and(|j| !j.is_null()), |d| d.child(join(t))),
                    )
                    .when_some(subtext(v, &self.pins, t), |d, sub| d.child(sub.mt(px(2.))))
                    .when(has_detail, |d| {
                        d.child(
                            div()
                                .mt(px(18.))
                                .mb(px(-6.))
                                .ml(px(8.))
                                .max_w(px(640.))
                                .py(px(6.))
                                .px(px(12.))
                                .border_l(px(3.))
                                .border_color(t.detail_border)
                                .rounded_r(px(6.))
                                .bg(t.detail_bg)
                                .text_size(px(15.))
                                .line_height(px(21.))
                                .text_color(t.detail_text)
                                .when(!detail[0].is_empty(), |d| d.child(div().font_weight(FontWeight::SEMIBOLD).text_color(t.detail_strong).child(detail[0].to_string())))
                                .when(!detail[1].is_empty(), |d| d.child(detail[1].to_string())),
                        )
                    }),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.cursor = i;
                if !uri.is_empty() {
                    this.go(Place::Doc(uri.clone()), true, window, cx);
                }
            }))
            .into_any_element()
    }

    fn tl_child(&mut self, i: usize, last: bool, boxes: bool, t: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let line = &self.lines[i];
        let v = &line.node;
        let done = done_of(v);
        let id = line.id.clone();
        let icon = match s(v, "icon") {
            "" => "doc",
            icon => icon,
        };
        let selected = self.keyed && self.cursor == i && self.palette.is_none();
        let check = done.map(|on| {
            div()
                .id(("check", i))
                .size(px(18.))
                .mt(px(3.))
                .ml(px(2.))
                .mr(px(8.))
                .flex_none()
                .rounded(px(5.))
                .bg(if on { t.check_on } else { t.check })
                .when(on, |d| d.child(svg().path("tick.svg").size(px(18.)).text_color(white())))
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.toggle_at(i, cx)
                }))
        });
        let has_check = check.is_some();
        div()
            .id(("child", i))
            .relative()
            .w_full()
            .pl(px(16.))
            .pr(px(32.))
            .when(last, |d| d.pb(px(8.)))
            .child(rail(t, 0.))
            .when(selected, |d| d.child(div().absolute().left(px(16. + KIDS - 6.)).right(px(32.)).top_0().bottom_0().rounded(px(6.)).bg(t.select)))
            .child(
                div()
                    .pl(px(KIDS))
                    .py(px(1.))
                    .flex()
                    .items_start()
                    .child(
                        div()
                            .w(px(18.))
                            .h(px(24.))
                            .pt(px(4.))
                            .flex_none()
                            .when(!boxes, |d| d.ml(px(3.)).mr(px(2.)))
                            .when(boxes && !has_check, |d| d.mr(px(23.)))
                            .child(glyph(icon, 16., t.marker)),
                    )
                    .children(check)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .when(!has_check, |d| d.pl(px(5.)))
                            .child(
                                div()
                                    .flex()
                                    .items_start()
                                    .text_size(px(15.))
                                    .line_height(px(24.))
                                    .text_color(if done == Some(true) { t.muted } else { t.entry })
                                    .child(div().min_w_0().when(done == Some(true), |d| d.line_through()).child(words(v, t.muted)))
                                    .when(v.get("join").is_some_and(|j| !j.is_null()), |d| d.child(join(t)))
                                    .when(v.get("join").is_none_or(Value::is_null) && v.get("meeting").is_some_and(Value::is_object), |d| d.child(meeting_link(t))),
                            )
                            .when_some(subtext(v, &self.pins, t), |d, sub| d.child(sub)),
                    ),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.cursor = i;
                this.go(Place::Doc(id.clone()), true, window, cx);
            }))
            .into_any_element()
    }

    pub(crate) fn tl_older(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.tl_loading {
            return;
        }
        self.tl_loading = true;
        self.tl_pages += 1;
        let call = self.engine.call("timelinePages", json!([self.tl_pages]));
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let _ = call.await;
            this.update_in(cx, |this, window, cx| {
                this.tl_loading = false;
                this.keep_cursor = true;
                this.reload(window, cx);
            })
            .ok();
        })
        .detach();
    }
}
