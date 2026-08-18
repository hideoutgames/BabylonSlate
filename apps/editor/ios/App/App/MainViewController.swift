import Capacitor

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BabylonSlateSecretsPlugin())
        bridge?.registerPluginInstance(BabylonSlateFolderPlugin())
    }
}
