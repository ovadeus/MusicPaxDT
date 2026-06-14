//! Free, offline heuristic for dissecting messy YouTube-style track labels into
//! clean {title, artist, year}. Handles the common shapes uploaders use:
//!
//!   "Artist - Song (Official Video)"
//!   "Artist - Song by INITIALS - Original 1972 release"   ← the junk case
//!   "Song [HD]"  with a distributor name ("Radial by The Orchard") as artist
//!
//! This runs first (no network, no cost). The LLM tier refines the hard cases
//! on top of it. Nothing is written until the user approves in the review
//! dialog, so the heuristic can be aggressive about stripping promo tails.

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cleaned {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub year: Option<i64>,
}

/// Distributor / auto-generated credits that masquerade as the artist. When the
/// raw artist matches one of these we discard it and read the artist from the
/// title instead.
fn is_distributor(artist: &str) -> bool {
    let a = artist.to_lowercase();
    a.ends_with("- topic")
        || [
            "provided to youtube",
            "radial by",
            "the orchard",
            "believe music",
            "believe sas",
            "distrokid",
            "cd baby",
            "cdbaby",
            "tunecore",
            "various artists",
            "auto-generated",
            "soundrop",
            "symphonic",
            "ingrooves",
        ]
        .iter()
        .any(|d| a.contains(d))
}

