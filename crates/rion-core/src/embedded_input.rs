use std::collections::{HashMap, HashSet};

use uuid::Uuid;

use crate::{
    error::{CoreError, CoreResult},
    model::{EmbeddedKeyEffectRecord, EmbeddedKeyTransitionRecord},
};

const MAX_PENDING_TRANSITIONS: usize = 512;
const MAX_IDENTIFIER_LENGTH: usize = 256;

type HeldCodes = HashMap<String, HashSet<String>>;

struct PendingTransition {
    before: HeldCodes,
    role_id: String,
}

#[derive(Default)]
pub(crate) struct EmbeddedInputRuntime {
    held_by_role: HashMap<String, HeldCodes>,
    pending: HashMap<String, PendingTransition>,
    pending_role_ids: HashSet<String>,
}

impl EmbeddedInputRuntime {
    pub fn prepare(
        &mut self,
        role_id: &str,
        phase: &str,
        code: &str,
        modifier_codes: &[String],
        owner_id: &str,
    ) -> CoreResult<EmbeddedKeyTransitionRecord> {
        validate_identifier(role_id, "roleId")?;
        validate_identifier(code, "code")?;
        validate_identifier(owner_id, "ownerId")?;
        if !matches!(phase, "hold" | "release" | "tap") {
            return Err(domain(
                "BROWSER_KEY_PHASE_INVALID",
                "Browser key action phase is invalid.",
            ));
        }
        if modifier_codes.len() > 8 {
            return Err(CoreError::InvalidInput(
                "embedded key modifiers exceed the supported limit".to_owned(),
            ));
        }
        for modifier in modifier_codes {
            validate_identifier(modifier, "modifier code")?;
        }
        if self.pending.len() >= MAX_PENDING_TRANSITIONS {
            return Err(domain(
                "BROWSER_ACTION_BACKPRESSURE",
                "Embedded key transition queue is full.",
            ));
        }
        if !self.pending_role_ids.insert(role_id.to_owned()) {
            return Err(domain(
                "BROWSER_ACTION_ORDERING",
                "An embedded key transition is already pending for this role.",
            ));
        }

        let before = self.held_by_role.get(role_id).cloned().unwrap_or_default();
        let mut held = before.clone();
        let effects = match phase {
            "hold" => apply_hold(&mut held, code, modifier_codes, owner_id),
            "release" => apply_release(&mut held, code, modifier_codes, owner_id),
            "tap" => apply_tap(&mut held, code, modifier_codes, owner_id),
            _ => unreachable!("phase was validated"),
        };
        remove_empty_codes(&mut held);
        let has_held_keys = !held.is_empty();
        if has_held_keys {
            self.held_by_role.insert(role_id.to_owned(), held);
        } else {
            self.held_by_role.remove(role_id);
        }
        let transition_id = Uuid::new_v4().to_string();
        self.pending.insert(
            transition_id.clone(),
            PendingTransition {
                before,
                role_id: role_id.to_owned(),
            },
        );
        Ok(EmbeddedKeyTransitionRecord {
            transition_id: Some(transition_id),
            effects,
            has_held_keys,
        })
    }

    pub fn complete(&mut self, transition_id: &str, succeeded: bool) -> CoreResult<()> {
        let pending = self.pending.remove(transition_id).ok_or_else(|| {
            domain(
                "BROWSER_KEY_TRANSITION_NOT_FOUND",
                "Embedded key transition was not found.",
            )
        })?;
        self.pending_role_ids.remove(&pending.role_id);
        if !succeeded {
            if pending.before.is_empty() {
                self.held_by_role.remove(&pending.role_id);
            } else {
                self.held_by_role.insert(pending.role_id, pending.before);
            }
        }
        Ok(())
    }

