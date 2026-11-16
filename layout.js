/* layout.js — Camera Layout viewer, chạy thẳng trong dashboard (không iframe).
 * Dùng: LayoutViewer.open({ lang: 'zh'|'vi'|'en', q: '10.1.2.3' })   // q tùy chọn: nhảy tới camera
 *       LayoutViewer.close();  LayoutViewer.setLang('vi');
 * Dữ liệu: GET /api/layout/maps, /:id/markers, /:id/image, /find?q=   (layoutApi.js)
 */
(function () {
  var API = '/api/layout', REFRESH_MS = 15000, SVGNS = 'http://www.w3.org/2000/svg';

  var L10N = {
    zh: { title: '摄像头布局图', plan: '楼层', find: '搜索摄像头：名称、IP、序号、NVR', names: '名称', online: '在线', offline: '离线', warning: '未知', missing: '无数据', planned: '规划中',
          noPlans: '尚未上传任何布局图', loadFail: '加载失败', noRes: '没有结果', ip: 'IP', ch: '通道', sw: '交换机', room: '机房', model: '型号', serial: '序列号', status: '状态', health: '画面',
          ok: '正常', pins: '个点位', fit: '适应窗口',
          h: { offline: '离线', black: '黑屏', covered: '遮挡', frozen: '画面冻结', noir: '夜视异常', blurred: '模糊', moved: '位置移动', bright: '过亮', colour: '偏色', contrast: '对比度', noisy: '噪点', bwday: '白天黑白', suspect: '可疑' } },
    vi: { title: 'Layout camera', plan: 'Mặt bằng', find: 'Tìm camera: tên, IP, serial, NVR', names: 'Tên', online: 'Online', offline: 'Offline', warning: 'Chưa rõ', missing: 'Không có dữ liệu', planned: 'Dự kiến',
          noPlans: 'Chưa có mặt bằng nào', loadFail: 'Tải thất bại', noRes: 'Không có kết quả', ip: 'IP', ch: 'Kênh', sw: 'Switch', room: 'Phòng', model: 'Model', serial: 'Serial', status: 'Trạng thái', health: 'Hình ảnh',
          ok: 'Bình thường', pins: 'camera', fit: 'Vừa khung',
          h: { offline: 'Mất kết nối', black: 'Màn hình đen', covered: 'Bị che', frozen: 'Đứng hình', noir: 'Lỗi hồng ngoại', blurred: 'Mờ', moved: 'Bị xoay lệch', bright: 'Quá sáng', colour: 'Lệch màu', contrast: 'Tương phản', noisy: 'Nhiễu', bwday: 'Đen trắng ban ngày', suspect: 'Nghi ngờ' } },
    en: { title: 'Camera layout', plan: 'Plan', find: 'Find a camera: name, IP, serial, NVR', names: 'Names', online: 'Online', offline: 'Offline', warning: 'Unknown', missing: 'No data', planned: 'Planned',
          noPlans: 'No floor plan uploaded yet', loadFail: 'Load failed', noRes: 'No results', ip: 'IP', ch: 'Channels', sw: 'Switch', room: 'Room', model: 'Model', serial: 'Serial', status: 'Status', health: 'Picture',
          ok: 'OK', pins: 'cameras', fit: 'Fit',
          h: { offline: 'No connection', black: 'Black picture', covered: 'Covered', frozen: 'Frozen', noir: 'IR fault', blurred: 'Blurred', moved: 'Moved', bright: 'Too bright', colour: 'Colour cast', contrast: 'Contrast', noisy: 'Noisy', bwday: 'B/W by day', suspect: 'Suspect' } }
  };
  // Chuỗi cho: xuất PDF, nhảy tới camera lỗi, copy IP
  var EXTRA = {
    zh: { pdf: '导出 PDF', pdfBusy: '正在生成 PDF（大图需要几秒）…', pdfFail: '无法生成 PDF：', next: '{0} 台摄像头异常', copyIp: '复制 IP', copied: '已复制' },
    vi: { pdf: 'Xuất PDF', pdfBusy: 'Đang tạo PDF (mặt bằng lớn mất vài giây)…', pdfFail: 'Không tạo được PDF:', next: '{0} camera lỗi', copyIp: 'Copy IP', copied: 'Đã copy' },
    en: { pdf: 'Export PDF', pdfBusy: 'Building the PDF (large plans take a few seconds)…', pdfFail: 'Could not build the PDF:', next: '{0} camera problems', copyIp: 'Copy IP', copied: 'Copied' }
  };
  Object.keys(EXTRA).forEach(function (k) { for (var f in EXTRA[k]) L10N[k][f] = EXTRA[k][f]; });
  // Chữ trong file PDF: font DejaVu không có chữ Hán nên tiếng Trung dùng bản tiếng Anh.
  var PDFT = {
    vi: { subject: 'Mặt bằng camera', listTitle: 'Danh sách camera', page: 'Trang', colCode: 'Mã', colName: 'Camera', colStatus: 'Trạng thái', colIp: 'IP', colChannel: 'NVR / kênh', colModel: 'Model', colSerial: 'Serial', colSwitch: 'Switch / port', colRoom: 'Phòng', colAim: 'Hướng / góc', sub: 'Xuất lúc {0} · {1} camera' },
    en: { subject: 'Camera floor plan', listTitle: 'Camera list', page: 'Page', colCode: 'Code', colName: 'Camera', colStatus: 'Status', colIp: 'IP', colChannel: 'NVR / channel', colModel: 'Model', colSerial: 'Serial', colSwitch: 'Switch / port', colRoom: 'Machine room', colAim: 'Direction / angle', sub: 'Exported {0} · {1} cameras' }
  };
  var HEALTH_BAD = { offline: 1, black: 1, covered: 1, frozen: 1, noir: 1 },
      HEALTH_WARN = { blurred: 1, moved: 1, bright: 1, colour: 1, contrast: 1, noisy: 1, bwday: 1, suspect: 1 };
  var STATUSES = ['online', 'offline', 'warning', 'missing', 'planned'];
  var CAM_SVG = '<svg viewBox="0 0 24 24"><path d="M17 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5l5 4v-11l-5 4z"/></svg>';

  var lang = 'zh', built = false, timer = null;
  var plans = [], plan = null, markers = [], byId = {}, selId = null, namesOn = false;
  var W = 1, H = 1, view = { s: 1, tx: 0, ty: 0 }, fitS = 1, loadToken = 0;
  var el = {};

  function T() { return L10N[lang] || L10N.en; }
  function $(id) { return document.getElementById(id); }
  function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function getJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ── dựng khung (một lần) ───────────────────────────────────────────────
  function build() {
    if (built) return; built = true;
    var o = mk('div', 'lay-overlay'); o.id = 'lay-overlay';
    o.innerHTML =
      '<div class="lay-box">' +
        '<div class="lay-head">' +
          '<span class="lay-title" id="lay-title"></span>' +
          '<select id="lay-plan"></select>' +
          '<input id="lay-q" type="search" autocomplete="off">' +
          '<button class="lay-btn" id="lay-names"></button>' +
          '<button class="lay-btn" id="lay-pdf" disabled></button>' +
          '<button class="lay-btn lay-warnbtn" id="lay-next" hidden></button>' +
          '<div class="lay-legend" id="lay-legend"></div>' +
          '<button class="lay-close" id="lay-x" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="lay-body">' +
          '<div class="lay-viewport" id="lay-vp">' +
            '<div class="lay-stage" id="lay-stage"><img id="lay-img" alt="">' +
              '<svg class="lay-cones" id="lay-cones"></svg><div id="lay-pins"></div></div>' +
          '</div>' +
          '<div class="lay-note" id="lay-note"></div>' +
          '<div class="lay-zoom"><button id="lay-zin">+</button><button id="lay-zout">&minus;</button><button id="lay-zfit" title="Fit">&#9974;</button></div>' +
          '<div class="lay-find" id="lay-find"></div>' +
          '<div class="lay-card" id="lay-card"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(o);
    ['overlay', 'title', 'plan', 'q', 'names', 'legend', 'x', 'vp', 'stage', 'img', 'cones', 'pins', 'note', 'zin', 'zout', 'zfit', 'find', 'card', 'pdf', 'next']
      .forEach(function (k) { el[k] = $(k === 'overlay' ? 'lay-overlay' : 'lay-' + k); });

    el.x.onclick = close;
    el.names.onclick = function () { namesOn = !namesOn; applyNames(); };
    el.plan.onchange = function () { openPlan(+el.plan.value); };
    el.zin.onclick = function () { zoomAt(1.4, el.vp.clientWidth / 2, el.vp.clientHeight / 2); };
    el.zout.onclick = function () { zoomAt(1 / 1.4, el.vp.clientWidth / 2, el.vp.clientHeight / 2); };
    el.zfit.onclick = function () { fit(); };
    el.pdf.onclick = exportPdf;
    el.next.onclick = function () {
      var list = markers.filter(isBad);
      if (!list.length) return;
      badIdx = (badIdx + 1) % list.length;
      focusMarker(list[badIdx]);
    };
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.overlay.classList.contains('active')) close(); });
    window.addEventListener('resize', function () { if (el.overlay.classList.contains('active') && plan) { var f = fitScale(); if (view.s < f) fit(); } });

    // zoom bằng lăn chuột (quanh con trỏ)
    el.vp.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = el.vp.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    // kéo để di chuyển; chạm/bấm không kéo = chọn ghim
    var drag = null, moved = false;
    el.vp.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }; moved = false;
      el.vp.setPointerCapture(e.pointerId);
    });
    el.vp.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { moved = true; el.vp.classList.add('drag'); }
      if (moved) { view.tx = drag.tx + dx; view.ty = drag.ty + dy; applyView(); }
    });
    el.vp.addEventListener('pointerup', function (e) {
      var wasMoved = moved; drag = null; el.vp.classList.remove('drag');
      if (wasMoved) return;
      var hit = document.elementFromPoint(e.clientX, e.clientY);   // pointer capture đổi e.target
      var pin = hit && hit.closest && hit.closest('.lay-pin');
      select(pin ? +pin.dataset.id : null);
    });

    // tìm camera
    var t;
    el.q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(doFind, 250); });
    el.q.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(t); doFind(); } });
    el.q.addEventListener('focus', function () { if (el.find.children.length) el.find.classList.add('open'); });
    el.vp.addEventListener('pointerdown', function () { el.find.classList.remove('open'); });
  }

  // ── viewport ───────────────────────────────────────────────────────────
  function fitScale() { return Math.min(el.vp.clientWidth / W, el.vp.clientHeight / H) * 0.97; }
  function applyView() {
    el.stage.style.transform = 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.s + ')';
    el.stage.style.setProperty('--inv', 1 / view.s);
  }
  function fit() {
    fitS = fitScale(); view.s = fitS;
    view.tx = (el.vp.clientWidth - W * view.s) / 2; view.ty = (el.vp.clientHeight - H * view.s) / 2;
    applyView();
  }
  function zoomAt(f, cx, cy) {
    var ns = Math.min(Math.max(view.s * f, fitS * 0.4), 14);
    view.tx = cx - (cx - view.tx) * ns / view.s; view.ty = cy - (cy - view.ty) * ns / view.s; view.s = ns;
    applyView();
  }
  function centerOn(m, scale) {
    view.s = Math.max(view.s, scale || 1);
    view.tx = el.vp.clientWidth / 2 - m.x * W * view.s; view.ty = el.vp.clientHeight / 2 - m.y * H * view.s;
    applyView();
  }

  // ── vẽ ghim + vùng nhìn (cùng hình học với camera_map) ─────────────────
  function conePath(m) {
    var cx = m.x * W, cy = m.y * H, r = Math.max(1, m.view_range * W);
    if (m.fov >= 359) return 'M' + (cx - r) + ',' + cy + ' a' + r + ',' + r + ' 0 1,0 ' + (2 * r) + ',0 a' + r + ',' + r + ' 0 1,0 ' + (-2 * r) + ',0Z';
    var a1 = (m.direction - m.fov / 2) * Math.PI / 180, a2 = (m.direction + m.fov / 2) * Math.PI / 180;
    return 'M' + cx + ',' + cy + ' L' + (cx + r * Math.sin(a1)) + ',' + (cy - r * Math.cos(a1)) +
      ' A' + r + ',' + r + ' 0 ' + (m.fov > 180 ? 1 : 0) + ',1 ' + (cx + r * Math.sin(a2)) + ',' + (cy - r * Math.cos(a2)) + 'Z';
  }
  function healthProblem(m) { return !m.planned && (HEALTH_BAD[m.health] || HEALTH_WARN[m.health]) ? m.health : ''; }
  function stClass(m) { return 'st-' + (m.status || 'missing'); }

  function drawAll() {
    el.pins.innerHTML = ''; el.cones.innerHTML = '';
    el.cones.setAttribute('width', W); el.cones.setAttribute('height', H);
    byId = {};
    markers.forEach(function (m) {
      byId[m.id] = m;
      var h = healthProblem(m);
      var p = mk('div', 'lay-pin ' + stClass(m) + (m.planned ? ' planned' : '') + (h ? (HEALTH_BAD[h] ? ' hl-bad' : ' hl-warn') : '') + (m.id === selId ? ' sel' : ''));
      p.dataset.id = m.id; p.innerHTML = CAM_SVG;
      p.style.left = (m.x * W) + 'px'; p.style.top = (m.y * H) + 'px';
      p.appendChild(mk('span', 'lbl', m.name || m.ip || '?'));
      el.pins.appendChild(p); m._el = p;
      var c = document.createElementNS(SVGNS, 'path');
      c.setAttribute('d', conePath(m));
      c.setAttribute('class', 'lay-cone ' + stClass(m) + (m.id === selId ? ' sel' : '') + (m.planned ? ' planned' : ''));
      el.cones.appendChild(c);
    });
    if (selId && !byId[selId]) select(null);
    renderLegend(); updateNext();
  }
  function applyNames() { el.stage.classList.toggle('lay-labels', namesOn); el.names.classList.toggle('on', namesOn); }

  function renderLegend() {
    var counts = {}; markers.forEach(function (m) { counts[m.status] = (counts[m.status] || 0) + 1; });
    el.legend.innerHTML = '';
    STATUSES.forEach(function (s) {
      if (!counts[s] && s !== 'online' && s !== 'offline') return;
      var chip = mk('span', 'lay-chip st-' + s);
      chip.appendChild(mk('i', 'lay-dot'));
      chip.appendChild(document.createTextNode(T()[s] + ' ' + (counts[s] || 0)));
      el.legend.appendChild(chip);
    });
  }

  // ── thẻ chi tiết ───────────────────────────────────────────────────────
  function select(id) {
    var prev = byId[selId];
    selId = id;
    if (prev && prev._el) { prev._el.classList.remove('sel'); }
    var m = byId[id];
    el.card.classList.toggle('open', !!m);
    if (!m) { drawSelCones(); return; }
    m._el.classList.add('sel'); drawSelCones(); showCard(m);
  }
  function drawSelCones() {
    var paths = el.cones.children;
    markers.forEach(function (m, i) { if (paths[i]) paths[i].classList.toggle('sel', m.id === selId); });
  }
  function showCard(m) {
    var t = T(), h = healthProblem(m);
    var hText = h ? ((t.h[h] || h) + (m.health_reason ? ' — ' + m.health_reason : '') +
      (m.health_since ? ' (' + new Date(m.health_since * 1000).toLocaleString() + ')' : '')) : (m.planned ? '' : t.ok);
    el.card.innerHTML = '';
    var x = mk('button', 'x', '×'); x.onclick = function () { select(null); };
    var head = mk('h4'); head.appendChild(mk('i', 'lay-dot st-' + m.status)); head.appendChild(document.createTextNode(' ' + (m.name || '—')));
    var tb = mk('table');
    [[t.status, t[m.status] || m.status], [t.health, hText, h ? (HEALTH_BAD[h] ? 'bad' : 'warn') : ''],
     [t.ip, m.ip], [t.ch, m.channels], [t.sw, m.switch_name ? m.switch_name + (m.switch_port ? ' · ' + m.switch_port : '') : ''],
     [t.room, m.room], [t.model, m.model], [t.serial, m.serial]].forEach(function (r) {
      if (r[0] === t.health && !r[1]) return;
      var tr = mk('tr'); tr.appendChild(mk('td', null, r[0]));
      tr.appendChild(mk('td', r[2] || '', r[1] || '—')); tb.appendChild(tr);
    });
    el.card.appendChild(x); el.card.appendChild(head); el.card.appendChild(tb);
    if (m.ip) {
      var cp = mk('button', 'lay-btn lay-copy', t.copyIp);
      cp.onclick = function () {
        copyText(m.ip).then(function () { cp.textContent = '✓ ' + T().copied; setTimeout(function () { cp.textContent = T().copyIp; }, 1500); });
      };
      el.card.appendChild(cp);
    }
  }

  // ── tìm camera ─────────────────────────────────────────────────────────
  function doFind() {
    var q = el.q.value.trim();
    if (q.length < 2) { el.find.classList.remove('open'); return Promise.resolve(); }
    return getJSON(API + '/find?q=' + encodeURIComponent(q)).then(function (j) {
      el.find.innerHTML = '';
      if (!j.rows.length) el.find.appendChild(mk('div', 'lay-find-row', T().noRes));
      j.rows.forEach(function (m) {
        var row = mk('div', 'lay-find-row st-' + m.status);
        row.appendChild(mk('i', 'lay-dot'));
        row.appendChild(mk('span', null, (m.name || m.label || '?') + ' · ' + (m.ip || '')));
        row.appendChild(mk('small', null, m.map_name || ''));
        row.onclick = function () { el.find.classList.remove('open'); jumpTo(m); };
        el.find.appendChild(row);
      });
      el.find.classList.add('open');
      return j.rows;
    }).catch(function () { el.find.innerHTML = ''; el.find.appendChild(mk('div', 'lay-find-row', T().loadFail)); el.find.classList.add('open'); });
  }
  function jumpTo(m) {
    var go = function () {
      var t = byId[m.id]; if (!t) return;
      select(t.id); centerOn(t, Math.max(1, fitS * 3));
      t._el.classList.add('pulse'); setTimeout(function () { t._el && t._el.classList.remove('pulse'); }, 4200);
    };
    if (plan && plan.id === m.map_id) go(); else openPlan(m.map_id).then(go);
  }

  // ── nạp dữ liệu ────────────────────────────────────────────────────────
  function fillPlanSelect() {
    el.plan.innerHTML = '';
    var groups = {};
    plans.forEach(function (p) {
      var g = groups[p.building || ''];
      if (!g) { g = groups[p.building || ''] = p.building ? mk('optgroup') : el.plan; if (p.building) { g.label = p.building; el.plan.appendChild(g); } }
      var o = mk('option', null, p.name + ' (' + p.pins + (p.not_online ? ' · ' + p.not_online + ' ⚠' : '') + ')'); o.value = p.id;
      g.appendChild(o);
    });
    if (plan) el.plan.value = plan.id;
  }
  function openPlan(id) {
    var p = plans.filter(function (x) { return x.id === id; })[0];
    if (!p) return Promise.resolve();
    plan = p; selId = null; el.card.classList.remove('open'); el.plan.value = id;
    W = p.width; H = p.height;
    el.stage.style.width = W + 'px'; el.stage.style.height = H + 'px';
    el.note.textContent = '…';
    var token = ++loadToken;
    el.img.onload = null;
    var imgReady = new Promise(function (res) { el.img.onload = res; el.img.onerror = res; });
    el.img.src = API + '/' + p.id + '/image?v=' + p.version + '.' + p.image_rev;
    return Promise.all([getJSON(API + '/' + id + '/markers'), imgReady]).then(function (r) {
      if (token !== loadToken) return;
      markers = r[0].markers; el.note.textContent = '';
      drawAll(); fit(); applyNames(); el.pdf.disabled = false;
    }).catch(function (e) { el.note.textContent = T().loadFail + ': ' + e.message; });
  }
  function reload(first) {
    return getJSON(API + '/maps').then(function (j) {
      plans = j.maps; fillPlanSelect();
      if (!plans.length) { el.note.textContent = T().noPlans; el.stage.style.display = 'none'; return; }
      el.stage.style.display = '';
      if (first || !plan) return openPlan(plans[0].id);
      // làm tươi định kỳ: giữ nguyên vị trí xem, chỉ cập nhật trạng thái
      var cur = plans.filter(function (x) { return x.id === plan.id; })[0];
      if (!cur) return openPlan(plans[0].id);
      if (cur.version !== plan.version || cur.image_rev !== plan.image_rev) return openPlan(cur.id);
      plan = cur; el.plan.value = cur.id;
      return getJSON(API + '/' + cur.id + '/markers').then(function (r) { markers = r.markers; drawAll(); applyNames(); if (selId && byId[selId]) showCard(byId[selId]); });
    }).catch(function (e) { if (first) el.note.textContent = T().loadFail + ': ' + e.message; });
  }

  // ── camera lỗi: mỗi lần bấm nhảy tới camera lỗi kế tiếp ───────────────
  var badIdx = -1;
  function isBad(m) { return !m.planned && (m.status === 'offline' || !!healthProblem(m)); }
  function updateNext() {
    if (!el.next) return;
    var n = markers.filter(isBad).length;
    el.next.hidden = !n; badIdx = -1;
    el.next.textContent = '⚠ ' + T().next.replace('{0}', n);
  }
  function focusMarker(m) {
    var t = byId[m.id]; if (!t) return;
    select(t.id); centerOn(t, Math.max(1, fitS * 3));
    t._el.classList.add('pulse'); setTimeout(function () { t._el && t._el.classList.remove('pulse'); }, 4200);
  }

  // ── copy IP ────────────────────────────────────────────────────────────
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  // ── xuất PDF (dựng ngay trên trình duyệt; jsPDF chỉ nạp khi bấm) ──────
  var pdfBusy = false;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-src="' + src + '"]')) return resolve();
      var s = document.createElement('script');
      s.src = src; s.dataset.src = src;
      s.onload = resolve; s.onerror = function () { reject(new Error('load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function exportPdf() {
    if (!plan || pdfBusy) return;
    pdfBusy = true; el.pdf.disabled = true;
    var p = plan, now = new Date(), t = T(), pt = PDFT[lang] || PDFT.en;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
    var tr = {};   // nhãn trạng thái trong PDF
    STATUSES.forEach(function (s) { tr[s] = (lang === 'zh' ? L10N.en : t)[s]; });
    for (var k in pt) tr[k] = pt[k];
    el.note.textContent = t.pdfBusy;
    loadScript('/vendor/jspdf/jspdf.umd.min.js').then(function () { return loadScript('/js/layout_pdf.js?v=1'); }).then(function () {
      return window.CmapPdf.build({
        title: p.building ? p.building + ' · ' + p.name : p.name,
        subtitle: pt.sub.replace('{0}', now.toLocaleString()).replace('{1}', markers.length),
        user: '', width: W, height: H, mime: p.mime,
        imageUrl: API + '/' + p.id + '/image?v=' + p.version + '.' + p.image_rev,
        fontUrl: '/vendor/jspdf/DejaVuSans.ttf', fontBoldUrl: '/vendor/jspdf/DejaVuSans-Bold.ttf',
        markers: markers.map(function (m) {
          return { x: m.x, y: m.y, direction: m.direction, fov: m.fov, view_range: m.view_range, status: m.status,
                   planned: m.planned, name: m.name, ip: m.ip, channels: m.channels, model: m.model, serial: m.serial,
                   switch_name: m.switch_name, switch_port: m.switch_port, room: m.room };
        }),
        t: tr
      });
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'CameraLayout_' + (String(p.name).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'plan') + '_' + stamp + '.pdf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    }).catch(function (err) {
      alert(t.pdfFail + ' ' + (err && err.message || err));
    }).then(function () { el.note.textContent = ''; pdfBusy = false; el.pdf.disabled = !plan; });
  }

  // ── API công khai ──────────────────────────────────────────────────────
  function labels() {
    var t = T();
    el.title.textContent = t.title; el.q.placeholder = t.find; el.names.textContent = t.names; el.zfit.title = t.fit; el.pdf.textContent = '⬇ ' + t.pdf; updateNext();
    renderLegend(); if (selId && byId[selId]) showCard(byId[selId]);
  }
  function open(opts) {
    opts = opts || {}; if (opts.lang) lang = opts.lang;
    build(); labels();
    el.overlay.classList.add('active');
    plan = null; markers = []; selId = null; el.pdf.disabled = true; el.stage.style.display = 'none'; el.note.textContent = '…';
    reload(true).then(function () {
      el.stage.style.display = plans.length ? '' : 'none';
      if (opts.q) { el.q.value = opts.q; doFind().then(function (rows) { if (rows && rows[0]) jumpTo(rows[0]); }); }
    });
    clearInterval(timer); timer = setInterval(function () { reload(false); }, REFRESH_MS);
  }
  function close() {
    if (!built) return;
    el.overlay.classList.remove('active'); clearInterval(timer); timer = null;
    el.img.removeAttribute('src');   // giải phóng ảnh lớn
  }
  function setLang(l) { lang = l; if (built) labels(); }

  window.LayoutViewer = { open: open, close: close, setLang: setLang };
})();