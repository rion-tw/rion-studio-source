use std::collections::BTreeMap;

use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::{CoreError, CoreResult},
    model::{
        CompatibilityCheckOutcome, CompatibilityCheckPlanRecord, CompatibilityRunPhase,
        CompatibilityRunStatusRecord, CompatibilityVersionRecord, GameBrowserSettingsRecord,
        StateCompatibilityChromeRecord, StateCompatibilityLoadRecord,
        StateCompatibilityObservationsRecord, StateCompatibilityRecommendationRecord,
        StateCompatibilityReportRecord, StateGameRecord,
    },
};

#[derive(Debug, Clone)]
struct ActiveCheck {
    configuration_fingerprint: String,
    status: CompatibilityRunStatusRecord,
    system_chrome_available: bool,
    cancel_requested: bool,
}

#[derive(Default)]
pub(crate) struct CompatibilityRuntime {
    active: BTreeMap<String, ActiveCheck>,
}

impl CompatibilityRuntime {
    pub fn statuses(&self) -> Vec<CompatibilityRunStatusRecord> {
        self.active
            .values()
            .map(|check| check.status.clone())
            .collect()
    }

    pub fn prepare(
        &mut self,
        games: &[StateGameRecord],
        settings: &GameBrowserSettingsRecord,
        game_id: &str,
        system_chrome_available: bool,
        versions: &CompatibilityVersionRecord,
    ) -> CoreResult<CompatibilityCheckPlanRecord> {
        if self.active.contains_key(game_id) {
            return Err(CoreError::Domain {
                code: "COMPATIBILITY_CHECK_ACTIVE",
                message: "A compatibility check is already running for this game.".to_owned(),
            });
        }
        let game = games
            .iter()
            .find(|game| game.id == game_id)
            .ok_or_else(|| CoreError::Domain {
                code: "GAME_NOT_FOUND",
                message: "Game not found.".to_owned(),
            })?;
        let started_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let status = CompatibilityRunStatusRecord {
            game_id: game.id.clone(),
            phase: CompatibilityRunPhase::Preparing,
            started_at: started_at.clone(),
            updated_at: started_at.clone(),
        };
        self.active.insert(
            game.id.clone(),
            ActiveCheck {
                configuration_fingerprint: configuration_fingerprint(game, settings, versions)?,
                status,
                system_chrome_available,
                cancel_requested: false,
            },
        );
        Ok(CompatibilityCheckPlanRecord {
            game_id: game.id.clone(),
            game_name: game.name.clone(),
            launch_url: game.default_launch_url.clone(),
            started_at,
        })
    }

    pub fn transition(&mut self, game_id: &str, phase: CompatibilityRunPhase) -> CoreResult<()> {
        let active = self
            .active
            .get_mut(game_id)
            .ok_or_else(|| inactive(game_id))?;
        active.status.phase = phase;
        active.status.updated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        Ok(())
    }

    pub fn request_cancel(&mut self, game_id: &str) -> bool {
        let Some(active) = self.active.get_mut(game_id) else {
            return false;
        };
        active.cancel_requested = true;
        true
    }

