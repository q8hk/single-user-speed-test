<?php

require_once 'telemetry_db.php';

error_reporting(0);
putenv('GDFONTPATH='.realpath('.'));

/**
 * @param string $name
 *
 * @return string|null
 */
function tryFont($name)
{
    if (is_array(imageftbbox(12, 0, $name, 'M'))) {
        return $name;
    }

    $fullPathToFont = realpath('.').'/'.$name.'.ttf';
    if (is_array(imageftbbox(12, 0, $fullPathToFont, 'M'))) {
        return $fullPathToFont;
    }

    return null;
}

/**
 * @param int|float $d
 *
 * @return string
 */
function format($d)
{
    if ($d < 10) {
        return number_format($d, 2, '.', '');
    }
    if ($d < 100) {
        return number_format($d, 1, '.', '');
    }

    return number_format($d, 0, '.', '');
}

/**
 * @param array $speedtest
 *
 * @return array
 */
function formatSpeedtestDataForImage($speedtest)
{
    // format values for the image
    $speedtest['dl'] = format($speedtest['dl']);
    $speedtest['ul'] = format($speedtest['ul']);
    $speedtest['ping'] = format($speedtest['ping']);
    $speedtest['jitter'] = format($speedtest['jitter']);
    $speedtest['timestamp'] = $speedtest['timestamp'];

    $ispinfo = json_decode($speedtest['ispinfo'], true)['processedString'];
    $dash = strpos($ispinfo, '-');
    if ($dash !== false) {
        $ispinfo = substr($ispinfo, $dash + 2);
        $par = strrpos($ispinfo, '(');
        if ($par !== false) {
            $ispinfo = substr($ispinfo, 0, $par);
        }
    } else {
        $ispinfo = '';
    }

    $speedtest['ispinfo'] = $ispinfo;

    return $speedtest;
}

function colorHex($im, $hex, $alpha = 0)
{
    $hex = ltrim($hex, '#');

    return imagecolorallocatealpha($im, hexdec(substr($hex, 0, 2)), hexdec(substr($hex, 2, 2)), hexdec(substr($hex, 4, 2)), $alpha);
}

function loadImageResource($path)
{
    if (!is_file($path)) {
        return null;
    }

    $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    if ($extension === 'png') {
        return imagecreatefrompng($path);
    }
    if ($extension === 'jpg' || $extension === 'jpeg') {
        return imagecreatefromjpeg($path);
    }

    return null;
}

function centerText($im, $text, $font, $size, $centerX, $baselineY, $color)
{
    $bbox = imageftbbox($size, 0, $font, $text);
    $width = $bbox[2] - $bbox[0];
    imagefttext($im, $size, 0, $centerX - $width / 2, $baselineY, $color, $font, $text);
}

function filledRoundedRectangle($im, $x1, $y1, $x2, $y2, $radius, $color)
{
    imagefilledrectangle($im, $x1 + $radius, $y1, $x2 - $radius, $y2, $color);
    imagefilledrectangle($im, $x1, $y1 + $radius, $x2, $y2 - $radius, $color);
    imagefilledellipse($im, $x1 + $radius, $y1 + $radius, $radius * 2, $radius * 2, $color);
    imagefilledellipse($im, $x2 - $radius, $y1 + $radius, $radius * 2, $radius * 2, $color);
    imagefilledellipse($im, $x1 + $radius, $y2 - $radius, $radius * 2, $radius * 2, $color);
    imagefilledellipse($im, $x2 - $radius, $y2 - $radius, $radius * 2, $radius * 2, $color);
}

function findBrandLogoPaths()
{
    return [
        __DIR__.'/../branding/logo.svg',
        __DIR__.'/../branding/logo.png',
        __DIR__.'/../frontend/branding/logo.svg',
        __DIR__.'/../frontend/branding/logo.png',
        __DIR__.'/../images/logo.png',
    ];
}

function loadSvgImageResource($path)
{
    if (!class_exists('Imagick')) {
        return null;
    }

    try {
        $svg = new Imagick();
        $svg->setBackgroundColor(new ImagickPixel('transparent'));
        $svg->readImage($path);
        $svg->setImageFormat('png32');
        $image = imagecreatefromstring($svg->getImagesBlob());
        $svg->clear();
        $svg->destroy();

        return $image;
    } catch (Exception $e) {
        return null;
    }
}

function loadBrandLogoResource()
{
    foreach (findBrandLogoPaths() as $candidate) {
        if (!is_file($candidate)) {
            continue;
        }

        $extension = strtolower(pathinfo($candidate, PATHINFO_EXTENSION));
        if ($extension === 'svg') {
            $logo = loadSvgImageResource($candidate);
        } else {
            $logo = loadImageResource($candidate);
        }

        if ($logo) {
            return $logo;
        }
    }

    return null;
}

function findShareBackground()
{
    $candidates = [
        __DIR__.'/../images/background.jpeg',
        __DIR__.'/../frontend/images/background.jpeg',
    ];

    foreach ($candidates as $candidate) {
        if (is_file($candidate)) {
            return $candidate;
        }
    }

    return null;
}

function drawBrand($im, $font, $white, $cyan, $blue)
{
    $logoIm = loadBrandLogoResource();
    if ($logoIm) {
        $srcW = imagesx($logoIm);
        $srcH = imagesy($logoIm);
        $targetH = 46;
        $targetW = min(280, (int) round($srcW * $targetH / max(1, $srcH)));
        imagecopyresampled($im, $logoIm, 58, 48, 0, 0, $targetW, $targetH, $srcW, $srcH);
        imagedestroy($logoIm);

        return;
    }

    imagefttext($im, 24, 0, 58, 78, $white, $font, 'LIBRE');
    filledRoundedRectangle($im, 168, 53, 204, 81, 4, $white);
    imagefilledpolygon($im, [197, 57, 180, 68, 190, 69, 175, 78, 183, 67, 174, 66], 6, $blue);
    imagefilledpolygon($im, [194, 59, 181, 68, 190, 69, 177, 77, 188, 67, 178, 66], 6, $cyan);
    imagefttext($im, 24, 0, 214, 78, $white, $font, 'SPEED');
}

