use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::error::{CoreError, CoreResult};

pub fn validate_macro_graph(macros: &[Value]) -> CoreResult<()> {
    let mut dependencies = HashMap::<&str, Vec<&str>>::new();
    for macro_value in macros {
        let object = macro_value
            .as_object()
            .ok_or_else(|| CoreError::InvalidInput("macro must be an object".to_owned()))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| CoreError::InvalidInput("macro requires id".to_owned()))?;
        let steps = object
            .get("steps")
            .and_then(Value::as_array)
            .ok_or_else(|| CoreError::InvalidInput(format!("macro {id} has invalid steps")))?;
        let targets = steps
            .iter()
            .filter(|step| step.get("type").and_then(Value::as_str) == Some("macro"))
            .map(|step| {
                step.get("macroId")
                    .and_then(Value::as_str)
                    .filter(|target| !target.trim().is_empty())
                    .ok_or_else(|| {
                        CoreError::InvalidInput(format!(
                            "macro {id} contains an invalid macro dependency"
                        ))
                    })
            })
            .collect::<CoreResult<Vec<_>>>()?;
        if dependencies.insert(id, targets).is_some() {
            return Err(CoreError::InvalidInput(format!("duplicate macro id: {id}")));
        }
    }

    for (&id, targets) in &dependencies {
        for target in targets {
            if !dependencies.contains_key(target) {
                return Err(CoreError::InvalidInput(format!(
                    "macro {id} references missing macro {target}"
                )));
            }
        }
    }

    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for id in dependencies.keys().copied() {
        visit(id, &dependencies, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn visit<'a>(
    id: &'a str,
    dependencies: &HashMap<&'a str, Vec<&'a str>>,
    visiting: &mut HashSet<&'a str>,
    visited: &mut HashSet<&'a str>,
) -> CoreResult<()> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id) {
        return Err(CoreError::InvalidInput(format!(
            "macro dependency cycle detected at {id}"
        )));
    }
    for target in dependencies.get(id).into_iter().flatten() {
        visit(target, dependencies, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_acyclic_dependencies() {
        validate_macro_graph(&[
            json!({"id":"a","steps":[{"type":"macro","macroId":"b"}]}),
            json!({"id":"b","steps":[]}),
        ])
        .unwrap();
    }

    #[test]
    fn rejects_missing_dependencies_and_cycles() {
        assert!(
            validate_macro_graph(&[json!({
                "id":"a","steps":[{"type":"macro","macroId":"missing"}]
            })])
            .unwrap_err()
            .to_string()
            .contains("missing")
        );
        assert!(
            validate_macro_graph(&[
                json!({"id":"a","steps":[{"type":"macro","macroId":"b"}]}),
                json!({"id":"b","steps":[{"type":"macro","macroId":"a"}]})
            ])
            .unwrap_err()
            .to_string()
            .contains("cycle")
        );
    }
}