    pub fn build_report(
        &self,
        game_id: &str,
        outcome: CompatibilityCheckOutcome,
    ) -> CoreResult<StateCompatibilityReportRecord> {
        let active = self.active.get(game_id).ok_or_else(|| inactive(game_id))?;
        let system_chrome = Some(StateCompatibilityChromeRecord {
            state: if active.system_chrome_available {
                "available".to_owned()
            } else {
                "unavailable".to_owned()
            },
        });
        let checked_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let cancelled = active.cancel_requested
            || matches!(outcome, CompatibilityCheckOutcome::Cancelled { .. });
        let (load, graphics, recommendation) = match outcome {
            CompatibilityCheckOutcome::Loaded {
                duration_ms,
                final_origin,
                graphics,
            } if !cancelled => {
                let recommendation = if graphics.webgl == "available" {
                    StateCompatibilityRecommendationRecord {
                        mode: None,
                        reason: "embedded_available".to_owned(),
                    }
                } else {
                    StateCompatibilityRecommendationRecord {
                        mode: None,
                        reason: "graphics_unavailable".to_owned(),
                    }
                };
                (
                    StateCompatibilityLoadRecord {
                        state: "available".to_owned(),
                        duration_ms,
                        final_origin,
                        error_code: None,
                    },
                    Some(graphics),
                    Some(recommendation),
                )
            }
            CompatibilityCheckOutcome::Failed {
                duration_ms,
                error_code,
            } if !cancelled => (
                StateCompatibilityLoadRecord {
                    state: "failed".to_owned(),
                    duration_ms,
                    final_origin: None,
                    error_code: Some(error_code),
                },
                None,
                Some(if active.system_chrome_available {
                    StateCompatibilityRecommendationRecord {
                        mode: Some("external".to_owned()),
                        reason: "external_recommended".to_owned(),
                    }
                } else {
                    StateCompatibilityRecommendationRecord {
                        mode: None,
                        reason: "chrome_required".to_owned(),
                    }
                }),
            ),
            CompatibilityCheckOutcome::Cancelled { duration_ms }
            | CompatibilityCheckOutcome::Loaded { duration_ms, .. }
            | CompatibilityCheckOutcome::Failed { duration_ms, .. } => (
                StateCompatibilityLoadRecord {
                    state: "cancelled".to_owned(),
                    duration_ms,
                    final_origin: None,
                    error_code: None,
                },
                None,
                None,
            ),
        };
        Ok(StateCompatibilityReportRecord {
            game_id: game_id.to_owned(),
            checked_at: Some(checked_at),
            configuration_fingerprint: Some(active.configuration_fingerprint.clone()),
            is_stale: false,
            load: Some(load),
            graphics,
            system_chrome,
            recommendation,
            observations: StateCompatibilityObservationsRecord {
                last_embedded_success_at: None,
                last_external_success_at: None,
                last_fallback_at: None,
                last_launch_failure_at: None,
                last_launch_failure_code: None,
            },
        })
    }

    pub fn finish(&mut self, game_id: &str) {
        self.active.remove(game_id);
    }

    pub fn current_reports(
        games: &[StateGameRecord],
        reports: &[StateCompatibilityReportRecord],
        settings: &GameBrowserSettingsRecord,
        versions: &CompatibilityVersionRecord,
    ) -> CoreResult<Vec<StateCompatibilityReportRecord>> {
        reports
            .iter()
            .filter_map(|report| {
                games
                    .iter()
                    .find(|game| game.id == report.game_id)
                    .map(|game| (report, game))
            })
            .map(|(report, game)| {
                let mut report = report.clone();
                if let Some(previous) = report.configuration_fingerprint.as_deref() {
                    report.is_stale =
                        previous != configuration_fingerprint(game, settings, versions)?;
                }
                Ok(report)
            })
            .collect()
    }
}

