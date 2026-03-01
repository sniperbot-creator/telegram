require("dotenv").config();

const { Telegraf, Scenes, session } = require("telegraf");
const https = require("https");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.ALLOWED_USER_ID);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE = process.env.GITHUB_FILE || "index.html";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN");
if (!ALLOWED_USER_ID) throw new Error("Missing ALLOWED_USER_ID");
if (!GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN");
if (!GITHUB_REPO) throw new Error("Missing GITHUB_REPO");

function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "User-Agent": "sol-bot",
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        ...(data && { "Content-Length": Buffer.byteLength(data) }),
      },
    };

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
  });
}

async function getFile() {
  const result = await githubRequest(
    "GET",
    `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}?ref=${GITHUB_BRANCH}`
  );
  if (result.message) throw new Error(`GitHub: ${result.message}`);
  const content = Buffer.from(result.content, "base64").toString("utf8");
  return { content, sha: result.sha };
}

function extractSol(content) {
  const match = content.match(/<span id="solAmount">([^<]+)<\/span>/);
  return match ? match[1] : "unknown";
}

function replaceSol(content, newValue) {
  return content.replace(
    /(<span id="solAmount">)[^<]+(<\/span>)/,
    `$1${newValue}$2`
  );
}

async function updateFile(newValue) {
  const { content, sha } = await getFile();
  const updated = replaceSol(content, newValue);
  const encoded = Buffer.from(updated).toString("base64");

  const result = await githubRequest(
    "PUT",
    `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`,
    {
      message: `Update SOL requirement to ${newValue}`,
      content: encoded,
      sha,
      branch: GITHUB_BRANCH,
    }
  );

  if (result.message && result.message !== "ok") {
    throw new Error(`GitHub: ${result.message}`);
  }
}

// Telegram bot
const solScene = new Scenes.BaseScene("SOL_SCENE");

solScene.enter(async (ctx) => {
  try {
    const { content } = await getFile();
    const current = extractSol(content);
    await ctx.reply(
      `Current SOL requirement: *${current} SOL*\n\nReply with the new value (e.g. \`3\`, \`8\`, \`1.5\`):`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(`❌ Failed to fetch file: ${err.message}`);
    await ctx.scene.leave();
  }
});

solScene.on("text", async (ctx) => {
  const input = ctx.message.text.trim();

  if (!/^\d+(\.\d+)?$/.test(input)) {
    return ctx.reply("Invalid. Send a number like `2`, `3.5`, etc.", {
      parse_mode: "Markdown",
    });
  }

  try {
    await ctx.reply("⏳ Updating...");
    await updateFile(input);
    await ctx.reply(`✅ SOL requirement updated to *${input} SOL* on GitHub!`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    await ctx.reply(`❌ Error: ${err.message}`);
  }

  await ctx.scene.leave();
});

solScene.command("cancel", async (ctx) => {
  await ctx.reply("Cancelled.");
  await ctx.scene.leave();
});

const stage = new Scenes.Stage([solScene]);
const bot = new Telegraf(BOT_TOKEN);

bot.use(session());
bot.use(stage.middleware());

bot.use((ctx, next) => {
  if (ctx.from?.id !== ALLOWED_USER_ID) return ctx.reply("Unauthorized.");
  return next();
});

bot.command("sol", (ctx) => ctx.scene.enter("SOL_SCENE"));
bot.command("start", (ctx) =>
  ctx.reply("👋 Send /sol to update the SOL requirement in your HTML file.")
);

bot.launch();
console.log("Bot is running...");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));