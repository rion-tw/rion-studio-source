use chrono::Utc;

use crate::{
    error::{CoreError, CoreResult},
    model::{
        LegalAcceptDocumentsInputRecord, LegalAcceptanceRecord, LegalAcceptanceStatusRecord,
        LegalDocumentVersionsRecord,
    },
};

pub fn current_versions() -> LegalDocumentVersionsRecord {
    LegalDocumentVersionsRecord {
        fair_use: "2026-07-26".to_owned(),
        privacy: "2026-07-31".to_owned(),
        terms: "2026-07-26".to_owned(),
    }
}

pub(crate) fn status(
    acceptance: Option<&LegalAcceptanceRecord>,
    versions: LegalDocumentVersionsRecord,
) -> LegalAcceptanceStatusRecord {
    let is_accepted = acceptance.is_some_and(|acceptance| {
        acceptance.accepted_terms_version == versions.terms
            && acceptance.accepted_fair_use_version == versions.fair_use
            && acceptance.acknowledged_privacy_version == versions.privacy
    });
    LegalAcceptanceStatusRecord {
        current_versions: versions,
        is_accepted,
        accepted_at: acceptance.map(|value| value.accepted_at.clone()),
        accepted_fair_use_version: acceptance.map(|value| value.accepted_fair_use_version.clone()),
        accepted_terms_version: acceptance.map(|value| value.accepted_terms_version.clone()),
        acknowledged_privacy_version: acceptance
            .map(|value| value.acknowledged_privacy_version.clone()),
    }
}

pub(crate) fn accept(
    versions: &LegalDocumentVersionsRecord,
    input: LegalAcceptDocumentsInputRecord,
) -> CoreResult<LegalAcceptanceRecord> {
    if input.terms_version != versions.terms
        || input.fair_use_version != versions.fair_use
        || input.privacy_version != versions.privacy
    {
        return Err(CoreError::Domain {
            code: "LEGAL_VERSIONS_OUTDATED",
            message: "Legal document versions are out of date.".to_owned(),
        });
    }
    Ok(LegalAcceptanceRecord {
        accepted_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        accepted_fair_use_version: input.fair_use_version,
        accepted_terms_version: input.terms_version,
        acknowledged_privacy_version: input.privacy_version,
        schema_version: 1,
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn advances_only_the_privacy_notice_for_google_font_previews() {
        let versions = current_versions();
        assert_eq!(versions.fair_use, "2026-07-26");
        assert_eq!(versions.privacy, "2026-07-31");
        assert_eq!(versions.terms, "2026-07-26");
    }

    fn versions() -> LegalDocumentVersionsRecord {
        LegalDocumentVersionsRecord {
            fair_use: "f1".to_owned(),
            privacy: "p1".to_owned(),
            terms: "t1".to_owned(),
        }
    }

    #[test]
    fn validates_versions_and_owns_acceptance_timestamp() {
        let acceptance = accept(
            &versions(),
            LegalAcceptDocumentsInputRecord {
                fair_use_version: "f1".to_owned(),
                privacy_version: "p1".to_owned(),
                terms_version: "t1".to_owned(),
            },
        )
        .unwrap();
        {
            assert_eq!(acceptance.schema_version, 1);
            assert!(chrono::DateTime::parse_from_rfc3339(&acceptance.accepted_at).is_ok());
            assert_eq!(acceptance.accepted_fair_use_version, "f1");
            assert_eq!(acceptance.accepted_terms_version, "t1");
            assert_eq!(acceptance.acknowledged_privacy_version, "p1");
            assert!(status(Some(&acceptance), versions()).is_accepted);
        };

        {
            let current = status(None, versions());
            assert!(!current.is_accepted);
            assert!(current.accepted_at.is_none());
        };
    }

    #[test]
    fn corrupt_incomplete_and_superseded_acceptance_fails_closed() {
        {
            for raw in [
                json!({"schemaVersion":1}),
                json!({
                    "schemaVersion":2,
                    "acceptedAt":"2026-01-01T00:00:00Z",
                    "acceptedFairUseVersion":"f1",
                    "acceptedTermsVersion":"t1",
                    "acknowledgedPrivacyVersion":"p1"
                }),
                json!({
                    "schemaVersion":1,
                    "acceptedAt":"not-a-date",
                    "acceptedFairUseVersion":"f1",
                    "acceptedTermsVersion":"t1",
                    "acknowledgedPrivacyVersion":"p1"
                }),
            ] {
                let accepted = serde_json::from_value::<LegalAcceptanceRecord>(raw)
                    .ok()
                    .filter(|record| crate::domain::validate_legal_acceptance(record).is_ok());
                assert!(!status(accepted.as_ref(), versions()).is_accepted);
            }
            let superseded = LegalAcceptanceRecord {
                accepted_at: "2026-01-01T00:00:00Z".to_owned(),
                accepted_fair_use_version: "f0".to_owned(),
                accepted_terms_version: "t0".to_owned(),
                acknowledged_privacy_version: "p0".to_owned(),
                schema_version: 1,
            };
            assert!(!status(Some(&superseded), versions()).is_accepted);
        };
    }

    #[test]
    fn rejects_stale_document_versions() {
        let error = accept(
            &versions(),
            LegalAcceptDocumentsInputRecord {
                fair_use_version: "old".to_owned(),
                privacy_version: "p1".to_owned(),
                terms_version: "t1".to_owned(),
            },
        )
        .unwrap_err();
        {
            assert_eq!(error.code(), "LEGAL_VERSIONS_OUTDATED");
            assert_eq!(
                error.to_string(),
                "Legal document versions are out of date."
            );
        };
    }
}
