// layoutApi.js — API của Camera Layout cho dashboard (thay cho Flask /camera_map).
// Đọc cùng DB: camera_map, camera_map_marker, infra_nvr_camera_status, camera_health, camera_locations.
// Chỉ đọc (xem layout). Việc vẽ/sửa layout vẫn làm ở app Flask.
import express from 'express';

const CAMERA_KEY = `CASE WHEN COALESCE(c.serial,'') <> '' THEN c.serial
                         ELSE 'ip:' || host(c.camera_ip::inet) END`;

// Nhiều mức truy vấn: nếu DB thật thiếu cột/bảng phụ (camera_health, camera_locations,
// detect_result...) thì tự hạ mức, ghim vẫn hiện thay vì lỗi 500.
const TIERS = [
    { detect: true,  health: true,  loc: true  },
    { detect: true,  health: false, loc: false },
    { detect: false, health: false, loc: false },
];

function camerasCte(t) {
    const status = t.detect
        ? `CASE WHEN c.online IS TRUE THEN 'online'
                WHEN c.online IS FALSE THEN 'offline'
                WHEN LOWER(COALESCE(c.detect_result,'')) IN ('online','connect','connected','up') THEN 'online'
                WHEN LOWER(COALESCE(c.detect_result,'')) IN ('offline','disconnect','disconnected','down','failed') THEN 'offline'
                ELSE 'warning' END`
        : `CASE WHEN c.online IS TRUE THEN 'online'
                WHEN c.online IS FALSE THEN 'offline'
                ELSE 'warning' END`;
    const hCols = t.health
        ? `COALESCE(h.state,'') AS health, COALESCE(h.reason,'') AS health_reason, h.since AS health_since`
        : `''::text AS health, ''::text AS health_reason, NULL::timestamptz AS health_since`;
    const hJoin = t.health
        ? `LEFT JOIN itsec_camera_health h ON host(h.nvr_ip::inet) = host(c.nvr_ip::inet)
                                    AND h.channel_id::text = c.channel_id::text`
        : '';
    return `
    cams_raw AS (
        SELECT ${CAMERA_KEY} AS camera_key,
               c.camera_name, host(c.camera_ip::inet) AS camera_ip, COALESCE(c.serial,'') AS serial,
               COALESCE(c.model,'') AS model, host(c.nvr_ip::inet) AS nvr_ip, c.channel_id,
               ${status} AS status, ${hCols}
        FROM itsec_infra_nvr_camera_status c ${hJoin}
    ),
    cams AS (
        SELECT camera_key,
               (ARRAY_AGG(camera_name ORDER BY (status='online') DESC, nvr_ip, channel_id))[1] AS name,
               (ARRAY_AGG(camera_ip   ORDER BY (status='online') DESC, nvr_ip, channel_id))[1] AS ip,
               MAX(serial) AS serial, MAX(model) AS model,
               STRING_AGG(nvr_ip || ' CH' || channel_id, ', ' ORDER BY nvr_ip, channel_id) AS channels,
               CASE WHEN BOOL_OR(status='online') THEN 'online'
                    WHEN BOOL_OR(status='warning') THEN 'warning' ELSE 'offline' END AS status,
               (ARRAY_AGG(health        ORDER BY (health NOT IN ('','ok')) DESC, nvr_ip, channel_id))[1] AS health,
               (ARRAY_AGG(health_reason ORDER BY (health NOT IN ('','ok')) DESC, nvr_ip, channel_id))[1] AS health_reason,
               (ARRAY_AGG(health_since  ORDER BY (health NOT IN ('','ok')) DESC, nvr_ip, channel_id))[1] AS health_since
        FROM cams_raw GROUP BY camera_key
    )`;
}

function markerSelect(t) {
    const loc = t.loc
        ? `COALESCE(loc.switch_name,'') AS switch_name, COALESCE(loc.port,'') AS switch_port,
           COALESCE(NULLIF(loc.nms_room,''), loc.room, '') AS room`
        : `''::text AS switch_name, ''::text AS switch_port, ''::text AS room`;
    const locJoin = t.loc
        ? `LEFT JOIN itsec_camera_locations loc ON host(loc.camera_ip::inet) = COALESCE(cams.ip, byip.ip, k.last_ip)`
        : '';
    return `
    SELECT k.id, k.map_id, k.camera_key, k.x, k.y, k.direction, k.fov, k.view_range,
           (k.camera_key IS NULL) AS planned, COALESCE(k.label,'') AS label,
           COALESCE(cams.name, byip.name, k.last_name, k.label, '') AS name,
           COALESCE(cams.ip, byip.ip, k.last_ip, '') AS ip,
           COALESCE(cams.serial, byip.serial, '') AS serial,
           COALESCE(cams.model, byip.model, '') AS model,
           COALESCE(cams.channels, byip.channels, '') AS channels,
           CASE WHEN k.camera_key IS NULL THEN 'planned'
                ELSE COALESCE(cams.status, byip.status, 'missing') END AS status,
           COALESCE(cams.health, byip.health, '') AS health,
           COALESCE(cams.health_reason, byip.health_reason, '') AS health_reason,
           EXTRACT(EPOCH FROM COALESCE(cams.health_since, byip.health_since))::bigint AS health_since,
           ${loc}
    FROM itsec_camera_map_marker k
    LEFT JOIN cams ON cams.camera_key = k.camera_key
    LEFT JOIN LATERAL (SELECT * FROM cams b
                       WHERE k.camera_key IS NOT NULL AND cams.camera_key IS NULL
                         AND b.ip = k.last_ip LIMIT 1) byip ON TRUE
    ${locJoin}`;
}

