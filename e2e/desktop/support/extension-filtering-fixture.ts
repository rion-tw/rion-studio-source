import { browser } from '@wdio/globals';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface FixtureObservation {
  loaded: boolean;
  ready: boolean;
  error: string | null;
  events: string[];
  dispose: () => void;
}
type ObservedContents = Electron.WebContents & { rionFilteringFixture?: FixtureObservation };

/** Observe the fixture's native events without holding a bridge request open. */
export async function seedFilteringFixture(url: string, directory: string, label: string): Promise<void> {
  const contentsId = await browser.electron.execute((electron, exactUrl, path) => {
    const matches = electron.webContents.getAllWebContents().filter(w => w.getURL() === exactUrl);
    if (matches.length !== 1) throw new Error('Exact filtering Role missing');
    const contents = matches[0] as ObservedContents;
    if (contents.rionFilteringFixture) throw new Error('Filtering fixture observation already active');
    const session = contents.session;
    // This manually loaded fixture is not a Core assignment. A reopened Role
    // reuses the session, so retire this exact package before reseeding it.
    const fixturePath = (value: string) => value.replaceAll('\\', '/');
    const retired: string[] = [];
    for (const extension of session.extensions.getAllExtensions()) {
      if (fixturePath(extension.path) === fixturePath(path)) {
        session.extensions.removeExtension(extension.id);
        retired.push(extension.id);
      }
    }
    const observation: FixtureObservation = {
      loaded: false, ready: false, error: null,
      events: retired.map(id => `retired:${id}`), dispose: () => {}
    };
    const onConsole = (_event: Electron.Event, details: Electron.MessageDetails) => {
      observation.events.push(`console:${details.level}:${details.message}`);
      if (details.message === 'RION_FILTERING_FIXTURE_READY') observation.ready = true;
      else if (details.source === 'javascript' && details.level === 3) observation.error = details.message;
    };
    const onStatus = ({ versionId, runningStatus }: Electron.ServiceWorkersRunningStatusChangedEventParams) => {
      observation.events.push(`worker:${versionId}:${runningStatus}`);
    };
    observation.dispose = () => {
      session.serviceWorkers.removeListener('console-message', onConsole);
      session.serviceWorkers.removeListener('running-status-changed', onStatus);
    };
    contents.rionFilteringFixture = observation;
    session.serviceWorkers.on('console-message', onConsole);
    session.serviceWorkers.on('running-status-changed', onStatus);
    void session.extensions.loadExtension(path).then(extension => {
      observation.events.push(`loaded:${extension.id}`);
      observation.loaded = true;
    }, error => { observation.error = String(error); });
    return contents.id;
  }, url, directory);
  try {
    // Test-only external liveness deadline. Only both native load and the actual
    // worker acknowledgement establish readiness; elapsed time always fails.
    await browser.waitUntil(async () => {
      const state = await browser.electron.execute((electron, id, exactUrl) => {
        const contents = electron.webContents.fromId(id) as ObservedContents | undefined;
        if (!contents || contents.isDestroyed() || contents.getURL() !== exactUrl || !contents.rionFilteringFixture) {
          throw new Error('Filtering fixture target retired');
        }
        const { loaded, ready, error, events } = contents.rionFilteringFixture;
        return { loaded, ready, error, events };
      }, contentsId, url);
      if (state.error) throw new Error(`Filtering fixture failed: ${JSON.stringify(state)}`);
      return state.loaded && state.ready;
    }, { timeout: 30_000, timeoutMsg: 'Filtering fixture native readiness was not acknowledged' });
  } finally {
    const evidence = await browser.electron.execute((electron, id) => {
      const contents = electron.webContents.fromId(id) as ObservedContents | undefined;
      const state = contents?.rionFilteringFixture;
      if (!state) return { retired: true };
      state.dispose();
      delete contents!.rionFilteringFixture;
      const { loaded, ready, error, events } = state;
      return { loaded, ready, error, events };
    }, contentsId);
    await writeFile(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, `filtering-fixture-${label}.json`),
      JSON.stringify(evidence, null, 2));
  }
}
