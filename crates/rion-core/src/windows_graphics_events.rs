use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;

use crate::{
    error::{CoreError, CoreResult},
    model::{WindowsGraphicsEventCollectionRecord, WindowsGraphicsEventRecord},
};

pub fn collect(
    platform: rion_platform::Platform,
    since: &str,
) -> CoreResult<WindowsGraphicsEventCollectionRecord> {
    let since = DateTime::parse_from_rfc3339(since)
        .map_err(|_| CoreError::InvalidInput("Graphics event start time is invalid.".to_owned()))?
        .with_timezone(&Utc);
    match rion_platform::query_windows_display_driver_events(platform) {
        Ok(Some(xml)) => Ok(WindowsGraphicsEventCollectionRecord {
            available: true,
            events: parse(&xml, since),
            error: None,
        }),
        Ok(None) => Ok(WindowsGraphicsEventCollectionRecord {
            available: false,
            events: Vec::new(),
            error: None,
        }),
        Err(error) => Ok(WindowsGraphicsEventCollectionRecord {
            available: false,
            events: Vec::new(),
            error: Some(error.to_string().chars().take(256).collect()),
        }),
    }
}

fn parse(xml: &str, since: DateTime<Utc>) -> Vec<WindowsGraphicsEventRecord> {
    let event = Regex::new(r#"(?s)<Event(?:\s[^>]*)?>.*?</Event>"#).expect("event regex");
    let provider = Regex::new(r#"<Provider\s+Name="([^"]+)""#).expect("provider regex");
    let event_id = Regex::new(r#"<EventID[^>]*>(\d+)</EventID>"#).expect("event id regex");
    let time = Regex::new(r#"<TimeCreated\s+SystemTime="([^"]+)""#).expect("time regex");
    event
        .find_iter(xml)
        .filter_map(|capture| {
            let chunk = capture.as_str();
            let provider = provider.captures(chunk)?.get(1)?.as_str();
            let event_id = event_id
                .captures(chunk)?
                .get(1)?
                .as_str()
                .parse::<u32>()
                .ok()?;
            if event_id != 4101 {
                return None;
            }
            let timestamp = DateTime::parse_from_rfc3339(time.captures(chunk)?.get(1)?.as_str())
                .ok()?
                .with_timezone(&Utc);
            (timestamp >= since).then(|| WindowsGraphicsEventRecord {
                event_id,
                provider: provider.to_owned(),
                timestamp: timestamp.to_rfc3339_opts(SecondsFormat::Millis, true),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_recent_display_driver_events() {
        let xml = concat!(
            r#"<Event><System><Provider Name="Display"/><EventID>4101</EventID><TimeCreated SystemTime="2026-07-21T10:05:00.0000000Z"/></System></Event>"#,
            r#"<Event><System><Provider Name="Display"/><EventID>4101</EventID><TimeCreated SystemTime="2026-07-21T09:59:59.0000000Z"/></System></Event>"#,
            r#"<Event><System><Provider Name="Display"/><EventID>1</EventID><TimeCreated SystemTime="2026-07-21T10:05:00.0000000Z"/></System></Event>"#,
        );
        assert_eq!(
            parse(xml, "2026-07-21T10:00:00Z".parse().unwrap()),
            vec![WindowsGraphicsEventRecord {
                event_id: 4101,
                provider: "Display".to_owned(),
                timestamp: "2026-07-21T10:05:00.000Z".to_owned(),
            }]
        );
    }

    #[test]
    fn ignores_empty_and_malformed_events() {
        let since = "2026-07-21T10:00:00Z".parse().unwrap();
        assert!(parse("", since).is_empty());
        assert!(parse("<Event><EventID>4101</EventID></Event>", since).is_empty());
    }
}
