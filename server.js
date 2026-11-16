import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import mqtt from 'mqtt';
import layoutRouter from './layoutApi.js';

process.env.TZ = 'Asia/Ho_Chi_Minh';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { Pool } = pkg;

const logger = {
    info: (msg, data = '') => console.log(`[${new Date().toLocaleString()}] â„¹ï¸  INFO: ${msg}`, data),
    success: (msg, data = '') => console.log(`[${new Date().toLocaleString()}] âœ… SUCCESS: ${msg}`, data),
    warn: (msg, data = '') => console.warn(`[${new Date().toLocaleString()}] âš ï¸  WARN: ${msg}`, data),
    error: (msg, err = '') => console.error(`[${new Date().toLocaleString()}] âŒ ERROR: ${msg}`, err)
};

// --- Äá»ŒC Cáº¤U HÃŒNH ---
let config;
try {
    const configPath = path.join(__dirname, 'config.json');
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    logger.success('Loaded config.json');
} catch (err) {
    logger.error('Could not read config.json', err.message);
    process.exit(1);
}

// --- KHá»žI Táº O Káº¾T Ná»I DATABASE ---
const pool = new Pool({
    ...config.db,
    // Ã‰p session káº¿t ná»‘i database vá» mÃºi giá» Viá»‡t Nam
    options: "-c timezone=Asia/Ho_Chi_Minh"
});



const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/layout', layoutRouter(pool, logger));
// --- Cáº¤U HÃŒNH MQTT ---
// LÆ°u Ã½: Thay Ä‘á»•i URL náº¿u MQTT Broker á»Ÿ mÃ¡y khÃ¡c
const mqttClient = mqtt.connect('mqtt://localhost:1883');

mqttClient.on('connect', () => {
    logger.success('Backend connected to MQTT Broker');

    // ÄÄƒng kÃ½ cÃ¡c topic láº¯ng nghe yÃªu cáº§u tá»« Dashboard (Client)
    mqttClient.subscribe('wvn/security_qas/request/detail');
    mqttClient.subscribe('wvn/security_qas/request/subdetail');
    mqttClient.subscribe('wvn/security_qas/request/all_detail');
    mqttClient.subscribe('wvn/security_qas/request/gettime');

    // Gá»­i dá»¯ liá»‡u láº§n Ä‘áº§u ngay khi káº¿t ná»‘i
    syncDashboardData();
    syncContacts();
});

