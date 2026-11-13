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
const META_TOKEN = (process.env.META_ACCESS_TOKEN || "").trim();
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const RENDER_API_KEY = (process.env.RENDER_API_KEY || "").trim();
const RENDER_SERVICE_ID = (process.env.RENDER_SERVICE_ID || "").trim();
const ADMIN_KEY = (process.env.BOT_ADMIN_KEY || (META_TOKEN ? META_TOKEN.slice(-12) : "gloramous_admin")).trim();

// In-memory stores (backed by Upstash Redis when configured)
const recentSyncs = new Map();      // cleanPhone -> timestamp (6h dedup)
const clickSessions = new Map();    // refCode -> { ref, fbp, fbc, url, product, price, ua, ts }
const chatAttribution = new Map();  // jid or cleanPhone -> click session object
const lidToPhoneCache = new Map();  // lid jid -> cleanPhone
const orderLogs = [];               // recent 100 CAPI attempts
const skippedLogs = [];             // recent 50 skipped triggers for diagnostics

const CLICK_TTL_MS = 7 * 24 * 3600 * 1000;
const DEDUP_WINDOW_MS = 6 * 3600 * 1000;

function pushRing(arr, item, max = 100) {
    arr.unshift(item);
    if (arr.length > max) arr.length = max;
}

// --- Upstash Redis REST helpers (optional zero-dependency persistence) ---
async function redisCommand(args) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
    try {
        const res = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(args)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.result ?? null;
    } catch (e) {
        console.error('[Redis] Error:', e.message);
        return null;
    }
}

