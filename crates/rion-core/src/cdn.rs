use regex::{Captures, Regex};
use serde::Deserialize;
use url::Url;

use crate::{
    error::{CoreError, CoreResult},
    model::CdnRule,
};

#[derive(Debug)]
struct CompiledRule {
    matcher: Regex,
    substitution: String,
    source_host: String,
}

#[derive(Debug, Default)]
pub struct CdnMatcher {
    rules: Vec<CompiledRule>,
}

#[derive(Deserialize)]
struct RulesDocument {
    rules: Vec<CdnRule>,
}

impl CdnMatcher {
    pub fn bundled() -> CoreResult<Self> {
        let document = serde_json::from_str::<RulesDocument>(include_str!(
            "../assets/cdn_compatibility_rules.json"
        ))
        .map_err(|error| CoreError::Internal(format!("bundled CDN rules are invalid: {error}")))?;
        let mut matcher = Self::default();
        matcher.replace_rules(document.rules)?;
        Ok(matcher)
    }

    pub fn replace_rules(&mut self, rules: Vec<CdnRule>) -> CoreResult<()> {
        let mut compiled = Vec::with_capacity(rules.len());
        for rule in rules {
            if rule.id.trim().is_empty() || rule.source_host.trim().is_empty() {
                return Err(CoreError::InvalidInput(
                    "CDN rules require an id and source host".to_owned(),
                ));
            }
            let matcher = Regex::new(&rule.regex_filter).map_err(|error| {
                CoreError::InvalidInput(format!("invalid CDN rule {}: {error}", rule.id))
            })?;
            compiled.push(CompiledRule {
                matcher,
                substitution: convert_substitution(&rule.regex_substitution),
                source_host: rule.source_host.to_ascii_lowercase(),
            });
        }
        self.rules = compiled;
        Ok(())
    }

    pub fn rewrite(&self, input: &str) -> Option<String> {
        let host = Url::parse(input).ok()?.host_str()?.to_ascii_lowercase();
        self.rules.iter().find_map(|rule| {
            if host != rule.source_host || !rule.matcher.is_match(input) {
                return None;
            }
            let rewritten = rule
                .matcher
                .replace(input, |captures: &Captures<'_>| {
                    expand(&rule.substitution, captures)
                })
                .into_owned();
            (rewritten != input).then_some(rewritten)
        })
    }

    pub fn request_patterns(&self) -> Vec<String> {
        self.rules
            .iter()
            .map(|rule| format!("https://{}/*", rule.source_host))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect()
    }
}

fn convert_substitution(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && chars.peek().is_some_and(char::is_ascii_digit) {
            output.push('$');
            output.push(chars.next().expect("peeked digit"));
        } else {
            output.push(ch);
        }
    }
    output
}

fn expand(template: &str, captures: &Captures<'_>) -> String {
    let mut output = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '$' {
            let mut digits = String::new();
            while chars.peek().is_some_and(char::is_ascii_digit) {
                digits.push(chars.next().expect("peeked digit"));
            }
            if let Ok(index) = digits.parse::<usize>() {
                if let Some(value) = captures.get(index) {
                    output.push_str(value.as_str());
                }
                continue;
            }
        }
        output.push(ch);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_once_and_rewrites_matching_hosts() {
        let mut matcher = CdnMatcher::default();
        matcher
            .replace_rules(vec![CdnRule {
                id: "google".to_owned(),
                regex_filter: r"^https://ajax\.googleapis\.com/(.*)$".to_owned(),
                regex_substitution: r"https://ajax.loli.net/\1".to_owned(),
                source_host: "ajax.googleapis.com".to_owned(),
            }])
            .unwrap();
        assert_eq!(
            matcher.rewrite("https://ajax.googleapis.com/a.js"),
            Some("https://ajax.loli.net/a.js".to_owned())
        );
        assert_eq!(matcher.rewrite("https://example.com/a.js"), None);
    }

    #[test]
    fn bundled_rules_compile_and_expose_the_eight_filtered_hosts() {
        let matcher = CdnMatcher::bundled().unwrap();
        assert_eq!(matcher.request_patterns().len(), 8);
        assert!(
            matcher
                .request_patterns()
                .contains(&"https://www.google.com/*".to_owned())
        );
    }
}
