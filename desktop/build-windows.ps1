[CmdletBinding()]
param([switch]$SkipWebBuild, [switch]$NoZip)

$ErrorActionPreference = 'Stop'
$desktopRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $desktopRoot '..'))
$sdkVersion = '1.0.4314.35'
$sdkChecksum = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
$packageDirectory = Join-Path $desktopRoot '.packages'
$packagePath = Join-Path $packageDirectory "microsoft.web.webview2.$sdkVersion.nupkg"
$sdkDirectory = Join-Path $packageDirectory "Microsoft.Web.WebView2.$sdkVersion"
$releaseRoot = Join-Path $projectRoot 'release'
$outputDirectory = Join-Path $releaseRoot 'SciPlot-Windows'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$standalonePath = Join-Path $projectRoot '简图-SciPlot.html'

if (-not (Test-Path -LiteralPath $compilerPath)) { throw '未找到 .NET Framework C# 编译器，请在 Windows x64 上安装 .NET Framework 4.8 后构建。' }
if (-not $SkipWebBuild) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw '构建前端需要 Node.js 20 或更新版本。已生成独立 HTML 时，可添加 -SkipWebBuild。' }
    & $nodeCommand.Source (Join-Path $projectRoot 'build-standalone.mjs')
    if ($LASTEXITCODE -ne 0) { throw '独立版 HTML 构建失败。' }
}
if (-not (Test-Path -LiteralPath $standalonePath)) { throw '缺少 简图-SciPlot.html，请先运行 node build-standalone.mjs。' }
New-Item -ItemType Directory -Path $packageDirectory, $sdkDirectory, $outputDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath $packagePath)) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $packageUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    Write-Host "正在下载微软官方 WebView2 SDK $sdkVersion …"
    Invoke-WebRequest -Uri $packageUrl -OutFile $packagePath -UseBasicParsing
}
if ((Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash -ne $sdkChecksum) {
    throw "WebView2 SDK 校验失败。请检查或移除这个缓存文件后重新下载：$packagePath"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$sdkFiles = @(
    'lib/net462/Microsoft.Web.WebView2.Core.dll',
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll',
    'runtimes/win-x64/native/WebView2Loader.dll',
    'LICENSE.txt', 'NOTICE.txt'
)
$archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
try {
    foreach ($relative in $sdkFiles) {
        $entry = $archive.GetEntry($relative)
        if (-not $entry) { throw "SDK 缺少所需文件：$relative" }
        $targetPath = Join-Path $sdkDirectory $relative
        New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($targetPath)) -Force | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
    }
} finally { $archive.Dispose() }

& (Join-Path $desktopRoot 'create-icon.ps1')
$coreDll = Join-Path $sdkDirectory 'lib/net462/Microsoft.Web.WebView2.Core.dll'
$formsDll = Join-Path $sdkDirectory 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
$executablePath = Join-Path $outputDirectory 'SciPlot.exe'
$compilerArguments = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/warn:4', '/codepage:65001', '/utf8output',
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    "/reference:$coreDll", "/reference:$formsDll",
    "/win32icon:$(Join-Path $desktopRoot 'sciplot.ico')",
    "/win32manifest:$(Join-Path $desktopRoot 'app.manifest')",
    "/resource:$standalonePath,SciPlot.index.html",
    "/out:$executablePath", (Join-Path $desktopRoot 'Program.cs')
)
& $compilerPath @compilerArguments
if ($LASTEXITCODE -ne 0) { throw '桌面应用编译失败。若应用正在运行，请关闭后重试。' }

Copy-Item -LiteralPath $coreDll -Destination $outputDirectory -Force
Copy-Item -LiteralPath $formsDll -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $sdkDirectory 'runtimes/win-x64/native/WebView2Loader.dll') -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $desktopRoot 'App.config') -Destination (Join-Path $outputDirectory 'SciPlot.exe.config') -Force
Copy-Item -LiteralPath (Join-Path $desktopRoot 'README.md') -Destination (Join-Path $outputDirectory '使用说明.md') -Force
Copy-Item -LiteralPath $standalonePath -Destination $outputDirectory -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'examples') -Destination $outputDirectory -Recurse -Force
$licensesDirectory = Join-Path $outputDirectory 'licenses'
New-Item -ItemType Directory -Path $licensesDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sdkDirectory 'LICENSE.txt') -Destination (Join-Path $licensesDirectory 'Microsoft.WebView2.LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdkDirectory 'NOTICE.txt') -Destination (Join-Path $licensesDirectory 'Microsoft.WebView2.NOTICE.txt') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'assets/SHEETJS-LICENSE.txt') -Destination $licensesDirectory -Force

$buildInformation = @{
    application = '简图 SciPlot'; version = '1.0.0'; architecture = 'x64'; framework = '.NET Framework 4.8'
    webView2Sdk = $sdkVersion; webView2PackageSha256 = $sdkChecksum
    embeddedHtmlSha256 = (Get-FileHash -LiteralPath $standalonePath -Algorithm SHA256).Hash
    executableSha256 = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash
}
$buildInformation | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDirectory 'build-info.json') -Encoding UTF8
Write-Host "已生成 Windows x64 桌面应用：$executablePath"
if (-not $NoZip) {
    $zipPath = Join-Path $releaseRoot 'SciPlot-Windows-x64.zip'
    Compress-Archive -LiteralPath $outputDirectory -DestinationPath $zipPath -Force
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    "$zipHash  SciPlot-Windows-x64.zip" | Set-Content -LiteralPath (Join-Path $releaseRoot 'SHA256SUMS.txt') -Encoding ASCII
    Write-Host "已打包：$zipPath"
    Write-Host "SHA256: $zipHash"
}
