/**
 * Design by fromScratch Studio - 2022, 2023 (fromscratch.io)
 * Implementation in HTML/CSS/JS by Timendus - 2024 (https://github.com/Timendus)
 *
 * See https://github.com/librespeed/speedtest/issues/585
 */

// States the UI can be in
const INITIALIZING = 0;
const READY = 1;
const RUNNING = 2;
const FINISHED = 3;
const WAITING = 4;
const COOLDOWN = 5;

// Keep some global state here
const testState = {
  state: INITIALIZING,
  speedtest: null,
  servers: [],
  selectedServerDirty: false,
  testData: null,
  testDataDirty: false,
  telemetryEnabled: false,
  queue: null,
  queuePosition: null,
  cooldownUntil: 0
};

// Bootstrap the application when the DOM is ready
window.addEventListener("DOMContentLoaded", async () => {
  applyBrandLogo();
  createSpeedtest();
  hookUpButtons();
  startRenderingLoop();
  applySettingsJSON();
  applyServerListJSON();
});

/**
 * Prefer a deployer-provided logo from branding/logo.svg or branding/logo.png.
 */
function applyBrandLogo() {
  const logos = document.querySelectorAll("[data-brand-logo]");
  if (!logos.length) return;

  const candidates = ["branding/logo.svg", "branding/logo.png"];
  if (window.fetch) {
    (async () => {
      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate, { method: "HEAD", cache: "no-store" });
          if (response.ok) {
            logos.forEach(logo => {
              logo.src = candidate;
            });
            return;
          }
        } catch (error) {
          // Keep the bundled logo if the optional branding folder is unavailable.
        }
      }
    })();
    return;
  }

  const loadCandidate = index => {
    if (index >= candidates.length) return;

    const probe = new Image();
    probe.onload = () => {
      logos.forEach(logo => {
        logo.src = candidates[index];
      });
    };
    probe.onerror = () => loadCandidate(index + 1);
    probe.src = `${candidates[index]}?r=${Date.now()}`;
  };

  loadCandidate(0);
}

/**
 * Create a new Speedtest and hook it into the global state
 */
function createSpeedtest() {
  testState.speedtest = new Speedtest();
  testState.speedtest.onupdate = data => {
    testState.testData = data;
    testState.testDataDirty = true;
  };
  testState.speedtest.onend = async aborted => {
    if (testState.queue) {
      await testState.queue.release();
      testState.queue = null;
    }
    testState.speedtest.setParameter("queue_token", "");
    testState.queuePosition = null;
    testState.state = aborted ? READY : FINISHED;
  };
}

/**
 * Make all the buttons respond to the right clicks
 */
function hookUpButtons() {
  document.querySelector("#start-button").addEventListener("click", startButtonClickHandler);
  document
    .querySelector("#choose-privacy")
    .addEventListener("click", () => document.querySelector("#privacy").showModal());
  document
    .querySelector("#share-results")
    .addEventListener("click", () => document.querySelector("#share").showModal());
  document.querySelector("#copy-link").addEventListener("click", copyLinkButtonClickHandler);
  document.querySelectorAll(".close-dialog, #close-privacy").forEach(element => {
    element.addEventListener("click", () => document.querySelectorAll("dialog").forEach(modal => modal.close()));
  });
}

/**
 * Event listener for clicks on the main start button
 */
async function startButtonClickHandler() {
  switch (testState.state) {
    case READY:
    case FINISHED:
      await joinQueueAndStart();
      return;
    case WAITING:
      if (testState.queue) await testState.queue.cancel();
      testState.queue = null;
      testState.queuePosition = null;
      testState.state = READY;
      return;
    case RUNNING:
      testState.speedtest.abort();
      // testState.state is updated by `onend` handler of speedtest
      return;
    case COOLDOWN:
      return;
    default:
      return;
  }
}

function selectedQueueURL() {
  const server = testState.speedtest.getSelectedServer();
  return server && server.server ? joinServerUrl(server.server, "queue.php") : "backend/queue.php";
}

function joinServerUrl(server, path) {
  if (!server) return path;
  if (!path) return server;
  if (server.charAt(server.length - 1) === "/" || path.charAt(0) === "/") {
    return server + path;
  }
  return server + "/" + path;
}

