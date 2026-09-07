import AVFoundation
import Capacitor
import Foundation

@objc(BabylonSlateAudioLifecyclePlugin)
public class BabylonSlateAudioLifecyclePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BabylonSlateAudioLifecyclePlugin"
    public let jsName = "BabylonSlateAudioLifecycle"
    public let pluginMethods: [CAPPluginMethod] = []

    override public func load() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            print("BabylonSlateAudioLifecycle: session setup failed", error.localizedDescription)
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        if type == .began {
            notifyListeners("audioInterruption", data: ["type": "began"])
            return
        }

        var shouldResume = false
        if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
            shouldResume = options.contains(.shouldResume)
        }
        notifyListeners("audioInterruption", data: [
            "type": "ended",
            "shouldResume": shouldResume,
        ])
    }

    @objc func handleRouteChange(_ notification: Notification) {
        var reason = -1
        if let userInfo = notification.userInfo,
           let number = userInfo[AVAudioSessionRouteChangeReasonKey] as? NSNumber {
            reason = number.intValue
        }
        notifyListeners("audioRouteChange", data: ["reason": reason])
    }
}
