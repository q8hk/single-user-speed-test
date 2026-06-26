(function (global) {
  "use strict";

  function QueueClient(url, onStatus) {
    this.url = url;
    this.onStatus = onStatus || function () {};
    this.token = null;
    this.timer = null;
    this.cancelled = false;
  }

  QueueClient.prototype.request = async function (action) {
    const response = await fetch(this.url, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action, token: this.token }),
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || "Queue request failed");
      error.status = response.status;
      error.retryAfter = Number(response.headers.get("Retry-After")) || null;
      throw error;
    }
    if (data.token) this.token = data.token;
    return data;
  };

  QueueClient.prototype.waitForTurn = async function () {
    this.cancelled = false;
    let data = await this.request("join");
    while (!this.cancelled && data.status !== "active") {
      this.onStatus(data);
      await new Promise((resolve) => {
        this.timer = setTimeout(resolve, 1500);
      });
      if (!this.cancelled) data = await this.request("status");
    }
    if (this.cancelled) throw new Error("Queue wait cancelled");
    this.onStatus(data);
    return this.token;
  };

  QueueClient.prototype.heartbeat = function () {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.request("heartbeat").catch(() => this.onStatus({ status: "error" }));
    }, 10000);
  };

  QueueClient.prototype.release = async function () {
    this.cancelled = true;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    if (!this.token) return;
    try {
      await this.request("release");
    } catch (error) {
      // The server-side lease expires automatically if release cannot be sent.
    } finally {
      this.token = null;
    }
  };

  QueueClient.prototype.cancel = function () {
    return this.release();
  };

  global.SpeedtestQueueClient = QueueClient;
})(globalThis);