async function joinQueueAndStart() {
  testState.state = WAITING;
  testState.queuePosition = null;
  const queue = new SpeedtestQueueClient(selectedQueueURL(), status => {
    testState.queuePosition = status.position || null;
  });
  testState.queue = queue;

  try {
    const token = await queue.waitForTurn();
    if (testState.queue !== queue) return;
    testState.speedtest.setParameter("queue_token", token);
    queue.heartbeat();
    testState.speedtest.start();
    testState.state = RUNNING;
  } catch (error) {
    if (queue.cancelled) return;
    if (testState.queue === queue) {
      testState.queue = null;
      testState.queuePosition = null;
      console.error("Failed to enter speed test queue:", error);
      if (error.status === 429 && error.retryAfter) {
        startCooldown(error.retryAfter);
      } else {
        testState.state = READY;
      }
    }
  }
}

function startCooldown(seconds) {
  const cooldownSeconds = Math.max(1, Math.ceil(Number(seconds) || 0));
  testState.cooldownUntil = Date.now() + cooldownSeconds * 1000;
  testState.state = COOLDOWN;
}

function cooldownSecondsRemaining() {
  return Math.max(0, Math.ceil((testState.cooldownUntil - Date.now()) / 1000));
}

function formatCountdown(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

/**
 * Event listener for clicks on the "Copy link" button in the modal
 */
async function copyLinkButtonClickHandler() {
  const link = document.querySelector("img#results").src;
  if (link.startsWith("data:image/") && navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
    const blob = await fetch(link).then(response => response.blob());
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  } else {
    await navigator.clipboard.writeText(link);
  }
  const button = document.querySelector("#copy-link");
  button.classList.add("active");
  button.textContent = link.startsWith("data:image/") ? "Copied image!" : "Copied!";
  setTimeout(() => {
    button.classList.remove("active");
    button.textContent = link.startsWith("data:image/") ? "Copy image" : "Copy link";
  }, 3000);
}

/**
 * Load settings from settings.json on the server and apply them
 */
async function applySettingsJSON() {
  try {
    const response = await fetch("settings.json");
    const settings = await response.json();
    if (!settings || typeof settings !== "object") {
      return console.error("Settings are empty or malformed");
    }
    for (let setting in settings) {
      testState.speedtest.setParameter(setting, settings[setting]);
      if (
        setting == "telemetry_level" &&
        settings[setting] &&
        settings[setting] != "off" &&
        settings[setting] != "disabled" &&
        settings[setting] != "false"
      ) {
        testState.telemetryEnabled = true;
        document.querySelector("#privacy-warning").classList.remove("hidden");
      }
    }
  } catch (error) {
    console.error("Failed to fetch settings:", error);
  }
}

/**
 * Load server list from the configured source and populate the dropdown
 */
async function applyServerListJSON() {
  try {
    const serverSource =
      typeof globalThis.SPEEDTEST_SERVERS !== "undefined" ? globalThis.SPEEDTEST_SERVERS : "server-list.json";
    const servers = Array.isArray(serverSource)
      ? serverSource
      : await fetch(serverSource).then(response => response.json());
    if (!servers || !Array.isArray(servers) || servers.length === 0) {
      console.error("Server list is empty or malformed");
      useLocalServer();
      return;
    }

    testState.servers = servers;

    // If there's only one server, just show it. No reachability checks needed.
    if (servers.length === 1) {
      populateDropdown(servers);
      return;
    }

    // For multiple servers: first run the built-in selection (which pings servers
    // and annotates them with pingT). Only then populate the dropdown so that
    // dead servers don't appear.
    testState.speedtest.addTestPoints(servers);
    testState.speedtest.selectServer(bestServer => {
      const aliveServers = testState.servers.filter(s => {
        // Keep servers that responded to ping (pingT !== -1).
        if (s.pingT !== -1) return true;
        // Also keep protocol-relative servers ("//...") as a defensive fallback.
        // LibreSpeed normalizes them to the page protocol before pinging, so they
        // are normally treated like any other server and get a real pingT value.
        return typeof s.server === "string" && s.server.startsWith("//");
      });

      // Prefer to show only reachable servers, but if none are reachable,
      // fall back to the full list so users can still pick a server manually.
      if (aliveServers.length > 0) {
        testState.servers = aliveServers;
      }
      populateDropdown(testState.servers);

      if (bestServer) {
        selectServer(bestServer);
      } else {
        alert(
          "Can't reach any of the speedtest servers! But you're on this page. Something weird is going on with your network."
        );
      }
    });
  } catch (error) {
    console.error("Failed to load server list:", error);
    useLocalServer();
  }
}

function useLocalServer() {
  testState.servers = [
    {
      name: "local",
      server: "backend/",
      dlURL: "garbage.php",
      ulURL: "empty.php",
      pingURL: "empty.php",
      getIpURL: "getIP.php",
      sponsorName: "",
      sponsorURL: "",
      id: 1
    }
  ];
  populateDropdown(testState.servers);
}

/**
 * Add all the servers to the server selection dropdown and make it actually
 * work.
 * @param {Array} servers - an array of server objects
 */
function populateDropdown(servers) {
  const serverSelector = document.querySelector("div.server-selector");
  const serverList = serverSelector.querySelector("ul.servers");

  // Reset previous state (populateDropdown can be called multiple times)
  serverSelector.classList.remove("single-server");
  serverSelector.classList.remove("active");
  serverList.classList.remove("active");
  serverList.innerHTML = "";

  // If we have only a single server, just show it
  if (servers.length === 1) {
    serverSelector.classList.add("single-server");
    selectServer(servers[0]);
    return;
  }
  serverSelector.classList.add("active");

  // Make the dropdown open and close (hook only once)
  if (serverSelector.dataset.hooked !== "1") {
    serverSelector.dataset.hooked = "1";

    serverSelector.addEventListener("click", () => {
      serverList.classList.toggle("active");
    });
    document.addEventListener("click", e => {
      if (e.target.closest("div.server-selector") !== serverSelector) serverList.classList.remove("active");
    });
  }

  // Sort servers by country, then by city within the same country.
  // Name formats: "City, Country", "City, Country (qualifier)", "City, Country, Provider", "Country"
  const parseServerName = name => {
    const parts = (name || "").split(",").map(s => s.trim());
    let country, city;
    if (parts.length >= 3) {
      // "City, Country, Provider" — use second part as country
      country = parts[1];
      city = parts[0];
    } else if (parts.length === 2) {
      country = parts[1];
      city = parts[0];
    } else {
      country = parts[0];
      city = "";
    }
    // Strip parenthetical qualifiers for sorting: "Germany (1) (Hetzner)" → "Germany"
    country = country.replace(/\s*\([^)]*\)\s*/g, "").trim();
    return { country, city };
  };
  const sorted = [...servers].sort((a, b) => {
    const pa = parseServerName(a.name);
    const pb = parseServerName(b.name);
    return pa.country.localeCompare(pb.country) || pa.city.localeCompare(pb.city);
  });

  // Populate the list to choose from
  sorted.forEach(server => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    link.innerHTML = `${server.name}${server.sponsorName ? ` <span>(${server.sponsorName})</span>` : ""}`;
    link.addEventListener("click", () => selectServer(server));
    item.appendChild(link);
    serverList.appendChild(item);
  });
}

