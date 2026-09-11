import Capacitor
import Foundation
import os

/// Process and system memory counters for the Play debugger stats HUD.
///
/// WKWebView content runs in a separate WebContent process, so these values
/// cover the host app process and the device only; the JS side must label
/// them accordingly rather than presenting them as total page RAM.
@objc(BabylonSlateMemoryPlugin)
public class BabylonSlateMemoryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BabylonSlateMemoryPlugin"
    public let jsName = "BabylonSlateMemory"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "stats", returnType: CAPPluginReturnPromise),
    ]

    @objc func stats(_ call: CAPPluginCall) {
        call.resolve([
            "appFootprintBytes": appFootprintBytes() ?? NSNull(),
            "appAvailableBytes": appAvailableBytes() ?? NSNull(),
            "systemAvailableBytes": systemAvailableBytes() ?? NSNull(),
        ])
    }

    /// Physical memory footprint of this app process (what Xcode reports).
    private func appFootprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.stride / MemoryLayout<integer_t>.stride
        )
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebounded in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebounded, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return UInt64(info.phys_footprint)
    }

    /// Bytes this app process may still allocate before jetsam terminates it.
    private func appAvailableBytes() -> UInt64? {
        let available = os_proc_available_memory()
        guard available >= 0 else { return nil }
        return UInt64(available)
    }

    /// Device-wide reclaimable memory: free + inactive + purgeable pages.
    private func systemAvailableBytes() -> UInt64? {
        var stats = vm_statistics64_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride
        )
        let result = withUnsafeMutablePointer(to: &stats) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebounded in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, rebounded, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        var pageSize = vm_size_t()
        guard host_page_size(mach_host_self(), &pageSize) == KERN_SUCCESS else { return nil }
        let pages = UInt64(stats.free_count)
            + UInt64(stats.inactive_count)
            + UInt64(stats.purgeable_count)
        return pages * UInt64(pageSize)
    }
}
