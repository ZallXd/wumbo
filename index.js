// ... semua require tetap sama
const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
  downloadMediaMessage
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const pino = require("pino");
const express = require("express");

const logger = pino({ level: "silent" });
const authFolder = "./auth_info";
if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder);

// === Fungsi Simpan/Muat State ===
function loadJSON(path, defaultValue) {
  try {
    return JSON.parse(fs.readFileSync(path));
  } catch {
    return defaultValue;
  }
}
function saveJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

// === Konfigurasi Bot ===
const channelJid = "120363417721042596@newsletter";
const initialGroupJids = ["120363399159334380@g.us","120363419497011726@g.us"];
const ownerNumbers = ["6288989337059@s.whatsapp.net","6285731706147@s.whatsapp.net"];

let lastStockMessage = null;
const antiLinkState = loadJSON("antilink.json", {}); // <-- load dari file
const whitelist = loadJSON("whitelist.json", {});     // <-- load dari file
const longTextCooldown = loadJSON("cooldown.json", {}); // <-- load dari file

// === Regex Deteksi Link Grup WhatsApp ===
const linkPatterns = [
  /chat\.whatsapp\.com\/(?:invite\/)?[0-9A-Za-z]{20,24}/i,
  /whatsapp\.com\/(?:invite|chat)\/[0-9A-Za-z]{20,24}/i,
  /wa\.me\/[0-9A-Za-z]{20,24}/i,
  /https?:\/\/(?:www\.)?whatsapp\.com\/groups?\/[0-9A-Za-z]{20,24}/i
];