/**
 * Set the given server as the selected server for the speedtest
 * @param {Object} server - a server object
 */
function selectServer(server) {
  testState.speedtest.setSelectedServer(server);
  testState.selectedServerDirty = true;
  testState.state = READY;
}

/**
 * Start the requestAnimationFrame UI rendering loop
 */
function startRenderingLoop() {
  // Do these queries once to speed up the rendering itself
  const serverSelector = document.querySelector("div.server-selector");
  const selectedServer = serverSelector.querySelector("#selected-server");
  const sponsor = serverSelector.querySelector("#sponsor");
  const startButton = document.querySelector("#start-button");
  const privacyWarning = document.querySelector("#privacy-warning");

  const gauges = document.querySelectorAll("#download-gauge, #upload-gauge");
  const downloadProgress = document.querySelector("#download-gauge .progress");
  const uploadProgress = document.querySelector("#upload-gauge .progress");
  const downloadGauge = document.querySelector("#download-gauge .speed");
  const uploadGauge = document.querySelector("#upload-gauge .speed");
  const downloadText = document.querySelector("#download-gauge span");
  const uploadText = document.querySelector("#upload-gauge span");

  const pingAndJitter = document.querySelectorAll(".ping, .jitter");
  const ping = document.querySelector("#ping");
  const jitter = document.querySelector("#jitter");
  const shareResults = document.querySelector("#share-results");
  const copyLink = document.querySelector("#copy-link");
  const resultsImage = document.querySelector("#results");
  let lastShareSignature = "";

  const buttonTexts = {
    [INITIALIZING]: "Loading...",
    [READY]: "Let's start",
    [RUNNING]: "Abort",
    [FINISHED]: "Restart",
    [WAITING]: "Cancel wait",
    [COOLDOWN]: ""
  };

  // Show copy link button only if navigator.clipboard is available
  copyLink.classList.toggle("hidden", !navigator.clipboard);

  function renderUI() {
    // Make the main button reflect the current state
    const cooldownRemaining = cooldownSecondsRemaining();
    if (testState.state === COOLDOWN && cooldownRemaining <= 0) {
      testState.cooldownUntil = 0;
      testState.state = READY;
    }
    startButton.textContent = buttonText(cooldownRemaining);
    startButton.classList.toggle("disabled", testState.state === INITIALIZING || testState.state === COOLDOWN);
    startButton.classList.toggle("active", testState.state === RUNNING);
    startButton.classList.toggle("waiting", testState.state === WAITING);
    startButton.classList.toggle("cooldown", testState.state === COOLDOWN);

    // Disable the server selector while test is running
    serverSelector.classList.toggle("disabled", testState.state === RUNNING || testState.state === WAITING);

    // Show selected server
    if (testState.selectedServerDirty) {
      const server = testState.speedtest.getSelectedServer();
      selectedServer.textContent = server.name;
      if (server.sponsorName) {
        if (server.sponsorURL) {
          sponsor.innerHTML = `Sponsor: <a href="${server.sponsorURL}">${server.sponsorName}</a>`;
        } else {
          sponsor.textContent = `Sponsor: ${server.sponsorName}`;
        }
      } else {
        sponsor.innerHTML = "&nbsp;";
      }
      testState.selectedServerDirty = false;
    }

    // Activate the gauges when test running or finished
    gauges.forEach(e => e.classList.toggle("enabled", testState.state === RUNNING || testState.state === FINISHED));

    // Show ping and jitter if data is available
    pingAndJitter.forEach(e =>
      e.classList.toggle(
        "hidden",
        !(testState.testData && testState.testData.pingStatus && testState.testData.jitterStatus)
      )
    );

    const canShareResults = testState.state === FINISHED && hasFinishedResultData(testState.testData);
    shareResults.classList.toggle("hidden", !canShareResults);

    if (!canShareResults) {
      lastShareSignature = "";
      resultsImage.removeAttribute("src");
    } else {
      const server = testState.speedtest.getSelectedServer();
      const shareSignature = JSON.stringify({
        testId: testState.testData.testId || "",
        dl: testState.testData.dlStatus,
        ul: testState.testData.ulStatus,
        ping: testState.testData.pingStatus,
        jitter: testState.testData.jitterStatus,
        server: server ? server.name : ""
      });

      if (shareSignature !== lastShareSignature) {
        if (testState.testData.testId) {
          resultsImage.src =
            window.location.href.substring(0, window.location.href.lastIndexOf("/")) +
            "/results/?id=" +
            testState.testData.testId;
          copyLink.textContent = "Copy link";
        } else {
          resultsImage.src = createShareResultImage(testState.testData, server);
          copyLink.textContent = "Copy image";
        }
        lastShareSignature = shareSignature;
      }
    }

    if (testState.testDataDirty) {
      // Set gauge rotations
      downloadProgress.style = `--progress-rotation: ${testState.testData.dlProgress * 180}deg`;
      uploadProgress.style = `--progress-rotation: ${testState.testData.ulProgress * 180}deg`;
      downloadGauge.style = `--speed-rotation: ${mbpsToRotation(
        testState.testData.dlStatus,
        testState.testData.testState === 1
      )}deg`;
      uploadGauge.style = `--speed-rotation: ${mbpsToRotation(
        testState.testData.ulStatus,
        testState.testData.testState === 3
      )}deg`;

      // Set numeric values
      downloadText.textContent = numberToText(testState.testData.dlStatus);
      uploadText.textContent = numberToText(testState.testData.ulStatus);
      ping.textContent = numberToText(testState.testData.pingStatus);
      jitter.textContent = numberToText(testState.testData.jitterStatus);

      // Set user's IP and provider
      if (testState.testData.clientIp) {
        // Clear previous content
        privacyWarning.innerHTML = "";

        const connectedThrough = document.createElement("span");
        connectedThrough.textContent = "You are connected through:";

        const ipAddress = document.createTextNode(testState.testData.clientIp);

        privacyWarning.appendChild(connectedThrough);
        privacyWarning.appendChild(document.createElement("br"));
        privacyWarning.appendChild(ipAddress);

        privacyWarning.classList.remove("hidden");
      }

      testState.testDataDirty = false;
    }

    requestAnimationFrame(renderUI);
  }

  renderUI();

  function buttonText(cooldownRemaining) {
    if (testState.state === WAITING && testState.queuePosition) {
      return `Waiting: #${testState.queuePosition} (cancel)`;
    }
    if (testState.state === COOLDOWN) {
      return `Try again in ${formatCountdown(cooldownRemaining)}`;
    }
    return buttonTexts[testState.state];
  }
}

