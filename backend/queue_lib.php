<?php

const SPEEDTEST_QUEUE_ACTIVE_TTL = 45;
const SPEEDTEST_QUEUE_ACTIVE_MAX_SECONDS = 120;
const SPEEDTEST_QUEUE_WAITING_TTL = 30;
const SPEEDTEST_QUEUE_MAX_WAITING = 100;
const SPEEDTEST_QUEUE_RATE_WINDOW = 60;
const SPEEDTEST_QUEUE_MAX_JOINS_PER_WINDOW = 5;
const SPEEDTEST_QUEUE_COOLDOWN_SECONDS = 300;
const SPEEDTEST_QUEUE_MAX_TRACKED_CLIENTS = 5000;
const SPEEDTEST_QUEUE_TOKEN_HEADER = 'HTTP_X_SPEEDTEST_QUEUE_TOKEN';

function speedtest_queue_state_file()
{
    $configured = getenv('SPEEDTEST_QUEUE_FILE');
    if ($configured) {
        return $configured;
    }

    $directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'librespeed-queue';
    if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to create the speed test queue directory');
    }
    @chmod($directory, 0700);

    return $directory . DIRECTORY_SEPARATOR . 'queue.json';
}

function speedtest_queue_with_lock($callback)
{
    $path = speedtest_queue_state_file();
    $directory = dirname($path);
    if (!is_dir($directory) || !is_writable($directory)) {
        throw new RuntimeException('Speed test queue directory is not writable');
    }
    if (is_link($path)) {
        throw new RuntimeException('Speed test queue file must not be a symbolic link');
    }

    $oldUmask = umask(0077);
    $handle = fopen($path, 'c+');
    umask($oldUmask);
    if ($handle === false) {
        throw new RuntimeException('Unable to open the speed test queue');
    }
    @chmod($path, 0600);
    if (!flock($handle, LOCK_EX)) {
        fclose($handle);
        throw new RuntimeException('Unable to lock the speed test queue');
    }

    try {
        rewind($handle);
        $raw = stream_get_contents($handle);
        $decoded = json_decode($raw ?: '', true);
        if (!is_array($decoded)) {
            $decoded = [];
        }
        // Keep only recognized fields so malformed or obsolete data cannot
        // accumulate indefinitely in the state file.
        $state = [
            'active' => is_array($decoded['active'] ?? null) ? $decoded['active'] : null,
            'waiting' => is_array($decoded['waiting'] ?? null) ? $decoded['waiting'] : [],
            'rateLimits' => is_array($decoded['rateLimits'] ?? null) ? $decoded['rateLimits'] : [],
            'cooldowns' => is_array($decoded['cooldowns'] ?? null) ? $decoded['cooldowns'] : [],
            'secret' => is_string($decoded['secret'] ?? null) ? $decoded['secret'] : null,
        ];
        if (!is_string($state['secret']) || strlen($state['secret']) < 32) {
            $state['secret'] = bin2hex(random_bytes(32));
        }

        $now = time();
        speedtest_queue_collect_garbage($state, $now);

        $result = $callback($state, $now);
        speedtest_queue_collect_garbage($state, $now);

        rewind($handle);
        ftruncate($handle, 0);
        if (fwrite($handle, json_encode($state, JSON_UNESCAPED_SLASHES)) === false) {
            throw new RuntimeException('Unable to save the speed test queue');
        }
        fflush($handle);

        return $result;
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

function speedtest_queue_apply_cooldown(&$state, $clientKey, $now)
{
    if (is_string($clientKey) && $clientKey !== '') {
        $state['cooldowns'][$clientKey] = $now + SPEEDTEST_QUEUE_COOLDOWN_SECONDS;
    }
}

function speedtest_queue_trim_map(&$entries, $timestampField)
{
    if (count($entries) <= SPEEDTEST_QUEUE_MAX_TRACKED_CLIENTS) {
        return;
    }
    uasort($entries, function ($left, $right) use ($timestampField) {
        return ($right[$timestampField] ?? 0) <=> ($left[$timestampField] ?? 0);
    });
    $entries = array_slice($entries, 0, SPEEDTEST_QUEUE_MAX_TRACKED_CLIENTS, true);
}

function speedtest_queue_collect_garbage(&$state, $now)
{
    if (
        !empty($state['active'])
        && !preg_match('/^[a-f0-9]{48}$/', (string) ($state['active']['token'] ?? ''))
    ) {
        $state['active'] = null;
    }
    if (
        !empty($state['active'])
        && (
            ($state['active']['expiresAt'] ?? 0) <= $now
            || ($state['active']['maxExpiresAt'] ?? 0) <= $now
        )
    ) {
        speedtest_queue_apply_cooldown($state, $state['active']['clientKey'] ?? '', $now);
        $state['active'] = null;
    }

    $state['waiting'] = array_values(array_filter(
        is_array($state['waiting']) ? $state['waiting'] : [],
        function ($entry) use ($now) {
            return is_array($entry)
                && preg_match('/^[a-f0-9]{48}$/', (string) ($entry['token'] ?? ''))
                && ($entry['expiresAt'] ?? 0) > $now;
        }
    ));
    $state['rateLimits'] = array_filter(
        is_array($state['rateLimits']) ? $state['rateLimits'] : [],
        function ($entry) use ($now) {
            return is_array($entry)
                && ($entry['windowStartedAt'] ?? 0) + SPEEDTEST_QUEUE_RATE_WINDOW > $now;
        }
    );
    $state['cooldowns'] = array_filter(
        is_array($state['cooldowns']) ? $state['cooldowns'] : [],
        function ($expiresAt) use ($now) {
            return is_numeric($expiresAt) && (int) $expiresAt > $now;
        }
    );

    speedtest_queue_trim_map($state['rateLimits'], 'windowStartedAt');
    if (count($state['cooldowns']) > SPEEDTEST_QUEUE_MAX_TRACKED_CLIENTS) {
        arsort($state['cooldowns'], SORT_NUMERIC);
        $state['cooldowns'] = array_slice(
            $state['cooldowns'],
            0,
            SPEEDTEST_QUEUE_MAX_TRACKED_CLIENTS,
            true
        );
    }
}

function speedtest_queue_promote(&$state, $now)
{
    while (empty($state['active']) && !empty($state['waiting'])) {
        $next = array_shift($state['waiting']);
        $clientKey = $next['clientKey'] ?? '';
        if (($state['cooldowns'][$clientKey] ?? 0) > $now) {
            continue;
        }
        $state['active'] = [
            'token' => $next['token'],
            'clientKey' => $clientKey,
            'expiresAt' => $now + SPEEDTEST_QUEUE_ACTIVE_TTL,
            'maxExpiresAt' => $now + SPEEDTEST_QUEUE_ACTIVE_MAX_SECONDS,
        ];
    }
}

function speedtest_queue_client_key($state)
{
    $address = isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : 'unknown';
    return hash_hmac('sha256', $address, $state['secret']);
}

function speedtest_queue_rate_limit_join(&$state, $now)
{
    $key = speedtest_queue_client_key($state);
    $entry = $state['rateLimits'][$key] ?? ['windowStartedAt' => $now, 'joins' => 0];
    if ($entry['windowStartedAt'] + SPEEDTEST_QUEUE_RATE_WINDOW <= $now) {
        $entry = ['windowStartedAt' => $now, 'joins' => 0];
    }
    if ($entry['joins'] >= SPEEDTEST_QUEUE_MAX_JOINS_PER_WINDOW) {
        $retryAfter = max(1, $entry['windowStartedAt'] + SPEEDTEST_QUEUE_RATE_WINDOW - $now);
        header('Retry-After: ' . $retryAfter);
        http_response_code(429);
        return false;
    }
    $entry['joins']++;
    $state['rateLimits'][$key] = $entry;
    return true;
}

function speedtest_queue_cooldown_allows_join($state, $clientKey, $now)
{
    $expiresAt = (int) ($state['cooldowns'][$clientKey] ?? 0);
    if ($expiresAt <= $now) {
        return true;
    }
    $retryAfter = max(1, $expiresAt - $now);
    header('Retry-After: ' . $retryAfter);
    http_response_code(429);
    return false;
}

function speedtest_queue_client_is_waiting($state, $clientKey)
{
    foreach ($state['waiting'] as $entry) {
        if (hash_equals((string) ($entry['clientKey'] ?? ''), $clientKey)) {
            return true;
        }
    }
    return false;
}

function speedtest_queue_allowed_origins()
{
    $configured = getenv('SPEEDTEST_ALLOWED_ORIGINS');
    if (!$configured) {
        return [];
    }
    return array_values(array_filter(array_map('trim', explode(',', $configured))));
}

function speedtest_queue_origin_is_same_host($origin)
{
    $parts = parse_url($origin);
    if (!is_array($parts) || empty($parts['host']) || empty($_SERVER['HTTP_HOST'])) {
        return false;
    }
    $originHost = strtolower($parts['host']);
    $originPort = isset($parts['port']) ? (int) $parts['port'] : (($parts['scheme'] ?? '') === 'https' ? 443 : 80);

    $requestHost = strtolower((string) $_SERVER['HTTP_HOST']);
    $requestPort = isset($_SERVER['SERVER_PORT']) ? (int) $_SERVER['SERVER_PORT'] : 80;
    if ($requestHost[0] === '[') {
        $closingBracket = strpos($requestHost, ']');
        $hostOnly = substr($requestHost, 1, $closingBracket - 1);
        $portText = substr($requestHost, $closingBracket + 1);
        if (strpos($portText, ':') === 0) {
            $requestPort = (int) substr($portText, 1);
        }
    } else {
        $hostParts = explode(':', $requestHost, 2);
        $hostOnly = $hostParts[0];
        if (isset($hostParts[1])) {
            $requestPort = (int) $hostParts[1];
        }
    }

    return hash_equals($hostOnly, $originHost) && $requestPort === $originPort;
}

function speedtest_queue_apply_cors()
{
    header('Referrer-Policy: no-referrer');
    header('X-Content-Type-Options: nosniff');
    $origin = isset($_SERVER['HTTP_ORIGIN']) ? rtrim((string) $_SERVER['HTTP_ORIGIN'], '/') : '';
    if ($origin === '') {
        return;
    }

    $allowed = speedtest_queue_origin_is_same_host($origin);
    foreach (speedtest_queue_allowed_origins() as $configuredOrigin) {
        if (hash_equals(rtrim($configuredOrigin, '/'), $origin)) {
            $allowed = true;
            break;
        }
    }
    if (!$allowed) {
        http_response_code(403);
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode(['error' => 'Origin is not allowed']);
        exit;
    }

    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Encoding, Content-Type, X-Speedtest-Queue-Token');
    header('Access-Control-Max-Age: 600');
    header('Vary: Origin');
}

function speedtest_queue_require_secure_transport()
{
    $allowInsecure = filter_var(getenv('SPEEDTEST_ALLOW_INSECURE_HTTP'), FILTER_VALIDATE_BOOLEAN);
    $assumeHttps = filter_var(getenv('SPEEDTEST_ASSUME_HTTPS'), FILTER_VALIDATE_BOOLEAN);
    $https = $assumeHttps
        || (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off')
        || (isset($_SERVER['SERVER_PORT']) && (int) $_SERVER['SERVER_PORT'] === 443);
    $hostHeader = strtolower((string) ($_SERVER['HTTP_HOST'] ?? ''));
    if (strpos($hostHeader, '[') === 0 && ($closingBracket = strpos($hostHeader, ']')) !== false) {
        $host = substr($hostHeader, 1, $closingBracket - 1);
    } else {
        $host = explode(':', $hostHeader, 2)[0];
    }
    $localDevelopment = in_array($host, ['localhost', '127.0.0.1', '::1'], true);

    if (!$https && !$allowInsecure && !$localDevelopment) {
        http_response_code(426);
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode(['error' => 'HTTPS is required for speed test queue leases']);
        exit;
    }
}

function speedtest_queue_handle_preflight()
{
    speedtest_queue_require_secure_transport();
    speedtest_queue_apply_cors();
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function speedtest_queue_request_token()
{
    $token = isset($_SERVER[SPEEDTEST_QUEUE_TOKEN_HEADER])
        ? trim((string) $_SERVER[SPEEDTEST_QUEUE_TOKEN_HEADER])
        : '';
    if (!preg_match('/^[a-f0-9]{48}$/', $token)) {
        return '';
    }
    return $token;
}

function speedtest_queue_require_active_token()
{
    speedtest_queue_handle_preflight();
    $token = speedtest_queue_request_token();
    $valid = speedtest_queue_with_lock(function (&$state, $now) use ($token) {
        speedtest_queue_promote($state, $now);
        if (
            $token === ''
            || empty($state['active'])
            || !hash_equals($state['active']['token'], $token)
            || ($state['active']['maxExpiresAt'] ?? 0) <= $now
        ) {
            return false;
        }
        $state['active']['expiresAt'] = min(
            $now + SPEEDTEST_QUEUE_ACTIVE_TTL,
            $state['active']['maxExpiresAt']
        );
        return true;
    });

    if (!$valid) {
        http_response_code(423);
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode(['error' => 'A valid active queue lease is required']);
        exit;
    }
}