    pub fn reassert(&self, role_id: &str) -> CoreResult<EmbeddedKeyTransitionRecord> {
        validate_identifier(role_id, "roleId")?;
        if self.pending_role_ids.contains(role_id) {
            return Err(domain(
                "BROWSER_ACTION_ORDERING",
                "An embedded key transition is already pending for this role.",
            ));
        }
        let Some(held) = self.held_by_role.get(role_id) else {
            return Ok(EmbeddedKeyTransitionRecord {
                transition_id: None,
                effects: Vec::new(),
                has_held_keys: false,
            });
        };
        let mut codes = held.keys().cloned().collect::<Vec<_>>();
        codes.sort_by_key(|code| (!is_modifier_code(code), code.clone()));
        let active_codes = sorted_active_codes(held);
        let effects = codes
            .into_iter()
            .map(|code| EmbeddedKeyEffectRecord {
                phase: "rawKeyDown".to_owned(),
                suppress_shortcut: !is_modifier_code(&code),
                active_codes_before: active_codes.clone(),
                active_codes: active_codes.clone(),
                auto_repeat: false,
                code,
            })
            .collect();
        Ok(EmbeddedKeyTransitionRecord {
            transition_id: None,
            effects,
            has_held_keys: true,
        })
    }

    pub fn has_held_keys(&self, role_id: &str) -> bool {
        self.held_by_role
            .get(role_id)
            .is_some_and(|held| !held.is_empty())
    }

    pub fn clear_role(&mut self, role_id: &str) {
        self.held_by_role.remove(role_id);
        self.pending_role_ids.remove(role_id);
        self.pending
            .retain(|_, pending| pending.role_id.as_str() != role_id);
    }

    pub fn shutdown(&mut self) {
        self.held_by_role.clear();
        self.pending.clear();
        self.pending_role_ids.clear();
    }
}

fn apply_hold(
    held: &mut HeldCodes,
    code: &str,
    modifier_codes: &[String],
    owner_id: &str,
) -> Vec<EmbeddedKeyEffectRecord> {
    let mut effects = Vec::new();
    for current in modifier_codes
        .iter()
        .map(String::as_str)
        .chain(std::iter::once(code))
    {
        let before = sorted_active_codes(held);
        let owners = held.entry(current.to_owned()).or_default();
        let was_held = !owners.is_empty();
        if !owners.insert(owner_id.to_owned()) || was_held {
            continue;
        }
        effects.push(EmbeddedKeyEffectRecord {
            phase: "rawKeyDown".to_owned(),
            code: current.to_owned(),
            active_codes_before: before,
            active_codes: sorted_active_codes(held),
            auto_repeat: false,
            suppress_shortcut: current == code,
        });
    }
    effects
}

fn apply_release(
    held: &mut HeldCodes,
    code: &str,
    modifier_codes: &[String],
    owner_id: &str,
) -> Vec<EmbeddedKeyEffectRecord> {
    let mut effects = Vec::new();
    for current in std::iter::once(code).chain(modifier_codes.iter().rev().map(String::as_str)) {
        let before = sorted_active_codes(held);
        let should_release = held.get_mut(current).is_some_and(|owners| {
            owners.remove(owner_id);
            owners.is_empty()
        });
        if !should_release {
            continue;
        }
        held.remove(current);
        effects.push(EmbeddedKeyEffectRecord {
            phase: "keyUp".to_owned(),
            code: current.to_owned(),
            active_codes_before: before,
            active_codes: sorted_active_codes(held),
            auto_repeat: false,
            suppress_shortcut: current == code,
        });
    }
    effects
}

fn apply_tap(
    held: &mut HeldCodes,
    code: &str,
    modifier_codes: &[String],
    owner_id: &str,
) -> Vec<EmbeddedKeyEffectRecord> {
    let tap_owner = format!("tap:{owner_id}");
    let mut effects = apply_hold(held, code, modifier_codes, &tap_owner);
    let key_was_held = held
        .get(code)
        .is_some_and(|owners| owners.iter().any(|owner| owner != &tap_owner));
    if key_was_held {
        effects.retain(|effect| effect.code != code);
        let active_codes = sorted_active_codes(held);
        effects.push(EmbeddedKeyEffectRecord {
            phase: "rawKeyDown".to_owned(),
            code: code.to_owned(),
            active_codes_before: active_codes.clone(),
            active_codes,
            auto_repeat: true,
            suppress_shortcut: true,
        });
    }
    effects.extend(apply_release(held, code, modifier_codes, &tap_owner));
    effects
}

