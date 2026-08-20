const WORKSPACE_CONTAINED_FULLSCREEN_CHANNEL_TOKEN: &str =
    "__RION_CONTAINED_FULLSCREEN_CHANNEL__";
const WORKSPACE_CONTAINED_FULLSCREEN_SOURCE: &str =
    include_str!("workspace_contained_fullscreen.js");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WebviewSurfaceFeaturePolicy {
    Role,
    WorkspaceWeb,
    Utility,
}

impl WebviewSurfaceFeaturePolicy {
    fn installs_role_features(self) -> bool {
        self == Self::Role
    }

    fn installs_contained_fullscreen(self) -> bool {
        self == Self::WorkspaceWeb
    }
}

fn workspace_contained_fullscreen_script() -> String {
    WORKSPACE_CONTAINED_FULLSCREEN_SOURCE.replace(
        WORKSPACE_CONTAINED_FULLSCREEN_CHANNEL_TOKEN,
        &uuid::Uuid::new_v4().to_string(),
    )
}

fn require_workspace_contained_fullscreen_policy(
    result: RuntimeResult<()>,
) -> Result<(), RoleSurfaceSetupFailure> {
    result.map_err(|error| RoleSurfaceSetupFailure {
        error,
        lifecycle: None,
    })
}