// === Deteksi link di berbagai jenis pesan ===
function containsGroupLink(msg) {
  const textParts = [];
  if (msg?.conversation) textParts.push(msg.conversation);
  if (msg?.extendedTextMessage?.text) textParts.push(msg.extendedTextMessage.text);
  if (msg?.imageMessage?.caption) textParts.push(msg.imageMessage.caption);
  if (msg?.videoMessage?.caption) textParts.push(msg.videoMessage.caption);
  if (msg?.pollCreationMessage?.name) textParts.push(msg.pollCreationMessage.name);
  if (msg?.pollCreationMessage?.options?.length) {
    for (const option of msg.pollCreationMessage.options) {
      if (option.optionName) textParts.push(option.optionName);
    }
  }
  return textParts.some(text => linkPatterns.some(pattern => pattern.test(text)));
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    browser: Browsers.macOS("Desktop")
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === "open") console.log("✅ Bot berhasil terhubung ke WhatsApp!");
    if (connection === "close") setTimeout(startBot, 5000);
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        const { key, message } = msg;
        const { remoteJid, fromMe, participant } = key;
        const isGroup = remoteJid?.endsWith("@g.us");
        const sender = participant || key.participant || key.remoteJid;
        const normalizedId = sender?.replace(/:.*@/, '@');

        if (fromMe || !message) continue;

        const text = (
          message?.conversation ||
          message?.extendedTextMessage?.text ||
          message?.imageMessage?.caption ||
          message?.videoMessage?.caption ||
          ""
        ).toLowerCase();

        // === .antilink2 (global) ===
        if (!isGroup && text.startsWith(".antilink2")) {
          if (!ownerNumbers.includes(normalizedId)) {
            await sock.sendMessage(remoteJid, { text: "❌ Hanya pemilik bot yang bisa menjalankan perintah ini." });
            continue;
          }

          const param = text.split(" ")[1];
          if (param === "on") {
            for (const groupJid of Object.keys(antiLinkState)) {
              antiLinkState[groupJid] = true;
            }
            saveJSON("antilink.json", antiLinkState); // save
            await sock.sendMessage(remoteJid, { text: "✅ Anti-link di SEMUA grup telah diaktifkan." });
          } else if (param === "off") {
            for (const groupJid of Object.keys(antiLinkState)) {
              antiLinkState[groupJid] = false;
            }
            saveJSON("antilink.json", antiLinkState); // save
            await sock.sendMessage(remoteJid, { text: "🚫 Anti-link di SEMUA grup telah dimatikan." });
          } else {
            await sock.sendMessage(remoteJid, {
              text: `📌 Penggunaan: .antilink2 on/off`
            });
          }
          continue;
        }

        // === Anti-Spam Pesan Panjang ===
        const now = Date.now();
        const cooldown = longTextCooldown[normalizedId] || 0;
        const isLongText = text.length >= 700 || (message?.imageMessage?.caption || "").length >= 700;
        if (!ownerNumbers.includes(normalizedId) && isLongText) {
          if (cooldown && now - cooldown < 15 * 60 * 1000) {
            await sock.sendMessage(remoteJid, {
              delete: { remoteJid, fromMe: false, id: key.id, participant: sender }
            });
            await sock.sendMessage(remoteJid, {
              text: "❌ Teks kamu terlalu panjang. Tunggu 15 menit untuk mengirim teks panjang lagi."
            });
            continue;
          } else {
            longTextCooldown[normalizedId] = now;
            saveJSON("cooldown.json", longTextCooldown); // save
          }
        }

        // === Anti-Link Detection ===
        if (isGroup && antiLinkState[remoteJid] && containsGroupLink(message)) {
          const metadata = await sock.groupMetadata(remoteJid);
          const isAdmin = metadata.participants.some(p =>
            p.id === normalizedId && (p.admin === "admin" || p.admin === "superadmin")
          );
          const isBotAdmin = metadata.participants.some(p =>
            p.id === sock.user.id.split(":")[0] + "@s.whatsapp.net" && (p.admin === "admin" || p.admin === "superadmin")
          );
          const whiteListGroup = whitelist[remoteJid] || [];

          if (!isBotAdmin) return;
          if (!isAdmin && !ownerNumbers.includes(normalizedId) && !whiteListGroup.includes(normalizedId)) {
            await sock.sendMessage(remoteJid, {
              delete: { remoteJid, fromMe: false, id: key.id, participant: sender }
            });
            console.log(`🧹 Link grup dihapus dari non-admin (${sender})`);
          }
        }

        // === Command .antilink ===
        if (text.startsWith(".antilink")) {
          if (!isGroup) {
            await sock.sendMessage(remoteJid, { text: "❌ Command ini hanya berlaku di grup!" });
            continue;
          }
          const metadata = await sock.groupMetadata(remoteJid);
          const isAdmin = metadata.participants.some(p =>
            p.id === normalizedId && (p.admin === "admin" || p.admin === "superadmin")
          );
          if (!isAdmin) {
            await sock.sendMessage(remoteJid, { text: "❌ Hanya admin yang bisa mengatur anti-link!" });
            continue;
          }

          const param = text.split(" ")[1];
          if (param === "on") {
            antiLinkState[remoteJid] = true;
            saveJSON("antilink.json", antiLinkState); // save
            await sock.sendMessage(remoteJid, { text: "✅ Anti-link telah diaktifkan." });
          } else if (param === "off") {
            antiLinkState[remoteJid] = false;
            saveJSON("antilink.json", antiLinkState); // save
            await sock.sendMessage(remoteJid, { text: "🚫 Anti-link dimatikan." });
          } else {
            await sock.sendMessage(remoteJid, {
              text: `📌 Penggunaan: .antilink on/off\nStatus: ${antiLinkState[remoteJid] ? "AKTIF" : "NON-AKTIF"}`
            });
          }
          continue;
        }

        // === Command .whitelist ===
        if (text.startsWith(".whitelist")) {
          if (!isGroup) continue;
          const metadata = await sock.groupMetadata(remoteJid);
          const isAdmin = metadata.participants.some(p =>
            p.id === normalizedId && (p.admin === "admin" || p.admin === "superadmin")
          );
          if (!isAdmin) {
            await sock.sendMessage(remoteJid, { text: "❌ Hanya admin yang bisa mengatur whitelist!" });
            continue;
          }

          const cmd = text.split(" ");
          const target = cmd[1]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
          if (!target.includes("@s.whatsapp.net")) {
            await sock.sendMessage(remoteJid, { text: "❌ Format salah. Gunakan `.whitelist 628xxxx`" });
            continue;
          }

          whitelist[remoteJid] = whitelist[remoteJid] || [];
          const wl = whitelist[remoteJid];
          if (wl.includes(target)) {
            whitelist[remoteJid] = wl.filter(x => x !== target);
            await sock.sendMessage(remoteJid, { text: `🚫 ${target} dihapus dari whitelist.` });
          } else {
            wl.push(target);
            await sock.sendMessage(remoteJid, { text: `✅ ${target} ditambahkan ke whitelist.` });
          }
          saveJSON("whitelist.json", whitelist); // save
          continue;
        }

        // === Forward Pesan dari Saluran ===
        if (remoteJid === channelJid) {
          if (!(text.includes("stock") || text.includes("weather"))) return;
          if (text.includes("stock")) lastStockMessage = msg;

          for (const groupJid of initialGroupJids) {
            try {
              if (message?.conversation) {
                await sock.sendMessage(groupJid, { text: message.conversation });
              } else if (message?.extendedTextMessage?.text) {
                await sock.sendMessage(groupJid, { text: message.extendedTextMessage.text });
              } else if (message?.imageMessage) {
                const stream = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
                await sock.sendMessage(groupJid, {
                  image: stream,
                  caption: message.imageMessage.caption || ""
                });
              } else if (message?.videoMessage) {
                const stream = await downloadMediaMessage(msg, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
                await sock.sendMessage(groupJid, {
                  video: stream,
                  caption: message.videoMessage.caption || ""
                });
              } else {
                await sock.sendMessage(groupJid, { text: "📢 [Pesan dari saluran tidak dikenali]" });
              }
              await delay(1000);
            } catch (err) {
              console.error("❌ Gagal kirim pesan saluran ke grup:", err);
            }
          }
        }

        // === Command .stock ===
        if (text === ".stock") {
          if (!isGroup) continue;
          const metadata = await sock.groupMetadata(remoteJid);
          const isAdmin = metadata.participants.some(p =>
            p.id === normalizedId && (p.admin === "admin" || p.admin === "superadmin")
          );
          if (!isAdmin) {
            await sock.sendMessage(remoteJid, { text: "❌ Hanya admin yang bisa menggunakan perintah ini!" });
            continue;
          }

          if (!lastStockMessage) {
            await sock.sendMessage(remoteJid, { text: "⚠️ Belum ada pesan 'stock' dari saluran." });
            return;
          }

          const stockMsg = lastStockMessage.message;
          if (stockMsg?.conversation) {
            await sock.sendMessage(remoteJid, { text: stockMsg.conversation });
          } else if (stockMsg?.extendedTextMessage?.text) {
            await sock.sendMessage(remoteJid, { text: stockMsg.extendedTextMessage.text });
          } else if (stockMsg?.imageMessage) {
            const stream = await downloadMediaMessage(lastStockMessage, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
            await sock.sendMessage(remoteJid, {
              image: stream,
              caption: stockMsg.imageMessage.caption || ""
            });
          } else if (stockMsg?.videoMessage) {
            const stream = await downloadMediaMessage(lastStockMessage, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
            await sock.sendMessage(remoteJid, {
              video: stream,
              caption: stockMsg.videoMessage.caption || ""
            });
          } else {
            await sock.sendMessage(remoteJid, { text: "📦 [Pesan stock tidak dikenali]" });
          }
        }

      } catch (err) {
        console.error("❌ Error handling message:", err);
      }
    }
  });
}

startBot();

// === Web Server untuk Replit/UptimeRobot ===
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("Bot is running ✅"));
app.listen(port, () => console.log(`🌐 Web server aktif di port ${port}`));
