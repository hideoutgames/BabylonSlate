import AuthenticationServices
import Capacitor
import Foundation

/// Third-party sign-in in an ASWebAuthenticationSession: the system browser
/// sheet opens the provider page and hands back the redirect to the app's
/// callback scheme, so the scheme needs no Info.plist registration.
@objc(BabylonSlateAuthSessionPlugin)
public class BabylonSlateAuthSessionPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "BabylonSlateAuthSessionPlugin"
    public let jsName = "BabylonSlateAuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
    ]

    private var session: ASWebAuthenticationSession?

    @objc func open(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw), url.scheme == "https",
              let scheme = call.getString("callbackScheme"), !scheme.isEmpty else {
            call.reject("An https url and a callbackScheme are required")
            return
        }
        DispatchQueue.main.async {
            // One sign-in at a time: a replaced session resolves as closed.
            self.session?.cancel()
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                self?.session = nil
                if let callback {
                    call.resolve(["url": callback.absoluteString])
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    call.resolve(["url": NSNull()])
                } else {
                    call.reject("The sign-in browser failed")
                }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("The sign-in browser could not start")
            }
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
