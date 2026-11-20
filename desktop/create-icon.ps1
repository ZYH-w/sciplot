param([string]$OutputDirectory = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
[System.IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null

function New-IconPng {
    param([int]$Size)
    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#146C5D'))
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $axis = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#8BC8B5'), [single][Math]::Max(0.9, $Size * 0.0275))
    $curve = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [single][Math]::Max(1.35, $Size * 0.053))
    $rounded = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $stream = [System.IO.MemoryStream]::new()
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $inset = [single]($Size * 0.015)
        $edge = [single]($Size - 2 * $inset)
        $diameter = [single]($Size * 0.44)
        $rounded.AddArc($inset, $inset, $diameter, $diameter, 180, 90)
        $rounded.AddArc(($inset + $edge - $diameter), $inset, $diameter, $diameter, 270, 90)
        $rounded.AddArc(($inset + $edge - $diameter), ($inset + $edge - $diameter), $diameter, $diameter, 0, 90)
        $rounded.AddArc($inset, ($inset + $edge - $diameter), $diameter, $diameter, 90, 90)
        $rounded.CloseFigure()
        $graphics.FillPath($background, $rounded)
        $axis.StartCap = $axis.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $curve.StartCap = $curve.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $curve.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $factor = $Size / 40.0
        $axes = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new([single](9 * $factor), [single](11 * $factor)),
            [System.Drawing.PointF]::new([single](9 * $factor), [single](30 * $factor)),
            [System.Drawing.PointF]::new([single](32 * $factor), [single](30 * $factor))
        )
        $points = [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new([single](9 * $factor), [single](26 * $factor)),
            [System.Drawing.PointF]::new([single](16 * $factor), [single](18 * $factor)),
            [System.Drawing.PointF]::new([single](23 * $factor), [single](23 * $factor)),
            [System.Drawing.PointF]::new([single](31 * $factor), [single](11 * $factor))
        )
        $graphics.DrawLines($axis, $axes)
        $graphics.DrawLines($curve, $points)
        $radius = [single][Math]::Max(1.1, $Size * 0.044)
        foreach ($point in $points[1..3]) {
            $graphics.FillEllipse($white, ($point.X - $radius), ($point.Y - $radius), (2 * $radius), (2 * $radius))
        }
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    }
    finally {
        $stream.Dispose()
        $rounded.Dispose()
        $curve.Dispose()
        $axis.Dispose()
        $white.Dispose()
        $background.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

# PNG-backed ICO frames are supported on the Windows 10/11 target. This avoids
# creating unmanaged HICON handles entirely; all GDI+ resources are disposed.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = [System.Collections.Generic.List[byte[]]]::new()
foreach ($size in $sizes) { $frames.Add((New-IconPng -Size $size)) }
$iconPath = Join-Path $OutputDirectory 'sciplot.ico'
$output = [System.IO.File]::Open($iconPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$writer = [System.IO.BinaryWriter]::new($output)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = [uint32](6 + 16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dimension)
        $writer.Write([byte]$dimension)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$frames[$i].Length)
        $writer.Write($offset)
        $offset += [uint32]$frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write($frame) }
}
finally {
    $writer.Dispose()
    $output.Dispose()
}
[System.IO.File]::WriteAllBytes((Join-Path $OutputDirectory 'sciplot.png'), $frames[$frames.Count - 1])
Write-Output "Created $iconPath"
