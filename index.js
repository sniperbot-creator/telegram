require(“dotenv”).config();

const { Telegraf } = require(“telegraf”);
const https = require(“https”);
const http = require(“http”);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_ID.split(”,”).map((id) => parseInt(id.trim()));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE = process.env.GITHUB_FILE || “index.html”;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || “main”;
const SERVICE_URL = process.env.SERVICE_URL || “https://telegram-vudh.onrender.com”;

if (!BOT_TOKEN) throw new Error(“Missing BOT_TOKEN”);
if (!GITHUB_TOKEN) throw new Error(“Missing GITHUB_TOKEN”);
if (!GITHUB_REPO) throw new Error(“Missing GITHUB_REPO”);

// Track who is waiting to enter a value
const waitingForInput = new Set();

function githubRequest(method, path, body) {
return new Promise((resolve, reject) => {
const data = body ? JSON.stringify(body) : null;
const options = {
hostname: “api.github.com”,
path,
method,
headers: {
Authorization: `Bearer ${GITHUB_TOKEN}`,
“User-Agent”: “sol-bot”,
“Content-Type”: “application/json”,
Accept: “application/vnd.github+json”,
…(data && { “Content-Length”: Buffer.byteLength(data) }),
},
};

```
const req = https.request(options, (res) => {
  let raw = "";
  res.on("data", (chunk) => (raw += chunk));
  res.on("end", () => {
    try { resolve(JSON.parse(raw)); }
    catch { resolve(raw); }
  });
});

req.on("error", reject);
if (data) req.write(data);
req.end();
```

});
}

async function getFile() {
const result = await githubRequest(
“GET”,
`/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
);
if (result.message) throw new Error(`GitHub: ${result.message}`);
const content = Buffer.from(result.content, “base64”).toString(“utf8”);
return { content, sha: result.sha };
}

function extractSol(content) {
const match = content.match(/<span id="solAmount">([^<]+)</span>/);
return match ? match[1] : “unknown”;
}

function replaceSol(content, newValue) {
return content.replace(
/(<span id="solAmount">)[^<]+(</span>)/,
`$1${newValue}$2`
);
}

async function updateFile(newValue) {
const { content, sha } = await getFile();
const updated = replaceSol(content, newValue);
const encoded = Buffer.from(updated).toString(“base64”);

const result = await githubRequest(
“PUT”,
`/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
{
message: `Update SOL requirement to ${newValue}`,
content: encoded,
sha,
branch: GITHUB_BRANCH,
}
);

if (result.message && result.message !== “ok”) {
throw new Error(`GitHub: ${result.message}`);
}
}

const bot = new Telegraf(BOT_TOKEN);

bot.command(“start”, (ctx) => {
ctx.reply(“👋 Send /sol to update the SOL requirement.”);
});

bot.command(“sol”, async (ctx) => {
if (!ALLOWED_USER_IDS.includes(ctx.from.id)) return ctx.reply(“Unauthorized.”);

try {
const { content } = await getFile();
const current = extractSol(content);
waitingForInput.add(ctx.from.id);
await ctx.reply(
`Current SOL requirement: *${current} SOL*\n\nReply with the new value (e.g. 3, 8, 1.5):`,
{ parse_mode: “Markdown” }
);
} catch (err) {
await ctx.reply(`❌ Failed to fetch file: ${err.message}`);
}
});

bot.on(“text”, async (ctx) => {
if (!ALLOWED_USER_IDS.includes(ctx.from.id)) return ctx.reply(“Unauthorized.”);
if (!waitingForInput.has(ctx.from.id)) return;

const input = ctx.message.text.trim();

if (!/^\d+(.\d+)?$/.test(input)) {
return ctx.reply(“Invalid. Send a number like 2, 3.5, etc.”);
}

waitingForInput.delete(ctx.from.id);

try {
await ctx.reply(“⏳ Updating…”);
await updateFile(input);
await ctx.reply(`✅ SOL requirement updated to *${input} SOL* on GitHub!`, {
parse_mode: “Markdown”,
});
} catch (err) {
await ctx.reply(`❌ Error: ${err.message}`);
}
});

// HTTP server so Render detects an open port
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
res.writeHead(200);
res.end(“Bot is running.”);
}).listen(PORT, () => {
console.log(`HTTP server listening on port ${PORT}`);
});

// Self-ping every 4 minutes to prevent Render free tier from sleeping
setInterval(() => {
https.get(SERVICE_URL, (res) => {
console.log(`[keep-alive] ping sent, status: ${res.statusCode}`);
}).on(“error”, (err) => {
console.error(`[keep-alive] ping failed: ${err.message}`);
});
}, 4 * 60 * 1000);

// Clear any stale webhook before starting polling
bot.telegram.deleteWebhook({ drop_pending_updates: true })
.then(() => {
bot.launch({ dropPendingUpdates: true });
console.log(“Bot is running…”);
})
.catch((err) => {
console.error(“Failed to delete webhook:”, err.message);
bot.launch({ dropPendingUpdates: true });
console.log(“Bot is running (webhook delete skipped)…”);
});

process.once(“SIGINT”, () => bot.stop(“SIGINT”));
process.once(“SIGTERM”, () => bot.stop(“SIGTERM”));
