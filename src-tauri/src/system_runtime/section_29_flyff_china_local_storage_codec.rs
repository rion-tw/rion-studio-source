const FLYFF_CHINA_SETTINGS_KEY: &str = "game_client_settings";
const FLYFF_CHINA_SESSIONS_KEY: &str = "game_client_sessions";
const FLYFF_CHINA_SETTINGS_LINE_COUNT: usize = 97;

fn flyff_china_selector_line_indices(selector: &str) -> Option<Vec<usize>> {
    let lines = match selector {
        "game_client_settings.audio" => vec![55, 56, 57, 58, 59],
        "game_client_settings.gameplay" => (9..27).collect(),
        "game_client_settings.graphics" => (27..43).collect(),
        "game_client_settings.ui" => (44..47)
            .chain(48..50)
            .chain(51..55)
            .chain(60..80)
            .collect(),
        "game_client_settings.video" => (80..97).collect(),
        "game_client_settings.layout.windows" => vec![8],
        "game_client_settings.layout.hotbars" => vec![50],
        "game_client_settings.input.bindings" => vec![43],
        _ => return None,
    };
    Some(lines)
}

fn validate_flyff_china_selectors(selectors: &[String]) -> RuntimeResult<()> {
    let mut claimed = HashSet::new();
    for selector in selectors {
        let Some(lines) = flyff_china_selector_line_indices(selector) else {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SELECTOR_INVALID",
                "The Flyff China localStorage synchronization selector is invalid.",
            ));
        };
        if !lines.into_iter().all(|line| claimed.insert(line)) {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SELECTOR_OVERLAP",
                "The Flyff China localStorage synchronization selectors overlap.",
            ));
        }
    }
    Ok(())
}

fn validate_flyff_china_selector_entries(
    selectors: &[String],
    entries: &[(String, Option<String>)],
) -> RuntimeResult<()> {
    if selectors.len() != entries.len()
        || entries
            .iter()
            .zip(selectors)
            .any(|((selector, _), expected)| selector != expected)
    {
        return Err(RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SELECTOR_SET_INVALID",
            "The Flyff China localStorage synchronization field set is invalid.",
        ));
    }
    for (selector, value) in entries {
        let Some(value) = value else {
            continue;
        };
        if value.len() > LOCAL_STORAGE_SYNC_MAX_BYTES {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SELECTOR_VALUE_INVALID",
                "A Flyff China localStorage synchronization field is too large.",
            ));
        }
        let expected = flyff_china_selector_line_indices(selector).ok_or_else(|| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SELECTOR_INVALID",
                "The Flyff China localStorage synchronization selector is invalid.",
            )
        })?;
        let decoded: Vec<(usize, String)> = serde_json::from_str(value).map_err(|_| {
            RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SELECTOR_VALUE_INVALID",
                "A Flyff China localStorage synchronization field is invalid.",
            )
        })?;
        if decoded.len() != expected.len()
            || decoded
                .iter()
                .zip(expected)
                .any(|((index, line), expected)| {
                    *index != expected || line.contains(['\r', '\n']) || line.len() > 16_384
                })
        {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_SELECTOR_VALUE_INVALID",
                "A Flyff China localStorage synchronization field is invalid.",
            ));
        }
    }
    Ok(())
}

