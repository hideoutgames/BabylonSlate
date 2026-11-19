# The FeatureTest perf route's process sampler on Windows (HAPTIC_PERF_MEMORY, feature-test-perf-route.spec.ts).
# Samples, every IntervalMs until the stop file appears (or 90 minutes pass), for each pid in Pids:
# its dedicated GPU memory (sum of its `GPU Process Memory` Dedicated Usage instances) and its private bytes.
# Rows: epoch ms, pid, dedicated bytes, private bytes. Counters are created once; ReadCategory reads every instance in one call.
param([string]$Out, [string]$Stop, [string]$Pids, [int]$IntervalMs = 250)
$deadline = (Get-Date).AddMinutes(90)
$ids = $Pids.Split(",") | Where-Object { $_ } | ForEach-Object { [int]$_ }
$category = New-Object System.Diagnostics.PerformanceCounterCategory("GPU Process Memory")
$writer = New-Object System.IO.StreamWriter($Out, $false)
$writer.WriteLine("epochMs,pid,dedicated,private")
$epoch = [DateTime]::new(1970, 1, 1, 0, 0, 0, [DateTimeKind]::Utc)
try {
  while (-not (Test-Path $Stop) -and (Get-Date) -lt $deadline) {
    $now = [long]([DateTime]::UtcNow - $epoch).TotalMilliseconds
    $dedicated = @{}
    try {
      $data = $category.ReadCategory()
      $usage = $data["Dedicated Usage"]
      foreach ($name in $usage.Keys) {
        if ($name -match "^pid_(\d+)_") {
          $id = [int]$Matches[1]
          if ($ids -contains $id) { $dedicated[$id] = [long]$dedicated[$id] + [long]$usage[$name].RawValue }
        }
      }
    } catch {}
    foreach ($id in $ids) {
      $private = -1
      try { $private = [System.Diagnostics.Process]::GetProcessById($id).PrivateMemorySize64 } catch {}
      $writer.WriteLine("$now,$id,$([long]$dedicated[$id]),$private")
    }
    $writer.Flush()
    $elapsed = [long]([DateTime]::UtcNow - $epoch).TotalMilliseconds - $now
    $wait = $IntervalMs - $elapsed
    if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
  }
} finally {
  $writer.Close()
}
