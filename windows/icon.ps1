param([string]$LogoDirectory, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Read-Palette([string]$File) {
    [xml]$svg = Get-Content -LiteralPath (Join-Path $LogoDirectory $File) -Raw
    foreach ($shape in @($svg.svg.g.path)[0..1]) { [Drawing.ColorTranslator]::FromHtml($shape.fill) }
}

function Get-PaletteTransform($Source, $Target) {
    # Исходный PNG использует две заливки. Переносим их цвета, сохраняя альфа-канал.
    $span = $Source[1].R - $Source[0].R
    $matrix = [Drawing.Imaging.ColorMatrix]::new()
    $matrix.Matrix11 = $matrix.Matrix22 = 0
    $matrix.Matrix00 = ($Target[1].R - $Target[0].R) / $span
    $matrix.Matrix01 = ($Target[1].G - $Target[0].G) / $span
    $matrix.Matrix02 = ($Target[1].B - $Target[0].B) / $span
    $matrix.Matrix40 = ($Target[0].R - $Source[0].R * $matrix.Matrix00) / 255
    $matrix.Matrix41 = ($Target[0].G - $Source[0].R * $matrix.Matrix01) / 255
    $matrix.Matrix42 = ($Target[0].B - $Source[0].R * $matrix.Matrix02) / 255
    $attributes = [Drawing.Imaging.ImageAttributes]::new()
    $attributes.SetColorMatrix($matrix)
    return $attributes
}

function Write-Icon($Source, $Transform, [string]$Path) {
    $images = foreach ($size in 16,20,24,32,40,48,256) {
        $bitmap = [Drawing.Bitmap]::new($size, $size)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = 'HighQualityBicubic'
        $graphics.PixelOffsetMode = 'HighQuality'
        $stream = [IO.MemoryStream]::new()
        try {
            $rect = [Drawing.Rectangle]::new(0, 0, $size, $size)
            $graphics.DrawImage($Source, $rect, 0, 0, $Source.Width, $Source.Height, [Drawing.GraphicsUnit]::Pixel, $Transform)
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            @{ Size=$size; Bytes=$stream.ToArray() }
        } finally {
            $stream.Dispose()
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
    $out = [IO.BinaryWriter]::new([IO.File]::Create($Path))
    try {
        $out.Write([uint16]0)
        $out.Write([uint16]1)
        $out.Write([uint16]$images.Length)
        $offset = 6 + 16 * $images.Length
        foreach ($image in $images) {
            $out.Write([byte]($image.Size % 256))
            $out.Write([byte]($image.Size % 256))
            $out.Write([uint16]0)
            $out.Write([uint16]1)
            $out.Write([uint16]32)
            $out.Write([uint32]$image.Bytes.Length)
            $out.Write([uint32]$offset)
            $offset += $image.Bytes.Length
        }
        foreach ($image in $images) { $out.Write([byte[]]$image.Bytes) }
    } finally { $out.Dispose() }
}

$light = Read-Palette 'scv.svg'
$dark = Read-Palette 'scv-dark.svg'
$ink = [Drawing.ColorTranslator]::FromHtml('#252525')
$white = [Drawing.ColorTranslator]::FromHtml('#F4F4F4')
$source = [Drawing.Image]::FromFile((Join-Path $LogoDirectory 'scv.png'))
try {
    Write-Icon $source $null (Join-Path $OutputDirectory 'scv.ico')
    $variants = @{ 'scv-dark' = $dark; 'scv-mono' = @($ink,$ink); 'scv-mono-dark' = @($white,$white) }
    foreach ($variant in $variants.GetEnumerator()) {
        $transform = Get-PaletteTransform $light $variant.Value
        try { Write-Icon $source $transform (Join-Path $OutputDirectory ($variant.Key + '.ico')) }
        finally { $transform.Dispose() }
    }
} finally { $source.Dispose() }
