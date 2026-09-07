import { expect } from "vitest";

// URL equality is permitted only as the exact BFCache event's security fence.
// Surface close/quiesce completion must still never infer success from a URL.
export function expectNoMacosLifecycleUrlReconciliation(source: string): void {
  const signature = "- (void)userContentController:(WKUserContentController *)controller";
  const endSignature = "\n- (BOOL)respondsToSelector:";
  expect(source.split(signature)).toHaveLength(2);
  const start = source.indexOf(signature);
  const end = source.indexOf(endSignature, start);
  expect(end).toBeGreaterThan(start);
  const callback = source.slice(start, end);
  for (const guard of [
    "!self.historyRestored", "!lease.context", "lease.quiesceRequested",
    "message.webView != webView", "!message.frameInfo.isMainFrame",
    '![message.body isEqual:@"restored"]',
    "![message.frameInfo.request.URL isEqual:webView.URL]"
  ]) expect(callback).toContain(guard);
  expect(callback).toContain("self.historyRestored(lease.context, url)");
  expect(callback).not.toContain("emitIsolationEvent");
  expect(callback).not.toContain("finishContextAcknowledgingRelease");
  expect(source).toContain('[WKContentWorld worldWithName:@"rion-workspace-history"]');
  expect(source).toContain("event.isTrusted && event.persisted");
  expect(source).toContain("forMainFrameOnly:YES inContentWorld:world");
  expect(source.slice(0, start) + source.slice(end)).not.toContain("webView.URL");
}

