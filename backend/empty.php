<?php

require_once __DIR__ . '/queue_lib.php';
speedtest_queue_handle_preflight();

if ($_SERVER['REQUEST_METHOD'] === 'POST' || ($_GET['queue'] ?? '') === 'stability') {
    speedtest_queue_require_active_token();
}

header('HTTP/1.1 200 OK');

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
header('Cache-Control: post-check=0, pre-check=0', false);
header('Pragma: no-cache');
header('Connection: keep-alive');