// --- Render Env Var backup helper (optional persistent fallback) ---
async function syncSessionToRenderEnv(b64Bundle) {
    if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return false;
    try {
        const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars/WA_SESSION`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${RENDER_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ value: b64Bundle })
        });
        if (res.ok) {
            console.log('[Cloud Bot] ✅ Synced WA_SESSION to Render env var');
            return true;
        }
        console.warn('[Cloud Bot] Render env sync status:', res.status);
    } catch (e) {
        console.error('[Cloud Bot] Render env sync error:', e.message);
    }
    return false;
}

function buildAuthBundleB64() {
    if (!fs.existsSync(AUTH_DIR)) return null;
    const files = fs.readdirSync(AUTH_DIR);
    if (!files.includes('creds.json')) return null;
    const bundle = {};
    for (const file of files) {
        const fp = path.join(AUTH_DIR, file);
        if (fs.statSync(fp).isFile()) {
            bundle[file] = fs.readFileSync(fp, 'utf-8');
        }
    }
    return Buffer.from(JSON.stringify(bundle)).toString('base64');
}

function restoreAuthBundleB64(b64, label) {
    try {
        const decoded = Buffer.from(String(b64).trim(), 'base64').toString('utf-8');
        if (!decoded.trim().startsWith('{')) return false;
        const parsed = JSON.parse(decoded);
        if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
        if (parsed.noiseKey || parsed.registrationId || parsed.me) {
            fs.writeFileSync(path.join(AUTH_DIR, 'creds.json'), decoded, 'utf-8');
            console.log(`[Cloud Bot] ✅ Restored creds.json from ${label}`);
            return true;
        }
        let count = 0;
        for (const [filename, content] of Object.entries(parsed)) {
            const safeName = path.basename(filename);
            fs.writeFileSync(path.join(AUTH_DIR, safeName), typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
            count++;
        }
        console.log(`[Cloud Bot] ✅ Restored ${count} session files from ${label}`);
        return count > 0;
    } catch (err) {
        console.error(`[Cloud Bot] ⚠️ ${label} restore error:`, err.message);
        return false;
    }
}

let persistTimer = null;
function scheduleSessionPersist() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
        try {
            const b64 = buildAuthBundleB64();
            if (!b64) return;
            if (UPSTASH_URL && UPSTASH_TOKEN) {
                await redisCommand(['SET', 'gloramous:wa_session_b64', b64]);
            }
            if (RENDER_API_KEY && RENDER_SERVICE_ID) {
                await syncSessionToRenderEnv(b64);
            }
        } catch (e) {
            console.error('[Cloud Bot] Persist error:', e.message);
        }
    }, 5000);
}

// --- Phone & Hashing Helpers ---
function normalizePhone(raw, defaultCountry = "961") {
    let digits = String(raw || '').replace(/[^\d]/g, '');
    if (!digits) return '';
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

// --- Price & Trigger Extraction ---
function extractOrderDetails(text) {
    // 1. Explicit currency match first (so "70ml" never overrides "$120")
    const currencyMatch = text.match(/(?:\$|USD|دولار)\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:\$|USD|دولار)/i);
    if (currencyMatch) {
        const amount = parseFloat(currencyMatch[1] || currencyMatch[2]);
        if (amount > 0 && amount < 10000) {
            return { amount, packageTitle: `Confirmed Order ($${amount})` };
        }
    }

    // 2. Known Gloramous tiers/sets
    if (/180|full\s*routine|روتين\s*كامل/i.test(text)) return { amount: 180, packageTitle: "Full Routine ($180)" };
    if (/145|filler\s*set|مجموعة\s*الفيلر/i.test(text)) return { amount: 145, packageTitle: "Filler Set ($145)" };
    if (/120|twin|توأم|2\s*set|سيت/i.test(text)) return { amount: 120, packageTitle: "Twin Set ($120)" };
    if (/110|snail\s*set|مجموعة\s*الحلزون/i.test(text)) return { amount: 110, packageTitle: "Snail Set ($110)" };
    if (/70|منتجين|قطعتين|2\s*product/i.test(text)) return { amount: 70, packageTitle: "2 Products ($70)" };
    if (/50|lip\s*care|الشفاه/i.test(text)) return { amount: 50, packageTitle: "Lip Care Set ($50)" };
    if (/40|منتج\s*واحد|قطعة\s*وحدة|1\s*product/i.test(text)) return { amount: 40, packageTitle: "1 Product ($40)" };

    return { amount: 120, packageTitle: "Twin Set ($120)" };
}

function isOrderTrigger(text, fromMe) {
    if (!text) return false;
    // Ignore bot's own self-chat receipt
    if (text.includes('تم تسجيل طلب جديد في إعلانات Meta')) return false;

    const coreTrigger =
        /order\s*confirm(?:ed)?/i.test(text) ||
        /تم\s*(?:تأكيد|تاكيد|تثبيت|اعتماد|تسجيل)\s*الطلب/i.test(text) ||
        /تم\s*(?:التأكيد|التاكيد|التثبيت)/i.test(text) ||
        /طلبك\s*(?:مؤكد|تأكد|تثبت)/i.test(text);

    if (coreTrigger) return true;

    // Outgoing confirmation shorthand with an explicit $ price (e.g., "تم $120" or "✅ $70")
    if (fromMe && /\$\s*\d+|\d+\s*\$/.test(text) && /(?:تم|confirmed|مؤكد|طلب)/i.test(text)) {
        return true;
    }
    return false;
}

function extractRefCode(text) {
    const m = String(text || '').match(/\[?\s*Ref:\s*#?([A-Z0-9]{4,10})\s*\]?/i) ||
              String(text || '').match(/#(G[A-Z0-9]{4,8})\b/i);
    return m ? m[1].toUpperCase() : null;
}

async function lookupClickSession(ref) {
    if (!ref) return null;
    const key = ref.toUpperCase();
    let session = clickSessions.get(key);
    if (!session && UPSTASH_URL && UPSTASH_TOKEN) {
        const raw = await redisCommand(['GET', `gloramous:click:${key}`]);
        if (raw) {
            try {
                session = JSON.parse(raw);
                clickSessions.set(key, session);
            } catch (_) {}
        }
    }
    if (session && (Date.now() - session.ts < CLICK_TTL_MS)) {
        return session;
    }
    return null;
}

async function saveClickSession(session) {
    const key = session.ref.toUpperCase();
    clickSessions.set(key, session);
    if (clickSessions.size > 5000) {
        const oldestKey = clickSessions.keys().next().value;
        clickSessions.delete(oldestKey);
    }
    if (UPSTASH_URL && UPSTASH_TOKEN) {
        await redisCommand(['SET', `gloramous:click:${key}`, JSON.stringify(session), 'EX', String(7 * 86400)]);
    }
}

// --- Meta CAPI Sender ---
function sendMetaEvent(payloadObj) {
    return new Promise((resolve, reject) => {
        if (!META_TOKEN) {
            return reject(new Error('META_ACCESS_TOKEN is not configured'));
        }
        const payload = JSON.stringify({ ...payloadObj, access_token: META_TOKEN });
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
                        resolve(parsed);
                    } else {
                        reject(new Error(parsed.error?.message || body));
                    }
                } catch (e) {
                    reject(new Error(body));
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function sendMetaPurchase({ phone, amount, packageTitle, pushName, attribution }) {
    const cleanPhone = normalizePhone(phone);
    const hashedPhone = hashSha256(cleanPhone);
    const eventTime = Math.floor(Date.now() / 1000);
    const orderId = `wa_${eventTime}_${cleanPhone.slice(-4)}`;

    const userData = {
        ph: [hashedPhone],
        external_id: [hashedPhone]
    };
    if (cleanPhone.startsWith('961')) {
        userData.country = [hashSha256('lb')];
    }
    if (pushName && pushName.trim() && pushName.trim() !== '~') {
        const firstName = pushName.trim().split(/\s+/)[0];
        if (firstName) userData.fn = [hashSha256(firstName)];
    }

    const eventObj = {
        event_name: "Purchase",
        event_time: eventTime,
        event_id: orderId,
        user_data: userData,
        custom_data: {
            currency: "USD",
            value: Number(amount).toFixed(2),
            content_name: packageTitle,
            content_type: "product"
        }
    };

    if (attribution && (attribution.fbp || attribution.fbc || attribution.url)) {
        eventObj.action_source = "website";
        eventObj.event_source_url = attribution.url || "https://gloramous.net/";
        if (attribution.fbp) userData.fbp = attribution.fbp;
        if (attribution.fbc) userData.fbc = attribution.fbc;
        if (attribution.ua) userData.client_user_agent = attribution.ua;
    } else {
        eventObj.action_source = "business_messaging";
        eventObj.messaging_channel = "whatsapp";
    }

    const data = await sendMetaEvent({ data: [eventObj] });
    return {
        success: true,
        cleanPhone,
        orderId,
        source: eventObj.action_source,
        hasFbp: !!userData.fbp,
        hasFbc: !!userData.fbc,
        data
    };
}

let sock = null;
let currentPairingCode = null;
let connectionStatus = "INITIALIZING";
let currentQR = null;
let startedOnce = false;

async function resolvePhoneFromMessage(msg, text) {
    // 1. Phone explicitly written in message text
    const phoneInText = text.match(/(?:\+?961|03|70|71|76|78|79|81|01)[-\s/]?\d{2,3}[-\s/]?\d{3,4}/);
    if (phoneInText) return phoneInText[0];

    // 2. Baileys v7 remoteJidAlt (carries PN JID when remoteJid is @lid)
    const jidAlt = msg.key.remoteJidAlt;
    if (jidAlt && jidAlt.includes('@s.whatsapp.net')) {
        const num = jidAlt.split('@')[0].split(':')[0];
        if (/^\d{8,15}$/.test(num)) return '+' + num;
    }

    // 3. Direct PN JID
    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid.includes('@s.whatsapp.net')) {
        const num = remoteJid.split('@')[0].split(':')[0];
        if (/^\d{8,15}$/.test(num)) return '+' + num;
    }

    // 4. LID -> PN lookup via Baileys signalRepository or local cache
    if (remoteJid.endsWith('@lid')) {
        if (lidToPhoneCache.has(remoteJid)) {
            return '+' + lidToPhoneCache.get(remoteJid);
        }
        try {
            const pnJid = await sock?.signalRepository?.lidMapping?.getPNForLID(remoteJid);
            if (pnJid) {
                const num = pnJid.split('@')[0].split(':')[0];
                if (/^\d{8,15}$/.test(num)) {
                    lidToPhoneCache.set(remoteJid, num);
                    return '+' + num;
                }
            }
        } catch (_) {}
    }

    return null;
}

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    // Hydrate session if AUTH_DIR doesn't already have creds.json
    const hasLocalCreds = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
    if (!hasLocalCreds) {
        let restored = false;
        if (UPSTASH_URL && UPSTASH_TOKEN) {
            const redisB64 = await redisCommand(['GET', 'gloramous:wa_session_b64']);
            if (redisB64) restored = restoreAuthBundleB64(redisB64, 'Upstash Redis');
        }
        if (!restored && process.env.WA_SESSION) {
            restoreAuthBundleB64(process.env.WA_SESSION, 'WA_SESSION env');
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1043857760];
    try {
        const fetched = await fetchLatestBaileysVersion();
        if (fetched?.version) version = fetched.version;
    } catch (e) {
        console.log('[Cloud Bot] Using fallback Baileys version');
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

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        scheduleSessionPersist();
    });

    // Keep LID -> Phone cache warm from contact updates
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts || []) {
            if (c.id?.endsWith('@lid') && c.phoneNumber) {
                const num = normalizePhone(c.phoneNumber);
                if (num) lidToPhoneCache.set(c.id, num);
            }
        }
    });

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
                setTimeout(() => startWhatsApp().catch(err => console.error('[Restart Error]', err)), 3000);
            } else {
                console.log('[Cloud Bot] Session logged out. Resetting auth dir...');
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                setTimeout(() => startWhatsApp().catch(err => console.error('[Restart Error]', err)), 3000);
            }
        } else if (connection === 'open') {
            connectionStatus = "CONNECTED";
            currentPairingCode = null;
            currentQR = null;
            console.log('\n======================================================');
            console.log('  🎉 GLORAMOUS 24/7 CLOUD BOT CONNECTED TO WHATSAPP!');
            console.log(`  JID: ${sock.user?.id}`);
            console.log('======================================================\n');
            scheduleSessionPersist();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const fromMe = !!msg.key.fromMe;
            const remoteJid = msg.key.remoteJid || '';
            if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@g.us')) continue;

            const text = msg.message.conversation ||
                         msg.message.extendedTextMessage?.text ||
                         msg.message.imageMessage?.caption ||
                         msg.message.videoMessage?.caption || '';

            if (!text || text.trim().length === 0) continue;

            // Capture website [Ref: #GXXXX] from customer or pre-filled messages
            const refCode = extractRefCode(text);
            const resolvedPhone = await resolvePhoneFromMessage(msg, text);
            const cleanResolved = resolvedPhone ? normalizePhone(resolvedPhone) : '';

            if (refCode) {
                const sess = await lookupClickSession(refCode);
                if (sess) {
                    chatAttribution.set(remoteJid, sess);
                    if (msg.key.remoteJidAlt) chatAttribution.set(msg.key.remoteJidAlt, sess);
                    if (cleanResolved) chatAttribution.set(cleanResolved, sess);
                    console.log(`[Cloud Bot] 🔗 Linked chat ${remoteJid} to website ref #${refCode} (fbp=${!!sess.fbp}, fbc=${!!sess.fbc})`);
                }
            }

            if (!isOrderTrigger(text, fromMe)) continue;

            console.log(`[Cloud Bot] 🎯 Order Trigger: "${text.trim().slice(0, 80)}" in ${remoteJid}`);

            if (!resolvedPhone) {
                console.log(`[Cloud Bot] ⚠️ Could not determine phone for chat ${remoteJid}`);
                pushRing(skippedLogs, { ts: new Date().toISOString(), reason: 'no_phone', remoteJid, snippet: text.slice(0, 60) }, 50);
                continue;
            }

            const cleanKey = normalizePhone(resolvedPhone);
            const now = Date.now();
            if (recentSyncs.has(cleanKey) && (now - recentSyncs.get(cleanKey) < DEDUP_WINDOW_MS)) {
                console.log(`[Cloud Bot] ℹ️ Skipping duplicate for +${cleanKey}`);
                pushRing(skippedLogs, { ts: new Date().toISOString(), reason: 'duplicate_6h', phone: '+' + cleanKey }, 50);
                continue;
            }
            recentSyncs.set(cleanKey, now);

            const { amount, packageTitle } = extractOrderDetails(text);
            const attribution = chatAttribution.get(remoteJid) ||
                                (msg.key.remoteJidAlt ? chatAttribution.get(msg.key.remoteJidAlt) : null) ||
                                chatAttribution.get(cleanKey) ||
                                (refCode ? await lookupClickSession(refCode) : null);

            try {
                const metaRes = await sendMetaPurchase({
                    phone: resolvedPhone,
                    amount,
                    packageTitle,
                    pushName: fromMe ? '' : (msg.pushName || ''),
                    attribution
                });

                const entry = {
                    ts: new Date().toISOString(),
                    phone: '+' + metaRes.cleanPhone,
                    amount,
                    packageTitle,
                    source: metaRes.source,
                    hasFbp: metaRes.hasFbp,
                    hasFbc: metaRes.hasFbc,
                    eventsReceived: metaRes.data?.events_received,
                    fbtraceId: metaRes.data?.fbtrace_id
                };
                pushRing(orderLogs, entry);
                console.log(`[Cloud Bot] ✅ Meta CAPI Success:`, JSON.stringify(entry));

                const myRawJid = sock.user?.id?.split(':')[0];
                if (myRawJid) {
                    const sourceTag = metaRes.source === 'website' ? '🌐 Website (fbp/fbc)' : '💬 WhatsApp Ad/Direct';
                    const receiptText = `🎉 *تم تسجيل طلب جديد في إعلانات Meta بنجاح!*\n\n` +
                                        `📞 *الزبونة:* +${metaRes.cleanPhone}\n` +
                                        `💰 *المبلغ:* $${amount} (${packageTitle})\n` +
                                        `📍 *المصدر:* ${sourceTag}\n` +
                                        `🎯 *النتيجة:* تم تحديث أداء الحملة وزيادة الـ ROAS!`;
                    await sock.sendMessage(myRawJid + '@s.whatsapp.net', { text: receiptText });
                }
            } catch (err) {
                console.error('[Cloud Bot] ❌ Meta Sync Error:', err.message);
                pushRing(orderLogs, {
                    ts: new Date().toISOString(),
                    phone: '+' + cleanKey,
                    amount,
                    error: err.message
                });
            }
        }
    });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 65536) req.destroy();
        });
        req.on('end', () => {
            if (!body) return resolve({});
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            ok: true,
            connection: connectionStatus,
            jid: sock?.user?.id || null,
            uptime: Math.floor(process.uptime())
        }));
        return;
    }

    if (parsedUrl.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: "online",
            bot_connection: connectionStatus,
            jid: sock?.user?.id || null,
            pixel_id: PIXEL_ID,
            has_meta_token: !!META_TOKEN,
            persistence: {
                has_upstash: !!(UPSTASH_URL && UPSTASH_TOKEN),
                has_render_api: !!(RENDER_API_KEY && RENDER_SERVICE_ID),
                has_wa_session_env: !!process.env.WA_SESSION,
                has_local_creds: fs.existsSync(path.join(AUTH_DIR, 'creds.json'))
            },
            metrics: {
                active_click_refs: clickSessions.size,
                linked_chats: chatAttribution.size,
                tracked_orders_recent: orderLogs.length,
                skipped_recent: skippedLogs.length
            },
            recent_orders: orderLogs.slice(0, 20),
            recent_skipped: skippedLogs.slice(0, 10),
            uptime_seconds: Math.floor(process.uptime())
        }, null, 2));
        return;
    }

    if (parsedUrl.pathname === '/session-b64') {
        const key = parsedUrl.searchParams.get('key') || '';
        if (key !== ADMIN_KEY) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }
        const b64 = buildAuthBundleB64();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: !!b64, wa_session: b64 }));
        return;
    }

    if (parsedUrl.pathname === '/click') {
        try {
            let payload = {};
            if (req.method === 'POST') {
                payload = await readJsonBody(req);
            } else {
                payload = {
                    ref: parsedUrl.searchParams.get('ref'),
                    fbp: parsedUrl.searchParams.get('fbp'),
                    fbc: parsedUrl.searchParams.get('fbc'),
                    url: parsedUrl.searchParams.get('url'),
                    product: parsedUrl.searchParams.get('product'),
                    price: parsedUrl.searchParams.get('price')
                };
            }
            const ref = (payload.ref || ('G' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5))).toUpperCase();
            const session = {
                ref,
                fbp: payload.fbp || '',
                fbc: payload.fbc || '',
                url: payload.url || 'https://gloramous.net/',
                product: payload.product || '',
                price: payload.price || '',
                ua: payload.ua || req.headers['user-agent'] || '',
                ts: Date.now()
            };
            await saveClickSession(session);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ref }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
    }

    if (parsedUrl.pathname === '/go') {
        const phone = (parsedUrl.searchParams.get('to') || '96176954792').replace(/[^\d]/g, '');
        const product = parsedUrl.searchParams.get('product') || '';
        const ref = (parsedUrl.searchParams.get('ref') || ('G' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5))).toUpperCase();
        await saveClickSession({
            ref,
            fbp: parsedUrl.searchParams.get('fbp') || '',
            fbc: parsedUrl.searchParams.get('fbc') || '',
            url: parsedUrl.searchParams.get('url') || 'https://gloramous.net/',
            product,
            price: parsedUrl.searchParams.get('price') || '',
            ua: req.headers['user-agent'] || '',
            ts: Date.now()
        });
        const baseMsg = parsedUrl.searchParams.get('text') ||
            (product ? `مرحباً 👋 أود طلب ${product}` : 'مرحباً 👋');
        const fullMsg = `${baseMsg}\n[Ref: #${ref}]`;
        const target = `https://wa.me/${phone}?text=${encodeURIComponent(fullMsg)}`;
        res.writeHead(302, { Location: target });
        res.end();
        return;
    }

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
                    .card { background: #161f30; max-width: 520px; margin: 0 auto; padding: 40px; border-radius: 16px; border: 2px solid #25d366; }
                    .badge { display: inline-block; background: #064e3b; color: #34d399; padding: 8px 18px; border-radius: 20px; font-weight: bold; margin-bottom: 20px; }
                  </style>
                </head>
                <body>
                  <div class="card">
                    <div class="badge">🟢 24/7 Meta Ads Sync Active</div>
                    <h1 style="color:#25d366;">Cloud Bot Connected!</h1>
                    <p style="color:#94a3b8; font-size:16px;">WhatsApp account is linked securely to Meta Pixel <b>${PIXEL_ID}</b>.</p>
                    <p style="color:#cbd5e1; font-size:14px;">Tracked orders (session): <b>${orderLogs.length}</b> | Active Web Clicks: <b>${clickSessions.size}</b></p>
                    <div style="background:#0c111d; border-radius:10px; padding:15px; margin-top:20px; font-size:14px; color:#cbd5e1; text-align:left;">
                      🔒 <b>100% Privacy Protected:</b><br>
                      • No personal messages, calls, or chats are visible to anyone.<br>
                      • Website clicks + WhatsApp orders sync automatically to Meta CAPI.<br>
                      • View JSON diagnostics anytime at <a href="/status" style="color:#38bdf8;">/status</a>.
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
    }

    if (parsedUrl.pathname === '/pair') {
        const phone = parsedUrl.searchParams.get('phone') || "96176954792";
        const cleanPhone = phone.replace(/[^0-9]/g, '');

        try {
            if (sock?.authState?.creds?.registered) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<h2 style="font-family:sans-serif; text-align:center; padding:50px; color:#25d366;">🎉 WhatsApp Bot is ALREADY CONNECTED to +${cleanPhone}!</h2>`);
                return;
            }

            if (!sock || connectionStatus === "DISCONNECTED") {
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
                await startWhatsApp();
                await new Promise(r => setTimeout(r, 4000));
            }

            let code;
            try {
                code = await sock.requestPairingCode(cleanPhone);
            } catch (firstErr) {
                try { if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (e) {}
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
        return;
    }

    res.writeHead(404);
    res.end();
});

if (require.main === module) {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[Cloud Bot] HTTP Server listening on port ${PORT}`);
        if (!startedOnce) {
            startedOnce = true;
            startWhatsApp().catch(err => console.error('[Cloud Bot Fatal]', err));
        }
    });
}

module.exports = {
    normalizePhone,
    extractOrderDetails,
    isOrderTrigger,
    extractRefCode,
    sendMetaPurchase
};