export default function layoutRouter(pool, logger = console) {
    const r = express.Router();
    let tier = 0;   // mức truy vấn đã chạy được

    // Chạy truy vấn; lỗi thì hạ mức rồi thử lại.
    async function run(build, params = []) {
        let lastErr;
        for (let i = tier; i < TIERS.length; i++) {
            try {
                const res = await pool.query(build(TIERS[i]), params);
                if (i !== tier) {
                    tier = i;
                    logger.warn?.(`[layout] dùng truy vấn mức ${i} (DB thiếu cột/bảng phụ): ${lastErr?.message}`);
                }
                return res;
            } catch (e) { lastErr = e; logger.error?.(`[layout] SQL mức ${i} lỗi: ${e.message}`); }
        }
        throw lastErr;
    }

    const num = (v) => (v === null || v === undefined ? null : Number(v));
    const toMarker = (m) => ({ ...m, health_since: num(m.health_since) });
    const safe = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (e) { logger.error?.('[layout] ' + e.message); res.status(500).json({ ok: false, error: e.message }); }
    };

    r.get('/maps', safe(async (req, res) => {
        const { rows } = await run((t) => `
            WITH ${camerasCte(t)}
            SELECT m.id, m.name, COALESCE(m.building,'') AS building, m.sort_order, m.width, m.height, m.mime,
                   EXTRACT(EPOCH FROM m.updated_at)::bigint AS version, m.image_rev,
                   COUNT(k.id) AS pins,
                   COUNT(k.id) FILTER (WHERE k.camera_key IS NOT NULL
                                         AND COALESCE(cams.status,'missing') <> 'online') AS not_online
            FROM itsec_camera_map m
            LEFT JOIN itsec_camera_map_marker k ON k.map_id = m.id
            LEFT JOIN cams ON cams.camera_key = k.camera_key
            GROUP BY m.id
            ORDER BY COALESCE(m.building,''), m.sort_order, m.name`);
        res.json({ ok: true, maps: rows.map((m) => ({ ...m, version: num(m.version), pins: num(m.pins), not_online: num(m.not_online) })) });
    }));

    r.get('/find', safe(async (req, res) => {
        const q = `%${String(req.query.q || '').trim().toLowerCase().slice(0, 100)}%`;
        const { rows } = await run((t) => `
            WITH ${camerasCte(t)}
            SELECT p.*, m.name AS map_name FROM (${markerSelect(t)}) p
            JOIN itsec_camera_map m ON m.id = p.map_id
            WHERE LOWER(p.name) LIKE $1 OR p.ip LIKE $1 OR LOWER(p.serial) LIKE $1
                  OR LOWER(p.channels) LIKE $1 OR LOWER(p.label) LIKE $1
            ORDER BY p.name LIMIT 50`, [q]);
        res.json({ ok: true, rows: rows.map(toMarker) });
    }));

    r.get('/:id/markers', safe(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'bad id' });
        const { rows } = await run((t) => `
            WITH ${camerasCte(t)} ${markerSelect(t)} WHERE k.map_id = $1 ORDER BY k.id`, [id]);
        res.json({ ok: true, markers: rows.map(toMarker) });
    }));

    r.get('/:id/image', safe(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.sendStatus(400);
        const { rows } = await pool.query(
            `SELECT image, mime, image_rev, EXTRACT(EPOCH FROM updated_at)::bigint AS v FROM itsec_camera_map WHERE id = $1`, [id]);
        if (!rows.length) return res.sendStatus(404);
        const { image, mime, image_rev, v } = rows[0];
        const etag = `"map${id}-${image_rev}-${v}"`;
        res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' });
        if (mime === 'image/svg+xml') {
            res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
        }
        if (req.headers['if-none-match'] === etag) return res.sendStatus(304);
        res.type(mime).send(image);
    }));

    return r;
}