// --- 1. HÃ€M PUBLISH Dá»® LIá»†U Tá»”NG QUÃT (DASHBOARD) ---
// --- 1. HÀM PUBLISH DỮ LIỆU TỔNG QUÁT (DASHBOARD) ---
async function syncDashboardData() {
    const keys = ['face', 'nvr', 'hr_face', 'hr_door', 'accesscontrol', 'perm', 'camera'];
    let dashboardData = {};

    for (const key of keys) {
        const queries = config?.queries?.dashboard?.[key];
        if (!queries) continue;

        try {
            // abnormal, normal + các query phụ (offline, covered, exception...) nếu có trong config
            const fields = Object.keys(queries);
            const results = await Promise.all(fields.map(f => pool.query(queries[f])));

            dashboardData[key] = {};
            fields.forEach((f, i) => {
                dashboardData[key][f] = parseInt(results[i].rows[0]?.count || 0);
            });
        } catch (err) {
            logger.error(`Dashboard query failed for [${key}]`, err.message);
        }
    }

    // --- TẠO TIMESTAMP CẬP NHẬT (Định dạng: YYYY/MM/DD HH:mm:ss) ---
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    // Thêm trường updateTime vào gói tin tổng
    dashboardData.updateTime = `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;

    // Publish kèm flag 'retain' để client mới vào nhận được dữ liệu ngay
    mqttClient.publish('wvn/security_qas/dashboard', JSON.stringify(dashboardData), { retain: true });
}


// --- 2. HÃ€M PUBLISH DANH SÃCH LIÃŠN Há»† ---
async function syncContacts() {
    try {
        const r = await pool.query(config.queries.it_contact);
        mqttClient.publish('wvn/security_qas/contacts', JSON.stringify(r.rows), { retain: true });
    } catch (err) {
        logger.error('Contact query failed', err.message);
    }
}

// --- 3. HÃ€M Láº¤Y THá»œI GIAN Cáº¬P NHáº¬T ---
async function syncGettime() {
    try {
        // Láº¥y cÃ¢u truy váº¥n Ä‘á»™ng tá»« file config.json cá»§a báº¡n: config.queries.getTime["camera-time"]
        const sql = config.queries.getTime["camera-time"];
        if (sql) {
            const r = await pool.query(sql);
            // Láº¥y chuá»—i Ä‘á»‹nh dáº¡ng YYYY-MM-DD HH:mm:ss tráº£ vá» tá»« Database
            const lastUpdatedTime = r.rows[0]?.updatedate || 'N/A';

            // Gá»­i dá»¯ liá»‡u thá»i gian lÃªn kÃªnh 'wvn/security_qas/gettimes'
            mqttClient.publish('wvn/security_qas/gettimes', JSON.stringify({ updatedate: lastUpdatedTime }), { retain: true });
            logger.info(`Synced max updatedate: ${lastUpdatedTime}`);
        }
    } catch (err) {
        logger.error('Get time query failed', err.message);
    }
}

// Thiáº¿t láº­p quÃ©t Ä‘á»‹nh ká»³ má»—i 30 giÃ¢y Ä‘á»ƒ cáº­p nháº­t sá»‘ liá»‡u
setInterval(() => {
    syncDashboardData();
    syncContacts();
}, 30000);

// --- 4. Xá»¬ LÃ REQUEST-RESPONSE QUA MQTT (CHO MODAL CHI TIáº¾T) ---
mqttClient.on('message', async (topic, message) => {

    if (topic === 'wvn/security_qas/request/gettime') {
        logger.info('Received active gettime request from client');
        await syncGettime();
        return;
    }


    let payload;
    try {
        payload = JSON.parse(message.toString());
    } catch (e) {
        return;
    }

    const { type, id, requestId } = payload;
    if (!requestId) return; // Bá» qua náº¿u khÃ´ng cÃ³ requestId (mÃ£ Ä‘á»‹nh danh yÃªu cáº§u)

    const responseTopic = `wvn/security_qas/response/${requestId}`;
    let resultRows = [];

    try {
        let sql = '';
        let params = [];

        if (topic === 'wvn/security_qas/request/detail') {
            // Láº¥y chi tiáº¿t cáº¥p 1 (Danh sÃ¡ch thiáº¿t bá»‹ lá»—i)
            sql = config.queries.detail[type];
        }
        else if (topic === 'wvn/security_qas/request/subdetail') {
            // Láº¥y chi tiáº¿t cáº¥p 2 (Lá»—i cá»§a tá»«ng cÃ¡ nhÃ¢n/thiáº¿t bá»‹ cá»¥ thá»ƒ)
            sql = config.queries.sub_detail?.[type];
            params = [id];
        }
        else if (topic === 'wvn/security_qas/request/all_detail') {
            // Láº¥y toÃ n bá»™ lá»—i khÃ´ng phÃ¢n cáº¥p (NÃºt View All)
            sql = config.queries.allQueries?.[type];
        }
        else if (topic === 'wvn/security_qas/request/gettime') {
            // Láº¥y toÃ n bá»™ lá»—i khÃ´ng phÃ¢n cáº¥p (NÃºt View All)
            sql = config.queries.allQueries?.[type];
        }

        if (sql) {
            const res = await pool.query(sql, params);
            // Chuyá»ƒn Ä‘á»•i dá»¯ liá»‡u tá»« dáº¡ng Object sang Array Ä‘á»ƒ khá»›p vá»›i renderTable cá»§a Frontend
            resultRows = res.rows.map(o => Object.values(o));
        }

        // Gá»­i káº¿t quáº£ tráº£ vá» cho Ä‘Ãºng requestId cá»§a Client
        mqttClient.publish(responseTopic, JSON.stringify({
            requestId,
            rows: resultRows
        }));

        logger.info(`Replied to ${topic} for type [${type}] - Rows: ${resultRows.length}`);

    } catch (err) {
        logger.error(`Error handling ${topic}`, err.message);
        // Tráº£ vá» máº£ng rá»—ng náº¿u lá»—i Ä‘á»ƒ trÃ¡nh treo giao diá»‡n Client
        mqttClient.publish(responseTopic, JSON.stringify({ requestId, rows: [], error: err.message }));
    }
});


// --- KHá»žI CHáº Y HTTP SERVER ---
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    logger.success(`ðŸš€ SERVER RUNNING ON http://localhost:${PORT}`);
    logger.info(`MÃºi giá» há»‡ thá»‘ng: ${process.env.TZ}`);
    console.log('='.repeat(50) + '\n');
});