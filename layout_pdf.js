/* Camera Map → PDF.
 *
 * Page 1 is the plan at its own pixel resolution (the stored picture embedded
 * untouched where possible) with every camera drawn on top as vector graphics —
 * pin, code, view cone — so the overlay stays sharp at any zoom. The following
 * pages list each camera in a table.
 *
 * Loaded on demand by layout.js together with jsPDF; exposes
 * window.CmapPdf.build(data) -> Promise<Blob>.
 */
(function () {
  "use strict";

  var COLORS = {
    online: [30, 158, 87], offline: [217, 48, 37], warning: [230, 155, 0],
    missing: [138, 148, 166], planned: [91, 107, 130]
  };
  // PDF viewers (Acrobat in particular) refuse pages beyond 14,400 pt (200 in).
  var MAX_PAGE_PT = 14000;
  // A plan smaller than about A3 is scaled up so the pins and text stay legible.
  var MIN_PAGE_PT = 1190;

  function rgb(status) { return COLORS[status] || COLORS.missing; }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf), out = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(out);
  }
  function fetchBuf(url) {
    return fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
      return r.arrayBuffer();
    });
  }

  // PNG and JPEG are handed to jsPDF as they are; anything else (SVG, WEBP, GIF)
  // is drawn onto a canvas at the plan's full size first.
  function planImage(url, mime, W, H) {
    if (mime === "image/png" || mime === "image/jpeg") {
      return fetchBuf(url).then(function (buf) {
        return { data: new Uint8Array(buf), format: mime === "image/png" ? "PNG" : "JPEG" };
      });
    }
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () {
        var c = document.createElement("canvas");
        c.width = W; c.height = H;
        var g = c.getContext("2d");
        g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
        g.drawImage(im, 0, 0, W, H);
        resolve({ data: c, format: "PNG" });
      };
      im.onerror = function () { reject(new Error("plan image")); };
      im.src = url;
    });
  }

  // The camera's code ("233-25" in "233-25 F1-2F PHONG IT") is how people name a
  // camera, so it is what the plan shows and what the table is sorted by.
  var CODE = /^\s*(\d+-\d+)(?!\d)/;
  function cameraCode(m) {
    var g = CODE.exec(m.name || "");
    return g ? g[1] : (m.name || m.ip || "?");
  }
  function byCode(markers) {
    var key = function (m) {
      var g = CODE.exec(m.name || "");
      return g ? g[1].split("-").map(Number) : [Infinity, Infinity];
    };
    var list = markers.slice();
    list.forEach(function (m) { m._code = cameraCode(m); m._key = key(m); });
    return list.sort(function (a, b) {
      return a._key[0] - b._key[0] || a._key[1] - b._key[1] || a._code.localeCompare(b._code);
    });
  }

  function conePoints(cx, cy, r, dir, fov) {
    var pts = [[cx, cy]], a1 = dir - fov / 2, steps = Math.max(6, Math.ceil(fov / 3));
    for (var i = 0; i <= steps; i++) {
      var a = (a1 + fov * i / steps) * Math.PI / 180;
      pts.push([cx + r * Math.sin(a), cy - r * Math.cos(a)]);
    }
    return pts;
  }
  // jsPDF draws polygons from relative segments.
  function polygon(doc, pts, style) {
    var segs = [];
    for (var i = 1; i < pts.length; i++) segs.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
    doc.lines(segs, pts[0][0], pts[0][1], [1, 1], style, true);
  }

  function build(d) {
    var J = window.jspdf && window.jspdf.jsPDF;
    if (!J) return Promise.reject(new Error("jsPDF not loaded"));
    var T = d.t, W = d.width, H = d.height;
    var k = Math.max(Math.min(1, MAX_PAGE_PT / Math.max(W, H)), MIN_PAGE_PT / Math.max(W, H));
    var pw = W * k, ph = H * k;
    var unit = Math.max(pw, ph) / 1000;          // everything else is sized from this
    var pad = 14 * unit, headH = 46 * unit;
    var pageW = pw + 2 * pad, pageH = ph + headH + 2 * pad;
    var ox = pad, oy = pad + headH;

    return Promise.all([
      planImage(d.imageUrl, d.mime, W, H),
      fetchBuf(d.fontUrl), fetchBuf(d.fontBoldUrl)
    ]).then(function (res) {
      var img = res[0];
      var doc = new J({ unit: "pt", format: [pageW, pageH], orientation: pageW > pageH ? "l" : "p",
                        compress: true });
      // A Unicode font: camera and plan names carry Vietnamese.
      doc.addFileToVFS("DejaVuSans.ttf", toBase64(res[1]));
      doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
      doc.addFileToVFS("DejaVuSans-Bold.ttf", toBase64(res[2]));
      doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");
      doc.setProperties({ title: d.title, subject: T.subject, creator: "WVN Security Monitor — Camera Layout",
                          author: d.user || "" });

      var pins = byCode(d.markers);
      var counts = {};
      pins.forEach(function (m) { counts[m.status] = (counts[m.status] || 0) + 1; });

      // ── header: title, when/who, legend ──
      doc.setFont("DejaVu", "bold"); doc.setFontSize(17 * unit); doc.setTextColor(31, 45, 61);
      doc.text(d.title, pad, pad + 18 * unit);
      doc.setFont("DejaVu", "normal"); doc.setFontSize(8.5 * unit); doc.setTextColor(110, 120, 140);
      doc.text(d.subtitle, pad, pad + 32 * unit);
      var lx = pageW - pad, ly = pad + 18 * unit;
      ["online", "offline", "warning", "missing", "planned"].slice().reverse().forEach(function (s) {
        var txt = (T[s] || s) + " " + (counts[s] || 0);
        doc.setFontSize(9 * unit);
        var tw = doc.getTextWidth(txt);
        lx -= tw;
        doc.setTextColor(31, 45, 61); doc.text(txt, lx, ly);
        var c = rgb(s);
        lx -= 9 * unit;
        if (s === "planned") {
          doc.setDrawColor(c[0], c[1], c[2]); doc.setLineWidth(1.2 * unit); doc.setFillColor(255, 255, 255);
          doc.circle(lx + 3.5 * unit, ly - 3.2 * unit, 3.5 * unit, "FD");
        } else {
          doc.setFillColor(c[0], c[1], c[2]); doc.circle(lx + 3.5 * unit, ly - 3.2 * unit, 3.5 * unit, "F");
        }
        lx -= 14 * unit;
      });

      // ── the plan, full resolution ──
      doc.addImage(img.data, img.format, ox, oy, pw, ph, "plan", "FAST");
      doc.setDrawColor(200, 206, 216); doc.setLineWidth(0.6 * unit); doc.rect(ox, oy, pw, ph, "S");

      // About 0.5 % of the page: small enough that cameras a metre apart stay
      // separate, big enough to read the number once zoomed in.
      var pinR = Math.min(Math.max(2.1 * unit, 4), 20);
      var X = function (m) { return ox + m.x * pw; }, Y = function (m) { return oy + m.y * ph; };

      // Cones first, so no cone ever covers a pin or a name.
      pins.forEach(function (m) {
        var c = rgb(m.status), r = Math.max(1, m.view_range * pw);
        doc.setFillColor(c[0], c[1], c[2]); doc.setDrawColor(c[0], c[1], c[2]);
        doc.setLineWidth(0.8 * unit);
        doc.setLineDashPattern(m.planned ? [4 * unit, 3 * unit] : [], 0);
        doc.setGState(new doc.GState({ opacity: m.planned ? 0.08 : 0.18, "stroke-opacity": 0.7 }));
        if (m.fov >= 359) doc.circle(X(m), Y(m), r, "FD");
        else polygon(doc, conePoints(X(m), Y(m), r, m.direction, m.fov), "FD");
        doc.setGState(new doc.GState({ opacity: 1, "stroke-opacity": 1 }));
      });
      doc.setLineDashPattern([], 0);

      // Pins first, then the names, so a name plate never hides a pin.
      pins.forEach(function (m) {
        var c = rgb(m.status), x = X(m), y = Y(m);
        if (m.planned) {
          doc.setFillColor(255, 255, 255); doc.setDrawColor(c[0], c[1], c[2]);
          doc.setLineWidth(pinR * 0.16); doc.setLineDashPattern([pinR * 0.35, pinR * 0.25], 0);
          doc.circle(x, y, pinR, "FD"); doc.setLineDashPattern([], 0);
        } else {
          doc.setFillColor(c[0], c[1], c[2]); doc.setDrawColor(255, 255, 255);
          doc.setLineWidth(pinR * 0.16);
          doc.circle(x, y, pinR, "FD");
        }
      });

      // Names: each tries below, above, right, left of its pin and takes the
      // first spot that overlaps no pin and no name already placed.
      var fsz = pinR * 1.05, th = fsz * 1.25;
      var taken = pins.map(function (m) { return [X(m) - pinR, Y(m) - pinR, X(m) + pinR, Y(m) + pinR]; });
      var hits = function (r) {
        for (var i = 0; i < taken.length; i++) {
          var t = taken[i];
          if (r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]) return true;
        }
        return false;
      };
      doc.setFont("DejaVu", "bold"); doc.setFontSize(fsz);
      pins.forEach(function (m) {
        var name = m._code, x = X(m), y = Y(m);
        var tw = doc.getTextWidth(name) + fsz * 0.6, gap = pinR * 0.25;
        var spots = [
          [x - tw / 2, y + pinR + gap], [x - tw / 2, y - pinR - gap - th],
          [x + pinR + gap, y - th / 2], [x - pinR - gap - tw, y - th / 2]
        ];
        var pick = spots[0];
        for (var i = 0; i < spots.length; i++) {
          var r = [spots[i][0], spots[i][1], spots[i][0] + tw, spots[i][1] + th];
          if (!hits(r)) { pick = spots[i]; break; }
        }
        taken.push([pick[0], pick[1], pick[0] + tw, pick[1] + th]);
        doc.setGState(new doc.GState({ opacity: 0.85 }));
        doc.setFillColor(255, 255, 255);
        doc.roundedRect(pick[0], pick[1], tw, th, th * 0.2, th * 0.2, "F");
        doc.setGState(new doc.GState({ opacity: 1 }));
        doc.setTextColor(31, 45, 61);
        doc.text(name, pick[0] + tw / 2, pick[1] + th / 2, { align: "center", baseline: "middle" });
      });

      // ── the camera list ──
      if (pins.length) {
        var cols = [
          [T.colCode, 56], [T.colName, 175], [T.colStatus, 78], [T.colIp, 78], [T.colChannel, 118], [T.colModel, 84],
          [T.colSerial, 190], [T.colSwitch, 210], [T.colRoom, 70], [T.colAim, 76]
        ];
        var LW = 1191, LH = 842, M = 28, rowH = 14.5, fs = 7.2;   // A3 landscape
        var perPage = Math.floor((LH - M * 2 - 46) / rowH), pages = Math.ceil(pins.length / perPage);
        var clip = function (s, w) {
          s = String(s == null ? "" : s);
          if (doc.getTextWidth(s) <= w) return s;
          while (s.length > 1 && doc.getTextWidth(s + "…") > w) s = s.slice(0, -1);
          return s + "…";
        };
        for (var p = 0; p < pages; p++) {
          doc.addPage([LW, LH], "l");
          doc.setFont("DejaVu", "bold"); doc.setFontSize(12); doc.setTextColor(31, 45, 61);
          doc.text(d.title + " — " + T.listTitle, M, M + 8);
          doc.setFont("DejaVu", "normal"); doc.setFontSize(7.5); doc.setTextColor(110, 120, 140);
          doc.text(T.page + " " + (p + 2) + " / " + (pages + 1), LW - M, M + 8, { align: "right" });
          var y0 = M + 26;
          doc.setFillColor(238, 241, 245); doc.rect(M, y0, LW - 2 * M, rowH, "F");
          doc.setFont("DejaVu", "bold"); doc.setFontSize(fs); doc.setTextColor(80, 90, 110);
          var cx = M + 4;
          cols.forEach(function (c) { doc.text(c[0], cx, y0 + rowH * 0.68); cx += c[1]; });
          doc.setFont("DejaVu", "normal");
          pins.slice(p * perPage, (p + 1) * perPage).forEach(function (m, i) {
            var ry = y0 + rowH * (i + 1);
            if (i % 2) { doc.setFillColor(248, 250, 252); doc.rect(M, ry, LW - 2 * M, rowH, "F"); }
            var c = rgb(m.status);
            var aim = m.planned && !m.fov ? "" : Math.round(m.direction) + "° / " + Math.round(m.fov) + "°";
            var vals = [m._code, m.name, T[m.status] || m.status, m.ip, m.channels, m.model, m.serial,
                        m.switch_name ? m.switch_name + (m.switch_port ? " · " + m.switch_port : "") : "",
                        m.room, aim];
            cx = M + 4;
            vals.forEach(function (v, j) {
              if (j === 2) { doc.setFillColor(c[0], c[1], c[2]); doc.circle(cx + 2.5, ry + rowH / 2, 2.5, "F"); }
              doc.setTextColor(31, 45, 61);
              doc.text(clip(v, cols[j][1] - (j === 2 ? 12 : 6)), cx + (j === 2 ? 8 : 0), ry + rowH * 0.68);
              cx += cols[j][1];
            });
          });
        }
      }
      return doc.output("blob");
    });
  }

  window.CmapPdf = { build: build };
})();
