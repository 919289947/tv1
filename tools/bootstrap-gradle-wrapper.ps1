$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$wrapperDir = Join-Path $root 'android\gradle\wrapper'
$jar = Join-Path $wrapperDir 'gradle-wrapper.jar'
$checksumFile = Join-Path $wrapperDir 'gradle-wrapper.jar.sha256'
$url = 'https://services.gradle.org/distributions/gradle-8.9-wrapper.jar'
$expected = (Get-Content $checksumFile -Raw).Trim().ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') { throw 'Malformed pinned Gradle Wrapper checksum.' }

if (Test-Path $jar) {
    $actual = (Get-FileHash $jar -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -eq $expected) { exit 0 }
    Remove-Item $jar -Force
}

$tmp = "$jar.download"
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $tmp
    $actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "Gradle Wrapper SHA-256 mismatch: expected $expected, actual $actual" }
    Move-Item $tmp $jar -Force
    Write-Host "Verified official Gradle 8.9 Wrapper JAR: $jar"
}
finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
}
