#!/usr/bin/env node
// Local proxy: forwards requests to api.anthropic.com with OAuth auth.
// Also proxies to IBM watsonx.ai, handling IAM token exchange server-side.

const { createServer } = require("http");
const { request: httpsRequest } = require("https");
const fs = require("fs");
const path = require("path");

// ── Configuration ───────────────────────────────────────────────────────────

const PORT = 7337;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_RPM = 10;
const WX_MODEL = "ibm/granite-3-8b-instruct";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, anthropic-version, anthropic-beta, ibm-api-key, ibm-project-id",
  "Access-Control-Allow-Private-Network": "true",  // Chrome Private Network Access
};

// ── Minimal .env loader (no dotenv dependency) ──────────────────────────────

const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, "");
  }
}

const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) {
  console.error("Error: CLAUDE_CODE_OAUTH_TOKEN not set. Copy .env.example -> .env and fill it in.");
  process.exit(1);
}

// ── Rate limiter ────────────────────────────────────────────────────────────

let reqCount = 0;
setInterval(() => { reqCount = 0; }, 60_000);

// ── Helpers ─────────────────────────────────────────────────────────────────

function collectBody(stream) {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (chunk) => { data += chunk; });
    stream.on("end", () => resolve(data));
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname, path, method: "POST", headers }, resolve);
    req.on("error", reject);
    req.end(body);
  });
}

function forwardToAnthropic(msg, res) {
  if (!msg.model?.startsWith("claude-")) msg.model = DEFAULT_MODEL;
  const payload = JSON.stringify(msg);

  console.log(`-> anthropic  ${payload.length}b  model=${msg.model}`);

  const apiReq = httpsRequest({
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "authorization": `Bearer ${token}`,
      "content-length": Buffer.byteLength(payload),
    },
  }, (apiRes) => {
    console.log(`<- anthropic  ${apiRes.statusCode}`);
    if (apiRes.statusCode !== 200) {
      collectBody(apiRes).then((body) => {
        console.error("Anthropic error:", body);
        res.writeHead(apiRes.statusCode, CORS_HEADERS);
        res.end(body);
      });
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, "content-type": apiRes.headers["content-type"] ?? "text/event-stream" });
    apiRes.pipe(res);
  });

  apiReq.on("error", (err) => {
    console.error("Anthropic request failed:", err.message);
    if (!res.headersSent) res.writeHead(500, CORS_HEADERS);
    res.end();
  });

  apiReq.end(payload);
}

// ── IBM IAM token cache ──────────────────────────────────────────────────────

const iamCache = {};  // keyed by apiKey

async function getIAMToken(apiKey) {
  const cached = iamCache[apiKey];
  if (cached && Date.now() < cached.exp) return cached.token;

  const body = `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(apiKey)}`;
  const iamRes = await httpsPost(
    "iam.cloud.ibm.com",
    "/identity/token",
    { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
    body
  );
  const raw = await collectBody(iamRes);
  if (iamRes.statusCode !== 200) throw new Error(`IAM auth failed (${iamRes.statusCode}): ${raw}`);
  const { access_token, expires_in } = JSON.parse(raw);
  iamCache[apiKey] = { token: access_token, exp: Date.now() + (expires_in - 60) * 1000 };
  return access_token;
}

async function forwardToWatsonx(msg, ibmApiKey, projectId, res) {
  let iamToken;
  try {
    iamToken = await getIAMToken(ibmApiKey);
  } catch (err) {
    console.error("IAM error:", err.message);
    res.writeHead(401, CORS_HEADERS);
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  // Inject watsonx-required fields
  msg.model_id = msg.model_id || WX_MODEL;
  msg.project_id = projectId;
  delete msg.model;  // watsonx uses model_id

  const payload = JSON.stringify(msg);
  console.log(`-> watsonx  ${payload.length}b  model=${msg.model_id}`);

  const apiReq = httpsRequest({
    hostname: "us-south.ml.cloud.ibm.com",
    path: "/ml/v1/text/chat?version=2023-05-29",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${iamToken}`,
      "content-length": Buffer.byteLength(payload),
    },
  }, (apiRes) => {
    console.log(`<- watsonx  ${apiRes.statusCode}`);
    if (apiRes.statusCode !== 200) {
      collectBody(apiRes).then((body) => {
        console.error("watsonx error:", body);
        res.writeHead(apiRes.statusCode, CORS_HEADERS);
        res.end(body);
      });
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, "content-type": apiRes.headers["content-type"] ?? "text/event-stream" });
    apiRes.pipe(res);
  });

  apiReq.on("error", (err) => {
    console.error("watsonx request failed:", err.message);
    if (!res.headersSent) res.writeHead(500, CORS_HEADERS);
    res.end();
  });

  apiReq.end(payload);
}

// ── Server ──────────────────────────────────────────────────────────────────

function handleRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.url === "/watsonx") {
    const ibmApiKey = req.headers["ibm-api-key"];
    const projectId = req.headers["ibm-project-id"];
    if (!ibmApiKey || !projectId) {
      res.writeHead(400, CORS_HEADERS);
      res.end("Missing ibm-api-key or ibm-project-id headers");
      return;
    }
    collectBody(req).then((raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
      forwardToWatsonx(msg, ibmApiKey, projectId, res);
    });
    return;
  }

  if (req.url === "/v1/messages") {
    if (++reqCount > MAX_RPM) {
      console.warn(`Rate limit hit (${MAX_RPM} req/min)`);
      res.writeHead(429, CORS_HEADERS);
      res.end();
      return;
    }
    collectBody(req).then((raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { res.writeHead(400); res.end("Bad JSON"); return; }
      forwardToAnthropic(msg, res);
    });
    return;
  }

  res.writeHead(404);
  res.end();
}

createServer(handleRequest).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Claude proxy  -> http://127.0.0.1:${PORT}/v1/messages`);
  console.log(`  watsonx proxy -> http://127.0.0.1:${PORT}/watsonx`);
  console.log(`  Token: ${token.slice(0, 8)}...${token.slice(-4)}\n`);
});
