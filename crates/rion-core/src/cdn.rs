use regex::{Captures, Regex};
use url::Url;

use crate::{
    error::{CoreError, CoreResult},
    model::CdnRule,
};

#[derive(Debug)]
struct CompiledRule {
    id: String,
    matcher: Regex,
    substitution: String,
    source_host: String,
}

#[derive(Debug, Default)]
pub struct CdnMatcher {
    rules: Vec<CompiledRule>,
}

impl CdnMatcher {
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
                id: rule.id,
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

    pub fn rule_ids(&self) -> Vec<&str> {
        self.rules.iter().map(|rule| rule.id.as_str()).collect()
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
}
