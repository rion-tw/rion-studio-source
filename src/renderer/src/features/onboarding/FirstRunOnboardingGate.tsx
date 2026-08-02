import { type JSX } from "react";
import { useNavigate } from "react-router";

import type { useAppData } from "../../hooks/useAppData";
import type { useFirstRunOnboarding } from "../../hooks/useFirstRunOnboarding";
import type { usePreferences } from "../../hooks/usePreferences";
import type { useRoleWorkflow } from "../../hooks/useRoleWorkflow";
import { FirstRunOnboarding } from "./FirstRunOnboarding";

interface FirstRunOnboardingGateProps {
  controller: ReturnType<typeof useFirstRunOnboarding>;
  data: Pick<
    ReturnType<typeof useAppData>,
    "error" | "games" | "roles" | "setError" | "statusByRole"
  >;
  notice: string | null;
  preferences: Pick<ReturnType<typeof usePreferences>, "language" | "t">;
  roleWorkflow: Pick<
    ReturnType<typeof useRoleWorkflow>,
    "handleLaunch" | "isSaving" | "saveRole"
  >;
}

export function FirstRunOnboardingGate({
  controller,
  data,
  notice,
  preferences,
  roleWorkflow
}: FirstRunOnboardingGateProps): JSX.Element {
  const navigate = useNavigate();

  return (
    <FirstRunOnboarding
      error={data.error}
      games={data.games}
      isSaving={roleWorkflow.isSaving}
      isSuccessPresented={controller.isSuccessPresented}
      language={preferences.language}
      notice={notice}
      progress={controller.progress}
      roles={data.roles}
      statusByRole={data.statusByRole}
      t={preferences.t}
      onClearError={() => data.setError(null)}
      onComplete={controller.complete}
      onCustomGame={() => {
        controller.skip();
        navigate("/games/new", { replace: true });
      }}
      onDismissSuccess={() => {
        controller.dismissSuccess();
        navigate("/dashboard", { replace: true });
      }}
      onLaunch={roleWorkflow.handleLaunch}
      onOpenLater={() => {
        controller.skip();
        navigate("/roles", { replace: true });
      }}
      onSave={roleWorkflow.saveRole}
      onSkip={() => {
        controller.skip();
        navigate("/dashboard", { replace: true });
      }}
      onUpdateProgress={controller.updateProgress}
    />
  );
}