fn inactive(game_id: &str) -> CoreError {
    CoreError::Domain {
        code: "COMPATIBILITY_CHECK_INACTIVE",
        message: format!("No compatibility check is running for game {game_id}."),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintInput<'a> {
    default_launch_url: &'a str,
    network: &'a crate::model::BrowserNetworkSettingsRecord,
    graphics: &'a crate::model::BrowserGraphicsSettingsRecord,
    chrome: &'a str,
    electron: &'a str,
}

fn configuration_fingerprint(
    game: &StateGameRecord,
    settings: &GameBrowserSettingsRecord,
    versions: &CompatibilityVersionRecord,
) -> CoreResult<String> {
    let encoded = serde_json::to_vec(&FingerprintInput {
        default_launch_url: &game.default_launch_url,
        network: &settings.network,
        graphics: &settings.graphics,
        chrome: &versions.chrome,
        electron: &versions.electron,
    })
    .map_err(|error| CoreError::Internal(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(encoded)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::model::CoreStateSnapshotRecord;

    fn snapshot() -> CoreStateSnapshotRecord {
        serde_json::from_value(json!({
            "games": [{
                "id": "game-1", "source": "custom", "name": "Example",
                "defaultLaunchUrl": "https://example.test/play", "browserLaunchMode": "inherit",
                "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z"
            }],
            "roles": [], "launchWorkspaces": [], "macros": [], "compatibilityReports": [],
            "gameBrowserSettings": {
                "fonts": {"mode":"default","families":{}},
                "graphics": {"mode":"automatic"}, "launchMode":"auto",
                "macroBadgePosition":{"horizontalAlign":"right","horizontalMarginPx":16,"topPx":16},
                "network":{"cdnCompatibility":{"mode":"auto"},"proxy":{"mode":"system","server":""}},
                "workspace":{"background":"material","gap":4}
            }
        })).unwrap()
    }

    fn versions() -> CompatibilityVersionRecord {
        CompatibilityVersionRecord {
            chrome: "140".to_owned(),
            electron: "40".to_owned(),
        }
    }

    fn prepare(
        runtime: &mut CompatibilityRuntime,
        state: &CoreStateSnapshotRecord,
        system_chrome_available: bool,
    ) -> CoreResult<CompatibilityCheckPlanRecord> {
        runtime.prepare(
            &state.games,
            state.game_browser_settings.as_ref().unwrap(),
            "game-1",
            system_chrome_available,
            &versions(),
        )
    }

    #[test]
    fn owns_duplicate_prevention_transitions_and_completion_decisions() {
        let mut runtime = CompatibilityRuntime::default();
        let state = snapshot();
        prepare(&mut runtime, &state, true).unwrap();
        assert_eq!(
            prepare(&mut runtime, &state, true).unwrap_err().code(),
            "COMPATIBILITY_CHECK_ACTIVE"
        );
        runtime
            .transition("game-1", CompatibilityRunPhase::Loading)
            .unwrap();
        let report = runtime
            .build_report(
                "game-1",
                CompatibilityCheckOutcome::Failed {
                    duration_ms: 42,
                    error_code: "ERR_CONNECTION_REFUSED".to_owned(),
                },
            )
            .unwrap();
        assert_eq!(report.load.unwrap().state, "failed");
        assert_eq!(
            report.recommendation.unwrap().reason,
            "external_recommended"
        );
        runtime.finish("game-1");
        assert!(runtime.statuses().is_empty());
    }

    #[test]
    fn cancellation_is_authoritative_even_when_an_effect_reports_success() {
        let mut runtime = CompatibilityRuntime::default();
        let state = snapshot();
        prepare(&mut runtime, &state, false).unwrap();
        assert!(runtime.request_cancel("game-1"));
        let report = runtime
            .build_report(
                "game-1",
                CompatibilityCheckOutcome::Loaded {
                    duration_ms: 20,
                    final_origin: Some("https://example.test".to_owned()),
                    graphics: serde_json::from_value(json!({
                        "webgl":"available", "webgl2":"available", "webgpu":"unavailable"
                    }))
                    .unwrap(),
                },
            )
            .unwrap();
        assert_eq!(report.load.unwrap().state, "cancelled");
        assert!(report.graphics.is_none());
        assert!(report.recommendation.is_none());
    }

    #[test]
    fn stale_reports_are_resolved_from_current_rust_domain_state() {
        let mut state = snapshot();
        let mut runtime = CompatibilityRuntime::default();
        prepare(&mut runtime, &state, true).unwrap();
        let report = runtime
            .build_report(
                "game-1",
                CompatibilityCheckOutcome::Failed {
                    duration_ms: 1,
                    error_code: "FAILED".to_owned(),
                },
            )
            .unwrap();
        state.compatibility_reports.push(report);
        assert!(
            !CompatibilityRuntime::current_reports(
                &state.games,
                &state.compatibility_reports,
                state.game_browser_settings.as_ref().unwrap(),
                &versions(),
            )
            .unwrap()[0]
                .is_stale
        );
        state.game_browser_settings.as_mut().unwrap().graphics.mode = "experimental".to_owned();
        assert!(
            CompatibilityRuntime::current_reports(
                &state.games,
                &state.compatibility_reports,
                state.game_browser_settings.as_ref().unwrap(),
                &versions(),
            )
            .unwrap()[0]
                .is_stale
        );
    }
}