/**
 * Convert a speed in Mbits per second to a rotation for the gauge
 * @param {string} speed Speed in Mbits
 * @param {boolean} oscillate If the gauge should wiggle a bit
 * @returns {number} Rotation for the gauge in degrees
 */
function mbpsToRotation(speed, oscillate) {
  speed = Number(speed);
  if (speed <= 0) return 0;

  const minSpeed = 0;
  const maxSpeed = 10000; // 10 Gbps maxes out the gauge
  const minRotation = 0;
  const maxRotation = 180;

  // Can't do log10 of values less than one, +1 all to keep it fair
  const logMinSpeed = Math.log10(minSpeed + 1);
  const logMaxSpeed = Math.log10(maxSpeed + 1);
  const logSpeed = Math.log10(speed + 1);

  const power = (logSpeed - logMinSpeed) / (logMaxSpeed - logMinSpeed);
  const oscillation = oscillate ? 1 + 0.01 * Math.sin(Date.now() / 100) : 1;
  const rotation = power * oscillation * maxRotation;

  // Make sure we stay within bounds at all times
  return Math.max(Math.min(rotation, maxRotation), minRotation);
}

/**
 * Convert a number to a user friendly version
 * @param {string} value Speed, ping or jitter
 * @returns {string} A text version with proper decimals
 */