/// First plausible release year (1900–2099) anywhere in the string.
fn find_year(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 4 <= bytes.len() {
        if bytes[i].is_ascii_digit() {
            let chunk = &s[i..i + 4];
            if chunk.bytes().all(|b| b.is_ascii_digit()) {
                // must not be part of a longer number
                let prev_digit = i > 0 && bytes[i - 1].is_ascii_digit();
                let next_digit = i + 4 < bytes.len() && bytes[i + 4].is_ascii_digit();
                if !prev_digit && !next_digit {
                    if let Ok(y) = chunk.parse::<i64>() {
                        if (1900..=2099).contains(&y) {
                            return Some(y);
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

const PROMO_KEYWORDS: &[&str] = &[
    "official", "video", "audio", "lyric", "lyrics", "hd", "hq", "4k", "mv",
    "visualizer", "visualiser", "explicit", "remaster", "remastered", "full album",
    "music video", "color", "colorized", "restored", "stereo", "mono",
];

/// Remove `(...)` / `[...]` groups that are promo noise (contain a promo keyword
/// or a year). Meaningful parentheticals (e.g. a real subtitle) are kept.
fn strip_promo_brackets(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut buf = String::new();
    let mut depth = 0u32;
    let mut closer = ' ';
    for c in s.chars() {
        if depth == 0 && (c == '(' || c == '[') {
            depth = 1;
            closer = if c == '(' { ')' } else { ']' };
            buf.clear();
            buf.push(c);
        } else if depth > 0 {
            buf.push(c);
            if c == closer {
                depth = 0;
                let inner = buf[1..buf.len().saturating_sub(1)].to_lowercase();
                let is_promo = find_year(&inner).is_some()
                    || PROMO_KEYWORDS.iter().any(|k| inner.contains(k));
                if !is_promo {
                    out.push_str(&buf); // keep meaningful parenthetical
                }
            }
        } else {
            out.push(c);
        }
    }
    if depth > 0 {
        out.push_str(&buf); // unbalanced — keep as-is
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Initials of an artist name, skipping stopwords. "Commander Cody & His Lost
/// Planet Airmen" → "CCLPA".
fn initials(name: &str) -> String {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .filter(|w| {
            !matches!(
                w.to_lowercase().as_str(),
                "his" | "her" | "the" | "and" | "of" | "a" | "an"
            )
        })
        .filter_map(|w| w.chars().next())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// A trailing " by ..." in a title is usually uploader self-promo. Strip it when
/// it looks promo-ish (digits, promo words, an ampersand, an initialism of the
/// artist, or very short) rather than part of a real song name.
fn strip_by_tail(title: &str, artist: Option<&str>) -> String {
    let lower = title.to_lowercase();
    if let Some(idx) = lower.find(" by ") {
        let tail = title[idx + 4..].trim();
        let tl = tail.to_lowercase();
        let promo = tail.chars().any(|c| c.is_ascii_digit())
            || tail.contains('&')
            || tail.len() <= 4
            || ["original", "remaster", "release", "records", "topic", "vevo", "official"]
                .iter()
                .any(|k| tl.contains(k))
            || artist.is_some_and(|a| {
                let ti = initials(tail);
                ti.len() >= 2 && initials(a).contains(&ti)
            });
        if promo {
            return title[..idx].trim().to_string();
        }
    }
    title.to_string()
}

fn tidy(s: &str) -> Option<String> {
    let t = s.trim().trim_matches(|c| c == '-' || c == '–' || c == '|').trim();
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Best-effort structured parse. Returns whatever it can confidently extract;
/// `None` fields mean "leave the track's current value alone".
pub fn clean(raw_title: &str, raw_artist: Option<&str>) -> Cleaned {
    let year = find_year(raw_title);
    let stripped = strip_promo_brackets(raw_title);

    let segs: Vec<String> = stripped
        .split(" - ")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let known_artist = raw_artist
        .map(str::trim)
        .filter(|a| !a.is_empty() && !is_distributor(a));

    let (artist, title_seg): (Option<String>, String) = if segs.len() >= 2 {
        match known_artist {
            // The existing artist confirms the "Artist - Title" split.
            Some(a) if segs[0].eq_ignore_ascii_case(a) => {
                (Some(a.to_string()), segs[1].clone())
            }
            // ...or the rarer "Title - Artist" order.
            Some(a) if segs[1].eq_ignore_ascii_case(a) => {
                (Some(a.to_string()), segs[0].clone())
            }
            // Existing artist matches neither segment — it's usually a junk
            // channel/distributor name ("neilyoungchannel"). Trust the
            // "Artist - Title" convention in the label and replace it.
            _ => (Some(segs[0].clone()), segs[1].clone()),
        }
    } else {
        let single = segs.first().cloned().unwrap_or_default();
        (known_artist.map(|a| a.to_string()), single)
    };

    let title = strip_by_tail(&title_seg, artist.as_deref());

    Cleaned {
        title: tidy(&title),
        artist: artist.as_deref().and_then(tidy),
        year,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dissects_the_hot_rod_lincoln_junk() {
        let c = clean(
            "Commander Cody & His Lost Planet Airmen - Hot Rod Lincoln by CC & LPA - Original 1972 release",
            Some("Radial by The Orchard"),
        );
        assert_eq!(c.title.as_deref(), Some("Hot Rod Lincoln"));
        assert_eq!(
            c.artist.as_deref(),
            Some("Commander Cody & His Lost Planet Airmen")
        );
        assert_eq!(c.year, Some(1972));
    }

    #[test]
    fn strips_official_video_with_known_artist() {
        let c = clean("Prince - Purple Rain (Official Video)", Some("Prince"));
        assert_eq!(c.title.as_deref(), Some("Purple Rain"));
        assert_eq!(c.artist.as_deref(), Some("Prince"));
        assert_eq!(c.year, None);
    }

    #[test]
    fn replaces_junk_channel_artist_using_the_label_split() {
        // The artist field is an uploader channel that matches neither segment,
        // so the "Artist - Title" split in the label wins.
        let c = clean("Neil Young - Heart of Gold (Official Audio)", Some("neilyoungchannel"));
        assert_eq!(c.artist.as_deref(), Some("Neil Young"));
        assert_eq!(c.title.as_deref(), Some("Heart of Gold"));
    }

    #[test]
    fn keeps_real_by_in_title() {
        // "Saved by the Bell" must not be truncated to "Saved".
        let c = clean("Some Band - Saved by the Bell", Some("Some Band"));
        assert_eq!(c.title.as_deref(), Some("Saved by the Bell"));
    }

    #[test]
    fn detects_distributor_artist() {
        assert!(is_distributor("Radial by The Orchard"));
        assert!(is_distributor("Various Artists"));
        assert!(is_distributor("Commander Cody - Topic"));
        assert!(!is_distributor("Prince"));
    }

    #[test]
    fn finds_year_only_when_standalone() {
        assert_eq!(find_year("Original 1972 release"), Some(1972));
        assert_eq!(find_year("track 12345 no year"), None);
        assert_eq!(find_year("nothing here"), None);
    }
}