fn flyff_china_local_storage_codec_script(
    selectors: &[String],
    codec: Option<&str>,
) -> RuntimeResult<String> {
    validate_flyff_china_selectors(selectors)?;
    let enabled = codec == Some("flyff-china-client-settings");
    let selector_lines = selectors
        .iter()
        .map(|selector| {
            Ok((
                selector.clone(),
                flyff_china_selector_line_indices(selector).ok_or_else(|| {
                    RuntimeError::new(
                        "LOCAL_STORAGE_SYNC_SELECTOR_INVALID",
                        "The Flyff China localStorage synchronization selector is invalid.",
                    )
                })?,
            ))
        })
        .collect::<RuntimeResult<HashMap<_, _>>>()?;
    let selector_lines = serde_json::to_string(&selector_lines).map_err(|_| {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_SCRIPT_INVALID",
            "The Flyff China localStorage synchronization codec could not be encoded.",
        )
    })?;
    Ok(format!(
        r#"const flyff_chinaCodecEnabled = {enabled};
  const flyff_chinaSelectorLines = Object.freeze({selector_lines});
  const parseFlyffChinaLengthPrefixed = (line, maximumBytes) => {{
    if (typeof line !== "string" || line.length > maximumBytes + 32) return null;
    const separator = line.indexOf(" ");
    if (separator < 0) return line === "0" ? "" : null;
    const sizeText = line.slice(0, separator);
    if (!/^(?:0|[1-9]\d*)$/.test(sizeText)) return null;
    const payload = line.slice(separator + 1);
    const size = Number(sizeText);
    return size <= maximumBytes && new TextEncoder().encode(payload).length === size ? payload : null;
  }};
  const parseFlyffChinaSettings = (value) => {{
    if (typeof value !== "string" || value.length > 1048576 || value.includes("\r")) return null;
    const trailingNewline = value.endsWith("\n");
    const lines = value.split("\n");
    if (trailingNewline) lines.pop();
    if (lines.length !== {FLYFF_CHINA_SETTINGS_LINE_COUNT}
      || lines[0] !== "0" || lines[1] !== "7" || lines[2] !== "0" || lines[3] !== "25"
      || lines[5] !== "0" || lines[6] !== "0" || lines[7] !== "0") return null;
    const identity = parseFlyffChinaLengthPrefixed(lines[4], 40);
    const layout = parseFlyffChinaLengthPrefixed(lines[8], 65536);
    const opaque = parseFlyffChinaLengthPrefixed(lines[47], 4096);
    if (identity === null || (identity !== "" && !/^[A-Za-z0-9_-]{{40}}$/.test(identity))
      || layout === null || opaque === null) return null;
    return {{ lines, trailingNewline }};
  }};
  const encodeFlyffChinaSettings = (parsed) => parsed.lines.join("\n") + (parsed.trailingNewline ? "\n" : "");
  const captureFlyffChinaFields = (selectors) => {{
    if (!selectors.length) return [];
    const parsed = parseFlyffChinaSettings(localStorage.getItem("{FLYFF_CHINA_SETTINGS_KEY}"));
    if (!parsed) return null;
    return selectors.map((selector) => [selector, JSON.stringify(
      flyff_chinaSelectorLines[selector].map((index) => [index, parsed.lines[index]])
    )]);
  }};
  const applyFlyffChinaFields = (selectors, entries) => {{
    if (!selectors.length) return true;
    const parsed = parseFlyffChinaSettings(localStorage.getItem("{FLYFF_CHINA_SETTINGS_KEY}"));
    if (!parsed || !Array.isArray(entries) || entries.length !== selectors.length) return false;
    for (let offset = 0; offset < selectors.length; offset += 1) {{
      const selector = selectors[offset];
      const entry = entries[offset];
      if (!Array.isArray(entry) || entry[0] !== selector) return false;
      if (entry[1] === null) continue;
      let values;
      try {{ values = JSON.parse(entry[1]); }} catch {{ return false; }}
      const expected = flyff_chinaSelectorLines[selector];
      if (!Array.isArray(values) || values.length !== expected.length) return false;
      for (let index = 0; index < expected.length; index += 1) {{
        const value = values[index];
        if (!Array.isArray(value) || value[0] !== expected[index] || typeof value[1] !== "string" || /[\r\n]/.test(value[1])) return false;
        parsed.lines[expected[index]] = value[1];
      }}
    }}
    localStorage.setItem("{FLYFF_CHINA_SETTINGS_KEY}", encodeFlyffChinaSettings(parsed));
    return true;
  }};
  const parseFlyffChinaSessionIdentities = (value) => {{
    if (typeof value !== "string" || value.length > 1048576 || value.includes("\r")) return null;
    const lines = value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");
    if (!/^\d+$/.test(lines[0])) return null;
    const count = Number(lines[0]);
    if (!Number.isSafeInteger(count) || count < 0 || count > 32 || lines.length !== count + 1) return null;
    const identities = new Set();
    for (const line of lines.slice(1)) {{
      const match = /^25 \d+ \d+ 40 ([A-Za-z0-9_-]{{40}}) (\d+) (\S+) (\d+) (.+)$/.exec(line);
      if (!match || new TextEncoder().encode(match[3]).length !== Number(match[2])
        || new TextEncoder().encode(match[5]).length !== Number(match[4])) return null;
      identities.add(match[1]);
    }}
    return identities;
  }};
  const repairFlyffChinaIdentity = (selectors) => {{
    if (!flyff_chinaCodecEnabled) return "disabled";
    const parsed = parseFlyffChinaSettings(localStorage.getItem("{FLYFF_CHINA_SETTINGS_KEY}"));
    const sessions = localStorage.getItem("{FLYFF_CHINA_SESSIONS_KEY}");
    if (!parsed) return "settings-invalid";
    if (typeof sessions !== "string" || sessions === "") return "session-missing";
    const identities = parseFlyffChinaSessionIdentities(sessions);
    if (!identities) return "session-invalid";
    if (identities.size !== 1) return identities.size === 0 ? "session-missing" : "session-ambiguous";
    const identity = identities.values().next().value;
    const expected = `40 ${{identity}}`;
    if (parsed.lines[4] === expected) return "ok";
    parsed.lines[4] = expected;
    localStorage.setItem("{FLYFF_CHINA_SETTINGS_KEY}", encodeFlyffChinaSettings(parsed));
    return "repaired";
  }};
  const captureLocalStorageCodecFields = captureFlyffChinaFields;
  const applyLocalStorageCodecFields = applyFlyffChinaFields;
  const repairLocalStorageCodecIdentity = repairFlyffChinaIdentity;
  const localStorageCodecSettingsInvalidCode = "FLYFF_CHINA_SETTINGS_INVALID";
  const localStorageCodecDiagnosticCode = (status) => status === "repaired" ? "FLYFF_CHINA_IDENTITY_REPAIRED"
    : status === "session-missing" ? "FLYFF_CHINA_SESSION_MISSING"
    : status === "session-invalid" ? "FLYFF_CHINA_SESSION_INVALID"
    : status === "session-ambiguous" ? "FLYFF_CHINA_SESSION_AMBIGUOUS"
    : status === "settings-invalid" ? "FLYFF_CHINA_SETTINGS_INVALID" : null;"#,
    ))
}

