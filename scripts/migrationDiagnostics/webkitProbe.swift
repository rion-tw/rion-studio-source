// Synthetic, nonpersistent website-data API probe. Never opens a user's store.
import AppKit
import WebKit

@MainActor final class Probe: NSObject, WKNavigationDelegate {
    let store = WKWebsiteDataStore.nonPersistent()
    var view: WKWebView!
    var step = 0
    let origins = ["https://migration-one.invalid", "https://migration-two.invalid"]
    let values = ["角色\u{0000}測試", "independent-role"]

    func start() {
        guard #available(macOS 26.0, *) else { finish(["status": "unsupported", "code": "MACOS_26_REQUIRED"]); return }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = self
        next()
    }

    func next() {
        view.loadHTMLString("<!doctype html><meta charset=utf-8><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'\">", baseURL: URL(string: origins[step])!)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Only the two app-provided HTML documents; no remote resource navigation.
        let url = navigationAction.request.url?.absoluteString ?? ""
        decisionHandler(origins.contains(url.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) || url == "about:blank" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("NAVIGATION_FAILED") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("NAVIGATION_FAILED") }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let json = String(data: try! JSONSerialization.data(withJSONObject: [values[step]]), encoding: .utf8)!
        view.evaluateJavaScript("localStorage.setItem('character', \(json)[0]); localStorage.getItem('character')") { value, error in
            guard error == nil, value as? String == self.values[self.step] else { self.fail("SEED_READBACK_FAILED"); return }
            self.step += 1
            if self.step < self.origins.count { self.next(); return }
            self.export()
        }
    }

    func export() {
        guard #available(macOS 26.0, *) else { fail("MACOS_26_REQUIRED"); return }
        let cookie = HTTPCookie(properties: [.domain: "migration-one.invalid", .path: "/", .name: "probe", .value: "synthetic", .secure: "TRUE"])!
        store.httpCookieStore.setCookie(cookie) {
            self.store.httpCookieStore.getAllCookies { cookies in
                guard cookies.count == 1, cookies[0].name == "probe", cookies[0].value == "synthetic",
                      cookies[0].domain == "migration-one.invalid", cookies[0].path == "/",
                      cookies[0].isSecure, cookies[0].expiresDate == nil
                else { self.fail("COOKIE_READBACK_FAILED"); return }
                self.store.fetchData(of: [WKWebsiteDataTypeLocalStorage]) { data, error in
                    guard error == nil, let data else { self.fail("EXPORT_FAILED"); return }
                    // Payload contains synthetic values only. Rust decodes and compares exact origins and UTF-16.
                    self.finish(["status": "exported", "synthetic": true, "cookieCount": cookies.count,
                                 "serialization": data.base64EncodedString(), "osVersion": ProcessInfo.processInfo.operatingSystemVersionString])
                }
            }
        }
    }

    func fail(_ code: String) { finish(["status": "failed", "code": code]) }
    func finish(_ report: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        exit(report["status"] as? String == "exported" ? 0 : 1)
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    app.setActivationPolicy(.prohibited)
    let probe = Probe()
    probe.start()
    app.run()
}
