//! Bounded monitor output policy: per-window/lifetime admission, line limits,
//! and the small tail retained for task-control reads.

use std::time::{Duration, Instant};

const MAX_BUFFERED_LINES: usize = 200;
const MAX_LINE_BYTES: usize = 4 * 1024;
const MAX_LINES_TOTAL: u32 = 10_000;
pub(super) const MAX_LINES_PER_WINDOW: u32 = 120;
const VOLUME_WINDOW: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub(super) struct MonitorOutput {
    lines: Vec<String>,
    emitted: u32,
    window_started: Instant,
    window_count: u32,
}

impl MonitorOutput {
    pub(super) fn new(now: Instant) -> Self {
        Self {
            lines: Vec::new(),
            emitted: 0,
            window_started: now,
            window_count: 0,
        }
    }

    /// Bound and retain an admitted line. Callers receive the same bounded
    /// value that will appear in snapshots and line events.
    pub(super) fn record_line(
        &mut self,
        value: &str,
        now: Instant,
    ) -> Result<(String, bool), String> {
        let (line, truncated) = bound_line(value);
        self.admit(now)?;
        self.push(&line);
        Ok((line, truncated))
    }

    /// Preserve a bounded lifecycle notice without counting it as process
    /// output or consuming the monitor's event budget.
    pub(super) fn record_notice(&mut self, line: &str) {
        self.push(line);
    }

    pub(super) fn emitted(&self) -> u32 {
        self.emitted
    }

    pub(super) fn output(&self) -> String {
        self.lines.join("\n")
    }

    fn admit(&mut self, now: Instant) -> Result<(), String> {
        if now.duration_since(self.window_started) >= VOLUME_WINDOW {
            self.window_started = now;
            self.window_count = 0;
        }
        if self.window_count >= MAX_LINES_PER_WINDOW {
            return Err(format!(
                "monitor produced more than {MAX_LINES_PER_WINDOW} events in {:?}; add a filter such as `grep --line-buffered`",
                VOLUME_WINDOW
            ));
        }
        if self.emitted >= MAX_LINES_TOTAL {
            return Err(format!(
                "monitor reached its {MAX_LINES_TOTAL}-event lifetime limit"
            ));
        }
        self.window_count += 1;
        self.emitted += 1;
        Ok(())
    }

    fn push(&mut self, line: &str) {
        self.lines.push(line.to_string());
        if self.lines.len() > MAX_BUFFERED_LINES {
            let excess = self.lines.len() - MAX_BUFFERED_LINES;
            self.lines.drain(..excess);
        }
    }
}

pub(super) fn bound_line(value: &str) -> (String, bool) {
    if value.len() <= MAX_LINE_BYTES {
        return (value.to_string(), false);
    }
    let mut end = MAX_LINE_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (
        format!("{}… [+{} chars]", &value[..end], value.len() - end),
        true,
    )
}
