//! Local time for the Timeline, as the page reads it with toLocaleDateString / toLocaleTimeString: the day an entry
//! falls on, its HH:MM (24-hour), and what "now" is. The machine's own time zone, through localtime_r.
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Local {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub weekday: u32,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// "2026-10-03T06:37:29.962Z" (or any offset-free UTC ISO time) as milliseconds since the epoch
pub fn parse_iso(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let ms = if b.get(19) == Some(&b'.') { iso[20..].trim_end_matches('Z').get(..3).and_then(|f| format!("{f:0<3}").parse::<i64>().ok()).unwrap_or(0) } else { 0 };
    // days from the civil date (Howard Hinnant's algorithm)
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms)
}

pub fn local(ms: i64) -> Local {
    let t: libc::time_t = (ms.div_euclid(1000)) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&t, &mut tm) };
    Local { year: tm.tm_year + 1900, month: tm.tm_mon as u32 + 1, day: tm.tm_mday as u32, hour: tm.tm_hour as u32, minute: tm.tm_min as u32, weekday: tm.tm_wday as u32 }
}

pub fn day_key(ms: i64) -> String {
    let l = local(ms);
    format!("{:04}-{:02}-{:02}", l.year, l.month, l.day)
}

pub fn hhmm(ms: i64) -> String {
    let l = local(ms);
    format!("{:02}:{:02}", l.hour, l.minute)
}

/// renderer/timeline.js timelineDay: Today, Yesterday, then the weekday and date
pub fn day_title(key: &str) -> String {
    let now = now_ms();
    if key == day_key(now) {
        return "Today".into();
    }
    if key == day_key(now - 86_400_000) {
        return "Yesterday".into();
    }
    let Some(ms) = parse_iso(&format!("{key}T12:00:00Z")) else { return key.into() };
    let l = local(ms);
    const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    format!("{} {} {}", DAYS[l.weekday as usize % 7], l.day, MONTHS[(l.month as usize + 11) % 12])
}

/// renderer/document.js pinDateLabel
pub fn pin_date_label(date: &str) -> String {
    let now = now_ms();
    let near = if date == day_key(now) { "Today" } else if date == day_key(now + 86_400_000) { "Tomorrow" } else if date == day_key(now - 86_400_000) { "Yesterday" } else { "" };
    if near.is_empty() { date.into() } else { format!("{near} · {date}") }
}
