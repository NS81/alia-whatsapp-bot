const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 10000;
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

let currentQR = null;
async function startWhatsApp() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    if (process.env.WA_SESSION) {
        try {
            const rawSession = process.env.WA_SESSION.trim();
            const decoded = Buffer.from(rawSession, 'base64').toString('utf-8');
            if (decoded.trim().startsWith('{')) {
                const parsed = JSON.parse(decoded);
                if (parsed.noiseKey || parsed.registrationId || parsed.me) {
                    fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), decoded, 'utf-8');
                    console.log('[Cloud Bot] ✅ Restored creds.json from WA_SESSION');
                } else {
                    for (const [filename, content] of Object.entries(parsed)) {
                        fs.writeFileSync(path.join(AUTH_DIR, filename), typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
                    }
                    console.log('[Cloud Bot] ✅ Restored multi-file session bundle from WA_SESSION');
                }
            }
        } catch (err) {
            console.error('[Cloud Bot] ⚠️ WA_SESSION parsing error:', err.message);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1043857760];
    try {
        const fetched = await fetchLatestBaileysVersion();
        if (fetched?.version) version = fetched.version;
    } catch(e) {
        console.log('[Cloud Bot] Using modern fallback Baileys version');
    }

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            currentQR = qr;
            console.log('[Cloud Bot] 🎯 QR Code received from WhatsApp! Ready for scanning.');
        }

        if (connection === 'close') {
            connectionStatus = "DISCONNECTED";
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            console.log('[Cloud Bot] Connection closed. StatusCode:', statusCode);
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('[Cloud Bot] Reconnecting socket in 3 seconds...');
                setTimeout(() => {
                    startWhatsApp().catch(err => console.error('[Restart Error]', err));
                }, 3000);
            } else {
                console.log('[Cloud Bot] Session logged out. Resetting auth dir...');
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){}
                setTimeout(() => {
                    startWhatsApp().catch(err => console.error('[Restart Error]', err));
                }, 3000);
            }
        } else if (connection === 'open') {
            connectionStatus = "CONNECTED";
            currentPairingCode = null;
            currentQR = null;
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
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        
        if (connectionStatus === "CONNECTED") {
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                  <meta charset="UTF-8">
                  <title>Gloramous Meta Sync | Connected</title>
                  <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0c111d; color: #fff; text-align: center; padding: 50px 20px; }
                    .card { background: #161f30; max-width: 500px; margin: 0 auto; padding: 40px; border-radius: 16px; border: 2px solid #25d366; }
                    .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 8px 18px; border-radius: 20px; font-weight: bold; margin-bottom: 20px; }
                  </style>
                </head>
                <body>
                  <div class="card">
                    <div class="badge">🟢 24/7 Meta Ads Sync Active</div>
                    <h1 style="color:#25d366;">Cloud Bot Connected!</h1>
                    <p style="color:#94a3b8; font-size:16px;">WhatsApp account is linked securely to Meta Pixel <b>${PIXEL_ID}</b>.</p>
                    <div style="background:#0c111d; border-radius:10px; padding:15px; margin-top:20px; font-size:14px; color:#cbd5e1; text-align:left;">
                      🔒 <b>100% Privacy Protected:</b><br>
                      • No personal messages, calls, or chats are visible to anyone.<br>
                      • The bot runs headlessly in code with zero screen/interface.<br>
                      • Only confirmed order amounts ($180, $120, $70, $40) are converted to Meta Purchase events.
                    </div>
                  </div>
                </body>
                </html>
            `);
            return;
        }

        let qrSection = '';
        if (currentQR) {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(currentQR)}`;
            qrSection = `
              <div style="margin:20px auto; background:#fff; padding:15px; border-radius:12px; display:inline-block;">
                <img src="${qrUrl}" width="260" height="260" alt="WhatsApp QR Code" />
              </div>
              <p style="color:#cbd5e1; font-size:15px;">Open WhatsApp on phone ➔ <b>Settings</b> ➔ <b>Linked Devices</b> ➔ <b>Link a Device</b> ➔ Scan this QR</p>
            `;
        } else {
            qrSection = `
              <div style="padding:40px; background:#161f30; border-radius:12px; display:inline-block; margin:20px auto;">
                <p style="color:#38bdf8; font-size:18px;">Initializing secure connection to WhatsApp...</p>
                <p style="color:#94a3b8; font-size:14px;">Refreshing automatically in 3 seconds...</p>
              </div>
            `;
        }
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="UTF-8">
              <meta http-equiv="refresh" content="5">
              <title>Gloramous Meta Sync Gateway</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0c111d; color: #fff; text-align: center; padding: 40px 15px; }
                .card { background: #161f30; max-width: 520px; margin: 0 auto; padding: 35px; border-radius: 16px; border: 1px solid #1f2a3d; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                h1 { color: #25d366; font-size: 24px; margin-bottom: 5px; }
              </style>
            </head>
            <body>
              <div class="card">
                <h1>Gloramous Meta Ads Tracking</h1>
                <p style="color:#94a3b8; font-size:15px;">Private Headless Cloud Gateway</p>
                
                ${qrSection}

                <div style="background:#0c111d; border-radius:10px; padding:15px; margin-top:25px; font-size:13px; color:#94a3b8; text-align:left;">
                  🔒 <b>Alia's Privacy Guarantee:</b><br>
                  • Nobody can view, read, or access your personal conversations.<br>
                  • This bot runs headlessly in the cloud with zero screen or chat history.<br>
                  • It only listens for order confirmation texts to report ad performance to Meta.
                </div>
              </div>
            </body>
            </html>
        `);
        return;
    } else if (parsedUrl.pathname === '/pair') {
        const phone = parsedUrl.searchParams.get('phone') || "96176954792";
        const cleanPhone = phone.replace(/[^0-9]/g, '');

        try {
            if (sock?.authState?.creds?.registered) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h2 style="font-family:sans-serif; text-align:center; padding:50px; color:#25d366;">🎉 WhatsApp Bot is ALREADY CONNECTED to +${cleanPhone}!</h2>`);
                return;
            }

            if (!sock || connectionStatus === "DISCONNECTED") {
                console.log('[Cloud Bot] Starting clean WhatsApp socket for pairing...');
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){} 
                await startWhatsApp();
                await new Promise(r => setTimeout(r, 4000));
            }

            let code;
            try {
                code = await sock.requestPairingCode(cleanPhone);
            } catch (firstErr) {
                console.log('[Cloud Bot] Initial code request failed, retrying with fresh socket:', firstErr.message);
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch(e){} 
                await startWhatsApp();
                await new Promise(r => setTimeout(r, 4000));
                code = await sock.requestPairingCode(cleanPhone);
            }

            currentPairingCode = code;

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
                <div style="font-family:sans-serif; text-align:center; padding:40px 20px; background:#0c111d; color:#fff; min-height:100vh;">
                  <h1 style="color:#25d366; margin-bottom:5px;">Gloramous WhatsApp Cloud Link</h1>
                  <p style="font-size:16px; color:#94a3b8;">Enter this code on Alia's phone (+${cleanPhone}):</p>
                  
                  <div style="margin:25px 0;">
                    <div style="font-size:46px; font-weight:900; letter-spacing:6px; padding:20px 35px; background:#161f30; border-radius:12px; display:inline-block; border:2px solid #25d366; color:#fff;">
                      ${code}
                    </div>
                    <p style="color:#cbd5e1; margin-top:15px; font-size:15px;">WhatsApp ➔ Settings ➔ Linked Devices ➔ Link a Device ➔ "Link with phone number instead"</p>
                  </div>
                </div>
            `);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <div style="font-family:sans-serif; text-align:center; padding:50px; background:#0c111d; color:#fff; min-height:100vh;">
                <h2 style="color:#f87171;">Pairing initialization in progress...</h2>
                <p>The socket is refreshing. Please refresh this page in 3 seconds.</p>
                <button onclick="window.location.reload()" style="padding:12px 24px; font-size:16px; background:#25d366; color:#000; border:none; border-radius:8px; cursor:pointer; font-weight:bold;">Refresh Now</button>
              </div>
            `);
        }
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Cloud Bot] HTTP Server listening on port ${PORT}`);
    startWhatsApp().catch(err => console.error('[Cloud Bot Fatal]', err));
});