function drawGauge($im, $cx, $cy, $diameter, $thickness, $track, $accent, $highlight, $value, $label, $fontLight, $fontBold, $white, $muted)
{
    imagesetthickness($im, $thickness);
    imagearc($im, $cx, $cy, $diameter, $diameter, 180, 360, $track);
    imagearc($im, $cx, $cy, $diameter, $diameter, 180, 318, $accent);
    imagesetthickness($im, max(3, (int) ($thickness * 0.35)));
    imagearc($im, $cx, $cy, $diameter + $thickness, $diameter + $thickness, 300, 360, $highlight);
    imagesetthickness($im, 1);

    $pointerAngle = deg2rad(318);
    $pointerX = $cx + cos($pointerAngle) * ($diameter / 2);
    $pointerY = $cy + sin($pointerAngle) * ($diameter / 2);
    imagefilledpolygon($im, [$pointerX, $pointerY, $pointerX - 22, $pointerY + 34, $pointerX + 18, $pointerY + 22], 3, $white);

    centerText($im, $value, $fontLight, 62, $cx, $cy + 10, $white);
    centerText($im, 'Mbps', $fontLight, 22, $cx, $cy + 50, $muted);
    centerText($im, strtoupper($label), $fontBold, 24, $cx, $cy + 112, $muted);
}

/**
 * @param array $speedtest
 *
 * @return void
 */
function drawImage($speedtest)
{
    $data = formatSpeedtestDataForImage($speedtest);
    $dl = $data['dl'];
    $ul = $data['ul'];
    $ping = $data['ping'];
    $jit = $data['jitter'];
    $ispinfo = $data['ispinfo'];
    $timestamp = $data['timestamp'];

    $WIDTH = 1200;
    $HEIGHT = 675;
    $im = imagecreatetruecolor($WIDTH, $HEIGHT);
    imagealphablending($im, true);
    imagesavealpha($im, true);

    $FONT_BOLD = tryFont('OpenSans-Semibold');
    $FONT_LIGHT = tryFont('OpenSans-Light');

    $BACKGROUND = colorHex($im, '0e0720');
    $PANEL = colorHex($im, '251b32', 16);
    $PANEL_BORDER = colorHex($im, '625b6b', 36);
    $WHITE = colorHex($im, 'ffffff');
    $MUTED = colorHex($im, '898591');
    $CYAN = colorHex($im, '00c6df');
    $BLUE = colorHex($im, '023ec3');
    $TRACK = colorHex($im, '3e2f50');

    $backgroundPath = findShareBackground();
    $background = $backgroundPath ? loadImageResource($backgroundPath) : null;
    if ($background) {
        imagecopyresampled($im, $background, 0, 0, 0, 0, $WIDTH, $HEIGHT, imagesx($background), imagesy($background));
        imagedestroy($background);
    } else {
        imagefilledrectangle($im, 0, 0, $WIDTH, $HEIGHT, $BACKGROUND);
    }
    imagefilledrectangle($im, 0, 0, $WIDTH, $HEIGHT, colorHex($im, '0e0720', 22));
    imagefilledrectangle($im, 0, 0, $WIDTH, $HEIGHT, colorHex($im, '291a46', 48));

    filledRoundedRectangle($im, 40, 34, 1160, 632, 22, $PANEL);
    imagerectangle($im, 40, 34, 1160, 632, $PANEL_BORDER);

    drawBrand($im, $FONT_BOLD, $WHITE, $CYAN, $BLUE);
    imagefttext($im, 22, 0, 58, 126, $CYAN, $FONT_LIGHT, 'Speed test result');
    imagefttext($im, 18, 0, 880, 78, $MUTED, $FONT_LIGHT, $timestamp);

    drawGauge($im, 360, 352, 372, 32, $TRACK, $BLUE, $CYAN, $dl, 'Download', $FONT_LIGHT, $FONT_BOLD, $WHITE, $MUTED);
    drawGauge($im, 840, 352, 372, 32, $TRACK, $CYAN, $BLUE, $ul, 'Upload', $FONT_LIGHT, $FONT_BOLD, $WHITE, $MUTED);

    imagefttext($im, 20, 0, 142, 548, $MUTED, $FONT_BOLD, 'Ping:');
    imagefttext($im, 20, 0, 208, 548, $WHITE, $FONT_LIGHT, $ping.' ms');
    imagefttext($im, 20, 0, 910, 548, $MUTED, $FONT_BOLD, 'Jitter:');
    imagefttext($im, 20, 0, 995, 548, $WHITE, $FONT_LIGHT, $jit.' ms');

    imagefilledrectangle($im, 58, 580, 1142, 581, colorHex($im, '625b6b', 42));
    $serverText = trim($ispinfo) === '' ? 'Server: LibreSpeed' : 'Server: '.$ispinfo;
    imagefttext($im, 18, 0, 58, 612, $MUTED, $FONT_LIGHT, $serverText);
    imagefttext($im, 18, 0, 930, 612, $CYAN, $FONT_BOLD, 'LibreSpeed');

    header('Content-Type: image/png');
    imagepng($im);
}

$speedtest = getSpeedtestUserById($_GET['id']);
if (!is_array($speedtest)) {
    exit(1);
}

drawImage($speedtest);