fn remove_empty_codes(held: &mut HeldCodes) {
    held.retain(|_, owners| !owners.is_empty());
}

fn sorted_active_codes(held: &HeldCodes) -> Vec<String> {
    let mut active = held
        .iter()
        .filter(|(_, owners)| !owners.is_empty())
        .map(|(code, _)| code.clone())
        .collect::<Vec<_>>();
    active.sort();
    active
}

fn is_modifier_code(code: &str) -> bool {
    matches!(
        code,
        "AltLeft"
            | "AltRight"
            | "ControlLeft"
            | "ControlRight"
            | "MetaLeft"
            | "MetaRight"
            | "ShiftLeft"
            | "ShiftRight"
    )
}

fn validate_identifier(value: &str, field: &str) -> CoreResult<()> {
    if value.trim().is_empty() || value.len() > MAX_IDENTIFIER_LENGTH {
        return Err(CoreError::InvalidInput(format!(
            "embedded key {field} is invalid"
        )));
    }
    Ok(())
}

fn domain(code: &'static str, message: &str) -> CoreError {
    CoreError::Domain {
        code,
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_reference_counting_and_modifier_order() {
        let mut runtime = EmbeddedInputRuntime::default();
        let first = runtime
            .prepare("r1", "hold", "KeyW", &["ControlLeft".to_owned()], "owner-1")
            .unwrap();
        assert_eq!(
            first
                .effects
                .iter()
                .map(|effect| (effect.phase.as_str(), effect.code.as_str()))
                .collect::<Vec<_>>(),
            [("rawKeyDown", "ControlLeft"), ("rawKeyDown", "KeyW")]
        );
        runtime
            .complete(first.transition_id.as_deref().unwrap(), true)
            .unwrap();

        let second = runtime
            .prepare("r1", "hold", "KeyW", &["ControlLeft".to_owned()], "owner-2")
            .unwrap();
        assert!(second.effects.is_empty());
        runtime
            .complete(second.transition_id.as_deref().unwrap(), true)
            .unwrap();

        let first_release = runtime
            .prepare(
                "r1",
                "release",
                "KeyW",
                &["ControlLeft".to_owned()],
                "owner-1",
            )
            .unwrap();
        assert!(first_release.effects.is_empty());
        runtime
            .complete(first_release.transition_id.as_deref().unwrap(), true)
            .unwrap();

        let last_release = runtime
            .prepare(
                "r1",
                "release",
                "KeyW",
                &["ControlLeft".to_owned()],
                "owner-2",
            )
            .unwrap();
        assert_eq!(
            last_release
                .effects
                .iter()
                .map(|effect| (effect.phase.as_str(), effect.code.as_str()))
                .collect::<Vec<_>>(),
            [("keyUp", "KeyW"), ("keyUp", "ControlLeft")]
        );
        runtime
            .complete(last_release.transition_id.as_deref().unwrap(), true)
            .unwrap();
        assert!(!runtime.has_held_keys("r1"));
    }

    #[test]
    fn failed_transitions_rollback_and_reassert_is_derived_from_rust_state() {
        let mut runtime = EmbeddedInputRuntime::default();
        let hold = runtime
            .prepare("r1", "hold", "Digit1", &[], "owner")
            .unwrap();
        runtime
            .complete(hold.transition_id.as_deref().unwrap(), false)
            .unwrap();
        assert!(!runtime.has_held_keys("r1"));

        let hold = runtime
            .prepare("r1", "hold", "Digit1", &[], "owner")
            .unwrap();
        runtime
            .complete(hold.transition_id.as_deref().unwrap(), true)
            .unwrap();
        let reassert = runtime.reassert("r1").unwrap();
        assert_eq!(reassert.effects.len(), 1);
        assert_eq!(reassert.effects[0].code, "Digit1");
        runtime.clear_role("r1");
        assert!(runtime.reassert("r1").unwrap().effects.is_empty());
    }
}
