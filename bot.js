const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 3000;
const PIXEL_ID = process.env.META_PIXEL_ID || "1099322255975263";
const AUTH_DIR = path.join(__dirname, 'auth_info_cloud');
let META_TOKEN = process.env.META_ACCESS_TOKEN || "";

const recentSyncs = new Map();

function normalizePhone(raw, defaultCountry = "961") {
    let digits = String(raw).replace(/[^\d]/g, '');
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 8 && /^(03|70|71|76|78|79|81)/.test(digits)) {
        if (digits.startsWith("0")) digits = digits.slice(1);
        digits = defaultCountry + digits;
    } else if (digits.length === 7) {
        digits = defaultCountry + digits;
    } else if (digits.length === 10 && digits.startsWith("96103")) {
        digits = "9613" + digits.slice(5);
    } else if (!digits.startsWith(defaultCountry) && digits.length <= 8) {
        digits = defaultCountry + digits;
    }
    return digits;
}

function hashSha256(val) {
    return crypto.createHash('sha256').update(String(val).trim().toLowerCase()).digest('hex');
}

function sendMetaPurchase(phone, amount, packageTitle) {
    return new Promise((resolve, reject) => {
        const cleanPhone = normalizePhone(phone);
        const hashedPhone = hashSha256(cleanPhone);
        const eventTime = Math.floor(Date.now() / 1000);
        const orderId = `wa_${eventTime}_${cleanPhone.slice(-4)}`;

        const payload = JSON.stringify({
            data: [{
                event_name: "Purchase",
                event_time: eventTime,
                event_id: orderId,
                action_source: "system_generated",
                user_data: {
                    ph: [hashedPhone]
                },
                custom_data: {
                    currency: "USD",
                    value: Number(amount).toFixed(2),
                    content_name: packageTitle,
                    content_type: "product"
                }
            }],
            access_token: META_TOKEN
        });

        const req = https.request({
            hostname: 'graph.facebook.com',
            port: 443,
            path: `/v22.0/${PIXEL_ID}/events`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (res.statusCode === 200) {
                        resolve({ success: true, cleanPhone, data: parsed });
                    } else {
                        reject(new Error(parsed.error?.message || body));
                    }
                } catch(e) {
                    reject(new Error(body));
                }
            });
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

let sock = null;
let currentPairingCode = null;
let connectionStatus = "INITIALIZING";

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ['Gloramous Cloud AI', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            connectionStatus = "DISCONNECTED";
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('[Cloud Bot] Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startWhatsApp();
        } else if (connection === 'open') {
            connectionStatus = "CONNECTED";
            currentPairingCode = null;
            console.log('\n======================================================');
            console.log('  🎉 GLORAMOUS 24/7 CLOUD BOT CONNECTED TO WHATSAPP!');
            console.log(`  JID: ${sock.user?.id}`);
            console.log('======================================================\n');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const fromMe = msg.key.fromMe;
            const remoteJid = msg.key.remoteJid;

            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || '';

            if (!text || text.trim().length === 0) continue;

            const trigger1 = /order\s*confirm(?:ed)?/i.test(text);
            const trigger2 = /تم\s*(?:تأكيد|تاكيد)\s*الطلب/i.test(text);
            const trigger3 = /تم\s*(?:التأكيد|التاكيد)/i.test(text);

            if (trigger1 || trigger2 || trigger3) {
                console.log(`[Cloud Bot] 🎯 Order Trigger: "${text.trim()}" in ${remoteJid}`);

                let phone = null;
                const phoneInText = text.match(/(?:\+?961|03|70|71|76|78|79|81|01)[-\s/]?\d{2,3}[-\s/]?\d{3,4}/);
                if (phoneInText) {
                    phone = phoneInText[0];
                } else if (remoteJid && remoteJid.includes('@s.whatsapp.net')) {
                    const jidNum = remoteJid.split('@')[0];
                    if (/^\d{8,15}$/.test(jidNum)) phone = '+' + jidNum;
                }

                if (!phone) {
                    console.log(`[Cloud Bot] ⚠️ Could not determine phone for chat ${remoteJid}`);
                    continue;
                }

                const cleanKey = phone.replace(/[^0-9]/g, '');
                const now = Date.now();
                if (recentSyncs.has(cleanKey) && (now - recentSyncs.get(cleanKey) < 6 * 3600 * 1000)) {
                    console.log(`[Cloud Bot] ℹ️ Skipping duplicate for +${cleanKey}`);
                    continue;
                }
                recentSyncs.set(cleanKey, now);

                let amount = 120;
                let packageTitle = "Twin Set ($120)";

                if (/180|full|كامل|روتين/i.test(text)) {
                    amount = 180;
                    packageTitle = "Full Routine ($180)";
                } else if (/120|twin|توأم|2\s*set|سيت/i.test(text)) {
                    amount = 120;
                    packageTitle = "Twin Set ($120)";
                } else if (/70|منتجين|قطعتين|2\s*product/i.test(text)) {
                    amount = 70;
                    packageTitle = "2 Products ($70)";
                } else if (/40|منتج واحد|قطعة وحدة|1\s*product/i.test(text)) {
                    amount = 40;
                    packageTitle = "1 Product ($40)";
                } else {
                    const customMatch = text.match(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*\$/);
                    if (customMatch) {
                        amount = parseFloat(customMatch[1] || customMatch[2]);
                        packageTitle = `Custom Order ($${amount})`;
                    }
                }

                try {
                    console.log(`[Cloud Bot] 🚀 Sending Meta Purchase: Phone=${phone}, Amount=$${amount}...`);
                    const metaRes = await sendMetaPurchase(phone, amount, packageTitle);
                    console.log(`[Cloud Bot] ✅ Meta CAPI Success for +${cleanKey}!`);

                    const myRawJid = sock.user?.id?.split(':')[0];
                    if (myRawJid) {
                        const receiptText = `🎉 *تم تسجيل طلب جديد في إعلانات Meta بنجاح!*\n\n` +
                                            `📞 *الزبونة:* +${cleanKey}\n` +
                                            `💰 *المبلغ:* $${amount} (${packageTitle})\n` +
                                            `🎯 *النتيجة:* تم تحديث أداء الحملة وزيادة الـ ROAS!`;
                        await sock.sendMessage(myRawJid + '@s.whatsapp.net', { text: receiptText });
                    }
                } catch (err) {
                    console.error('[Cloud Bot] ❌ Meta Sync Error:', err.message);
                }
            }
        }
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (parsedUrl.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: "online",
            bot_connection: connectionStatus,
            pixel_id: PIXEL_ID,
            uptime_seconds: Math.floor(process.uptime()),
            has_pairing_code: !!currentPairingCode
        }));
    } else if (parsedUrl.pathname === '/pair') {
        const phone = parsedUrl.searchParams.get('phone');
        if (!phone) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<h2>Usage: /pair?phone=96176xxxxxx</h2>`);
            return;
        }

        try {
            const cleanPhone = phone.replace(/[^0-9]/g, '');
            if (!sock || (sock.authState && sock.authState.creds && sock.authState.creds.registered)) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h3>Bot is already registered and connected!</h3>`);
                return;
            }

            const code = await sock.requestPairingCode(cleanPhone);
            currentPairingCode = code;

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <div style="font-family:sans-serif; text-align:center; padding:40px; background:#0c111d; color:#fff; min-height:100vh;">
                  <h1 style="color:#25d366;">WhatsApp Pairing Code</h1>
                  <p style="font-size:18px;">Enter this code on Alia's phone:</p>
                  <div style="font-size:36px; font-weight:900; letter-spacing:4px; padding:20px; background:#161f30; border-radius:12px; display:inline-block; border:2px solid #25d366; margin:20px 0;">
                    ${code}
                  </div>
                  <p style="color:#94a3b8;">WhatsApp ➔ Linked Devices ➔ Link a Device ➔ Link with phone number ➔ Enter code.</p>
                </div>
            `);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error requesting code: ' + err.message);
        }
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`[Cloud Bot] HTTP Server listening on port ${PORT}`);
    startWhatsApp().catch(err => console.error('[Cloud Bot Fatal]', err));
});