function numberToText(value) {
  if (!value) return "00";
  value = Number(value);
  if (value < 10) return value.toFixed(2);
  if (value < 100) return value.toFixed(1);
  return value.toFixed(0);
}

function hasFinishedResultData(data) {
  return !!(data && data.dlStatus && data.ulStatus && data.pingStatus && data.jitterStatus);
}

function createShareResultImage(data, server) {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext("2d");

  const colors = {
    background: "#0e0720",
    panel: "rgba(37, 27, 50, 0.88)",
    border: "rgba(98, 91, 107, 0.55)",
    track: "#3e2f50",
    white: "#ffffff",
    muted: "#898591",
    cyan: "#00c6df",
    blue: "#023ec3"
  };

  drawShareBackground(ctx, canvas.width, canvas.height, colors);
  roundRect(ctx, 40, 34, 1120, 598, 22, colors.panel, colors.border);
  drawShareBrand(ctx, colors);

  ctx.font = "300 22px Inter, Arial, sans-serif";
  ctx.fillStyle = colors.cyan;
  ctx.fillText("Speed test result", 58, 126);

  ctx.font = "300 18px Inter, Arial, sans-serif";
  ctx.fillStyle = colors.muted;
  ctx.textAlign = "right";
  ctx.fillText(formatShareTimestamp(new Date()), 1142, 78);
  ctx.textAlign = "left";

  drawShareGauge(ctx, 360, 352, 372, colors.blue, colors.cyan, numberToText(data.dlStatus), "Download", colors);
  drawShareGauge(ctx, 840, 352, 372, colors.cyan, colors.blue, numberToText(data.ulStatus), "Upload", colors);

  drawShareStat(ctx, 142, 548, "Ping:", `${numberToText(data.pingStatus)} ms`, colors);
  drawShareStat(ctx, 910, 548, "Jitter:", `${numberToText(data.jitterStatus)} ms`, colors);

  ctx.strokeStyle = "rgba(98, 91, 107, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(58, 580);
  ctx.lineTo(1142, 580);
  ctx.stroke();

  ctx.font = "300 18px Inter, Arial, sans-serif";
  ctx.fillStyle = colors.muted;
  ctx.fillText(`Server: ${server && server.name ? server.name : "LibreSpeed"}`, 58, 612);
  ctx.font = "700 18px Inter, Arial, sans-serif";
  ctx.fillStyle = colors.cyan;
  ctx.textAlign = "right";
  ctx.fillText("LibreSpeed", 1142, 612);
  ctx.textAlign = "left";

  return canvas.toDataURL("image/png");
}