#[cfg(test)]
mod flyff_china_codec_reference {
    use super::*;

    pub(super) struct Settings {
        lines: Vec<String>,
        trailing_newline: bool,
    }

    fn invalid() -> RuntimeError {
        RuntimeError::new(
            "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SETTINGS_INVALID",
            "The Flyff China client settings payload is invalid.",
        )
    }

    fn length_prefixed(line: &str, maximum_bytes: usize) -> RuntimeResult<&str> {
        if line == "0" {
            return Ok("");
        }
        let (length, payload) = line.split_once(' ').ok_or_else(invalid)?;
        let length = length.parse::<usize>().map_err(|_| invalid())?;
        if length > maximum_bytes || payload.len() != length {
            return Err(invalid());
        }
        Ok(payload)
    }

    pub(super) fn parse(value: &str) -> RuntimeResult<Settings> {
        if value.len() > 1_048_576 || value.contains('\r') {
            return Err(invalid());
        }
        let trailing_newline = value.ends_with('\n');
        let mut lines = value.split('\n').map(str::to_owned).collect::<Vec<_>>();
        if trailing_newline {
            lines.pop();
        }
        if lines.len() != FLYFF_CHINA_SETTINGS_LINE_COUNT
            || lines[0] != "0"
            || lines[1] != "7"
            || lines[2] != "0"
            || lines[3] != "25"
            || lines[5..8] != ["0", "0", "0"]
        {
            return Err(invalid());
        }
        let identity = length_prefixed(&lines[4], 40)?;
        if !identity.is_empty()
            && (identity.len() != 40
                || !identity
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        {
            return Err(invalid());
        }
        length_prefixed(&lines[8], 65_536)?;
        length_prefixed(&lines[47], 4_096)?;
        Ok(Settings {
            lines,
            trailing_newline,
        })
    }

    impl Settings {
        pub(super) fn line(&self, index: usize) -> &str {
            &self.lines[index]
        }

        pub(super) fn encode(&self) -> String {
            let mut value = self.lines.join("\n");
            if self.trailing_newline {
                value.push('\n');
            }
            value
        }

        pub(super) fn capture(
            &self,
            selectors: &[String],
        ) -> RuntimeResult<Vec<(String, Option<String>)>> {
            validate_flyff_china_selectors(selectors)?;
            selectors
                .iter()
                .map(|selector| {
                    let lines = flyff_china_selector_line_indices(selector).ok_or_else(invalid)?;
                    let value = lines
                        .into_iter()
                        .map(|index| (index, self.lines[index].clone()))
                        .collect::<Vec<_>>();
                    Ok((
                        selector.clone(),
                        Some(serde_json::to_string(&value).map_err(|_| invalid())?),
                    ))
                })
                .collect()
        }

        pub(super) fn merge(
            &self,
            entries: &[(String, Option<String>)],
        ) -> RuntimeResult<String> {
            let selectors = entries
                .iter()
                .map(|(selector, _)| selector.clone())
                .collect::<Vec<_>>();
            validate_flyff_china_selector_entries(&selectors, entries)?;
            let mut merged = self.lines.clone();
            for (_, value) in entries {
                let Some(value) = value else {
                    continue;
                };
                let values: Vec<(usize, String)> =
                    serde_json::from_str(value).map_err(|_| invalid())?;
                for (index, value) in values {
                    merged[index] = value;
                }
            }
            let result = Settings {
                lines: merged,
                trailing_newline: self.trailing_newline,
            }
            .encode();
            parse(&result)?;
            Ok(result)
        }
    }

    fn take_unsigned(line: &str, offset: &mut usize) -> RuntimeResult<usize> {
        let remaining = line.get(*offset..).ok_or_else(invalid)?;
        let end = remaining.find(' ').unwrap_or(remaining.len());
        let value = remaining[..end].parse::<usize>().map_err(|_| invalid())?;
        *offset += end;
        Ok(value)
    }

    fn take_string<'a>(line: &'a str, offset: &mut usize) -> RuntimeResult<&'a str> {
        let length = take_unsigned(line, offset)?;
        if line.as_bytes().get(*offset) != Some(&b' ') {
            return Err(invalid());
        }
        *offset += 1;
        let end = *offset + length;
        let value = line.get(*offset..end).ok_or_else(invalid)?;
        *offset = end;
        Ok(value)
    }

    fn unique_session_identity(value: &str) -> RuntimeResult<String> {
        if value.len() > 1_048_576 || value.contains('\r') {
            return Err(invalid());
        }
        let mut lines = value.trim_end_matches('\n').split('\n');
        let count = lines
            .next()
            .ok_or_else(invalid)?
            .parse::<usize>()
            .map_err(|_| invalid())?;
        if count == 0 || count > 32 {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SESSION_MISSING",
                "The Flyff China session identity is missing.",
            ));
        }
        let mut identities = HashSet::new();
        for _ in 0..count {
            let line = lines.next().ok_or_else(invalid)?;
            let mut offset = 0;
            if take_unsigned(line, &mut offset)? != 25 {
                return Err(invalid());
            }
            for _ in 0..2 {
                if line.as_bytes().get(offset) != Some(&b' ') {
                    return Err(invalid());
                }
                offset += 1;
                take_unsigned(line, &mut offset)?;
            }
            if line.as_bytes().get(offset) != Some(&b' ') {
                return Err(invalid());
            }
            offset += 1;
            let identity = take_string(line, &mut offset)?;
            if identity.len() != 40 {
                return Err(invalid());
            }
            identities.insert(identity.to_owned());
            for _ in 0..2 {
                if line.as_bytes().get(offset) != Some(&b' ') {
                    return Err(invalid());
                }
                offset += 1;
                take_string(line, &mut offset)?;
            }
            if offset != line.len() {
                return Err(invalid());
            }
        }
        if lines.next().is_some() {
            return Err(invalid());
        }
        if identities.len() != 1 {
            return Err(RuntimeError::new(
                "LOCAL_STORAGE_SYNC_FLYFF_CHINA_SESSION_AMBIGUOUS",
                "The Flyff China session contains multiple identities.",
            ));
        }
        Ok(identities.into_iter().next().expect("one identity"))
    }

    pub(super) fn repair_identity(value: &str, sessions: &str) -> RuntimeResult<Option<String>> {
        let mut settings = parse(value)?;
        let identity = unique_session_identity(sessions)?;
        let expected = format!("40 {identity}");
        if settings.lines[4] == expected {
            return Ok(None);
        }
        settings.lines[4] = expected;
        Ok(Some(settings.encode()))
    }

    pub(super) fn fixture(identity: &str, marker: &str) -> String {
        let mut lines = vec!["0".to_owned(); FLYFF_CHINA_SETTINGS_LINE_COUNT];
        lines[1] = "7".to_owned();
        lines[3] = "25".to_owned();
        lines[4] = format!("40 {identity}");
        let layout = format!("1 2  3 {marker}");
        lines[8] = format!("{} {layout}", layout.len());
        lines[43] = "future-bindings-format".to_owned();
        lines[47] = "14 test-client-v7".to_owned();
        lines[50] = "future-hotbars-format".to_owned();
        for index in [73, 74, 75, 76, 77, 79] {
            lines[index] = "1 2 3".to_owned();
        }
        lines[55] = marker.to_owned();
        format!("{}\n", lines.join("\n"))
    }

    pub(super) fn sessions(identities: &[(&str, &str)]) -> String {
        let lines = identities.iter().map(|(identity, name)| {
            format!(
                "25 1 187 40 {identity} 5 Yetti {} {name}",
                name.len()
            )
        });
        std::iter::once(identities.len().to_string())
            .chain(lines)
            .collect::<Vec<_>>()
            .join("\n")
    }
}
