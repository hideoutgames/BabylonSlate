$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BabylonSlateMemory {
    [StructLayout(LayoutKind.Sequential)]
    public struct Performance {
        public uint Size;
        public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal,
            PhysicalAvailable, SystemCache, KernelTotal, KernelPaged,
            KernelNonpaged, PageSize;
        public uint HandleCount, ProcessCount, ThreadCount;
    }
    [DllImport("psapi.dll", SetLastError=true)]
    public static extern bool GetPerformanceInfo(out Performance info, uint size);
}
'@
$info = New-Object BabylonSlateMemory+Performance
$size = [Runtime.InteropServices.Marshal]::SizeOf($info)
if (-not [BabylonSlateMemory]::GetPerformanceInfo([ref]$info, $size)) {
    throw "GetPerformanceInfo failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$pageBytes = $info.PageSize.ToUInt64()
@{
    totalBytes = $info.PhysicalTotal.ToUInt64() * $pageBytes
    availableBytes = $info.PhysicalAvailable.ToUInt64() * $pageBytes
    systemCommitLimitBytes = $info.CommitLimit.ToUInt64() * $pageBytes
    systemCommitAvailableBytes = ($info.CommitLimit.ToUInt64() - $info.CommitTotal.ToUInt64()) * $pageBytes
    source = 'GetPerformanceInfo (pages multiplied by PageSize)'
} | ConvertTo-Json -Compress