function drawShareBackground(ctx, width, height, colors) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, colors.background);
  gradient.addColorStop(0.55, "#1b1230");
  gradient.addColorStop(1, colors.background);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  let seed = 42;
  for (let i = 0; i < 420; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const x = (seed / 0xffffffff) * width;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const y = (seed / 0xffffffff) * height;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const alpha = 0.12 + (seed / 0xffffffff) * 0.32;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fillRect(x, y, 1.2, 1.2);
  }

  ctx.fillStyle = "rgba(41, 26, 70, 0.58)";
  ctx.fillRect(0, 0, width, height);
}

function drawShareBrand(ctx, colors) {
  ctx.fillStyle = colors.white;
  ctx.font = "700 24px Inter, Arial, sans-serif";
  ctx.fillText("LIBRE", 58, 78);

  roundRect(ctx, 168, 53, 36, 28, 4, colors.white);
  ctx.fillStyle = colors.blue;
  ctx.beginPath();
  ctx.moveTo(197, 57);
  ctx.lineTo(180, 68);
  ctx.lineTo(190, 69);
  ctx.lineTo(175, 78);
  ctx.lineTo(183, 67);
  ctx.lineTo(174, 66);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors.cyan;
  ctx.beginPath();
  ctx.moveTo(194, 59);
  ctx.lineTo(181, 68);
  ctx.lineTo(190, 69);
  ctx.lineTo(177, 77);
  ctx.lineTo(188, 67);
  ctx.lineTo(178, 66);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = colors.white;
  ctx.fillText("SPEED", 214, 78);
}

function drawShareGauge(ctx, cx, cy, diameter, accent, highlight, value, label, colors) {
  const radius = diameter / 2;
  ctx.lineCap = "butt";
  ctx.lineWidth = 32;
  ctx.strokeStyle = colors.track;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI, 0);
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, Math.PI, Math.PI * 1.77);
  ctx.stroke();

  ctx.lineWidth = 11;
  ctx.strokeStyle = highlight;
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 18, Math.PI * 1.67, Math.PI * 1.98);
  ctx.stroke();
  ctx.lineWidth = 1;

  const pointerAngle = Math.PI * 1.77;
  const pointerX = cx + Math.cos(pointerAngle) * radius;
  const pointerY = cy + Math.sin(pointerAngle) * radius;
  ctx.fillStyle = colors.white;
  ctx.beginPath();
  ctx.moveTo(pointerX, pointerY);
  ctx.lineTo(pointerX - 22, pointerY + 34);
  ctx.lineTo(pointerX + 18, pointerY + 22);
  ctx.closePath();
  ctx.fill();

  ctx.textAlign = "center";
  ctx.fillStyle = colors.white;
  ctx.font = "200 62px Inter, Arial, sans-serif";
  ctx.fillText(value, cx, cy + 10);
  ctx.fillStyle = colors.muted;
  ctx.font = "300 22px Inter, Arial, sans-serif";
  ctx.fillText("Mbps", cx, cy + 50);
  ctx.font = "700 24px Inter, Arial, sans-serif";
  ctx.fillText(label.toUpperCase(), cx, cy + 112);
  ctx.textAlign = "left";
}

function drawShareStat(ctx, x, y, label, value, colors) {
  ctx.font = "700 20px Inter, Arial, sans-serif";
  ctx.fillStyle = colors.muted;
  ctx.fillText(label, x, y);
  ctx.font = "300 20px Inter, Arial, sans-serif";
  ctx.fillStyle = colors.white;
  ctx.fillText(value, x + ctx.measureText(label).width + 10, y);
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();

  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function formatShareTimestamp(date) {
  return date
    .toLocaleString("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    })
    .replace(",", "");
}
