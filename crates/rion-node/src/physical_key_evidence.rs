use napi_derive::napi;

#[derive(Clone)]
#[napi(object)]
pub struct PhysicalKeyEvidence {
    pub sequence: String,
    pub code: String,
    pub event_type: String,
    pub repeat: bool,
    pub consumed: bool,
}

#[napi(object)]
pub struct PhysicalKeyboardEvidence {
    pub sequence: String,
    pub events: Vec<PhysicalKeyEvidence>,
}

#[cfg(any(windows, test))]
pub(crate) fn windows_key_code(vk: u32, scan: u32, extended: bool) -> String {
    // DOM code denotes the physical position, independent of the active layout.
    if !extended {
        let physical = match scan {
            0x02..=0x0a => Some(format!("Digit{}", scan - 1)),
            0x0b => Some("Digit0".into()),
            0x10..=0x19 => Some(format!(
                "Key{}",
                b"QWERTYUIOP"[(scan - 0x10) as usize] as char
            )),
            0x1e..=0x26 => Some(format!(
                "Key{}",
                b"ASDFGHJKL"[(scan - 0x1e) as usize] as char
            )),
            0x2c..=0x32 => Some(format!("Key{}", b"ZXCVBNM"[(scan - 0x2c) as usize] as char)),
            _ => None,
        };
        if let Some(code) = physical {
            return code;
        }
    }
    match vk {
        0x30..=0x39 => format!("Digit{}", char::from_u32(vk).unwrap_or('?')),
        0x41..=0x5a => format!("Key{}", char::from_u32(vk).unwrap_or('?')),
        0x70..=0x87 => format!("F{}", vk - 0x6f),
        0x10 | 0xa0 | 0xa1 => if vk == 0xa1 || scan == 0x36 {
            "ShiftRight"
        } else {
            "ShiftLeft"
        }
        .into(),
        0x11 | 0xa2 | 0xa3 => if vk == 0xa3 || extended {
            "ControlRight"
        } else {
            "ControlLeft"
        }
        .into(),
        0x12 | 0xa4 | 0xa5 => if vk == 0xa5 || extended {
            "AltRight"
        } else {
            "AltLeft"
        }
        .into(),
        0x5b => "MetaLeft".into(),
        0x5c => "MetaRight".into(),
        0x08 => "Backspace".into(),
        0x09 => "Tab".into(),
        0x0d => if extended { "NumpadEnter" } else { "Enter" }.into(),
        0x1b => "Escape".into(),
        0x20 => "Space".into(),
        0x21 => "PageUp".into(),
        0x22 => "PageDown".into(),
        0x23 => "End".into(),
        0x24 => "Home".into(),
        0x25 => "ArrowLeft".into(),
        0x26 => "ArrowUp".into(),
        0x27 => "ArrowRight".into(),
        0x28 => "ArrowDown".into(),
        0x2d => "Insert".into(),
        0x2e => "Delete".into(),
        0xba => "Semicolon".into(),
        0xbb => "Equal".into(),
        0xbc => "Comma".into(),
        0xbd => "Minus".into(),
        0xbe => "Period".into(),
        0xbf => "Slash".into(),
        0xc0 => "Backquote".into(),
        0xdb => "BracketLeft".into(),
        0xdc => "Backslash".into(),
        0xdd => "BracketRight".into(),
        0xde => "Quote".into(),
        _ => "Unidentified".into(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_physical_keys_preserve_digits_arrows_and_modifier_sides() {
        use super::windows_key_code as code;
        assert_eq!(code(0x31, 2, false), "Digit1");
        assert_eq!(code(0x33, 4, false), "Digit3");
        assert_eq!(code(0x41, 0x10, false), "KeyQ");
        assert_eq!(code(0x25, 0, true), "ArrowLeft");
        assert_eq!(code(0x10, 0x36, false), "ShiftRight");
        assert_eq!(code(0x11, 0, false), "ControlLeft");
        assert_eq!(code(0x11, 0, true), "ControlRight");
    }
}
