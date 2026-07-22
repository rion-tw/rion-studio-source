import type {
  ExternalSessionCommand,
  ExternalSessionRecord,
  ExternalSessionResult
} from "../../src/shared/generated";

export function createExternalSessionState() {
  const sessions = new Map<string, ExternalSessionRecord>();
  const result = (): ExternalSessionResult => ({
    sessions: [...sessions.values()].map((session) => structuredClone(session))
  });
  const get = (roleId: string): ExternalSessionRecord => {
    const session = sessions.get(roleId);
    if (!session) throw new Error("External Chrome role is not running.");
    return session;
  };

  return {
    invokeExternalSession(command: ExternalSessionCommand): ExternalSessionResult {
      switch (command.type) {
        case "snapshot":
          break;
        case "begin":
          sessions.set(command.role.id, {
            role: structuredClone(command.role),
            bounds: { ...command.bounds },
            ...(command.physicalBounds ? { physicalBounds: { ...command.physicalBounds } } : {}),
            ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
            ...(command.notice ? { notice: command.notice } : {}),
            zoomFactor: command.zoomFactor,
            state: "launching",
            automationAvailable: false,
            cdnActive: false,
            pageHidden: false
          });
          break;
        case "updateRole":
          get(command.role.id).role = structuredClone(command.role);
          break;
        case "setNotice": {
          const session = get(command.roleId);
          if (command.notice === undefined) delete session.notice;
          else session.notice = command.notice;
          break;
        }
        case "setAutomation": {
          const session = get(command.roleId);
          session.automationAvailable = command.available;
          session.cdnActive = command.available && command.cdnActive;
          if (!command.available) delete session.pageHealth;
          break;
        }
        case "setRunning": {
          const session = get(command.roleId);
          session.state = "running";
          session.launchedAt = command.launchedAt;
          break;
        }
        case "setStopping":
          get(command.roleId).state = "stopping";
          break;
        case "setHealth": {
          const session = get(command.roleId);
          if (command.health === undefined) delete session.pageHealth;
          else session.pageHealth = command.health;
          session.pageHidden = command.pageHidden;
          break;
        }
        case "recordCdpTimeout":
          get(command.roleId).lastCdpTimeoutAtMs = command.atMs;
          break;
        case "remove":
          sessions.delete(command.roleId);
          break;
      }
      return result();
    }
  };
}
