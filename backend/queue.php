<?php

require_once __DIR__ . '/queue_lib.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
speedtest_queue_handle_preflight();

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    header('Allow: POST, OPTIONS');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$input = json_decode(file_get_contents('php://input') ?: '{}', true);
$action = is_array($input) && isset($input['action']) ? (string) $input['action'] : '';
$token = is_array($input) && isset($input['token']) ? (string) $input['token'] : '';

try {
    $response = speedtest_queue_with_lock(function (&$state, $now) use ($action, $token) {
        if ($action === 'join') {
            $clientKey = speedtest_queue_client_key($state);
            if (!speedtest_queue_cooldown_allows_join($state, $clientKey, $now)) {
                return ['error' => 'Please wait five minutes before running another speed test'];
            }
            if (speedtest_queue_client_is_present($state, $clientKey)) {
                http_response_code(409);
                return ['error' => 'This client is already queued or running a speed test'];
            }
            if (!speedtest_queue_rate_limit_join($state, $now)) {
                return ['error' => 'Too many queue joins. Please wait before trying again'];
            }
            if (count($state['waiting']) >= SPEEDTEST_QUEUE_MAX_WAITING) {
                http_response_code(503);
                return ['error' => 'The speed test queue is full'];
            }
            $token = bin2hex(random_bytes(24));
            $state['waiting'][] = [
                'token' => $token,
                'clientKey' => $clientKey,
                'expiresAt' => $now + SPEEDTEST_QUEUE_WAITING_TTL,
            ];
        } elseif (!in_array($action, ['status', 'heartbeat', 'leave', 'release'], true)) {
            http_response_code(400);
            return ['error' => 'Invalid queue action'];
        } elseif (!preg_match('/^[a-f0-9]{48}$/', $token)) {
            http_response_code(400);
            return ['error' => 'Invalid queue token'];
        }

        if ($action === 'leave' || $action === 'release') {
            if (!empty($state['active']) && hash_equals($state['active']['token'], $token)) {
                speedtest_queue_apply_cooldown(
                    $state,
                    $state['active']['clientKey'] ?? '',
                    $now
                );
                $state['active'] = null;
            }
            $state['waiting'] = array_values(array_filter(
                $state['waiting'],
                function ($entry) use ($token) {
                    return !hash_equals($entry['token'], $token);
                }
            ));
            speedtest_queue_promote($state, $now);
            return ['status' => 'released'];
        }

        foreach ($state['waiting'] as &$entry) {
            if (hash_equals($entry['token'], $token)) {
                $entry['expiresAt'] = $now + SPEEDTEST_QUEUE_WAITING_TTL;
                break;
            }
        }
        unset($entry);

        speedtest_queue_promote($state, $now);

        if (!empty($state['active']) && hash_equals($state['active']['token'], $token)) {
            if (($state['active']['maxExpiresAt'] ?? 0) <= $now) {
                $state['active'] = null;
                speedtest_queue_promote($state, $now);
                http_response_code(410);
                return ['error' => 'Queue lease reached its maximum duration'];
            }
            $state['active']['expiresAt'] = min(
                $now + SPEEDTEST_QUEUE_ACTIVE_TTL,
                $state['active']['maxExpiresAt']
            );
            return [
                'status' => 'active',
                'leaseSeconds' => SPEEDTEST_QUEUE_ACTIVE_TTL,
                'position' => 0,
            ] + ($action === 'join' ? ['token' => $token] : []);
        }

        foreach ($state['waiting'] as $index => $entry) {
            if (hash_equals($entry['token'], $token)) {
                return [
                    'status' => 'waiting',
                    'position' => $index + 1,
                ] + ($action === 'join' ? ['token' => $token] : []);
            }
        }

        http_response_code(404);
        return ['error' => 'Queue entry expired'];
    });
} catch (Throwable $error) {
    http_response_code(503);
    $response = ['error' => 'Queue service unavailable'];
}

echo json_encode($response);
