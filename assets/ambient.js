/* Ambiente animado de RainTrack CR: lluvia que rebota en el texto, sol, luna y nubes
   según el clima actual. Se puede apagar con el botón ✨ (se recuerda la elección).
   Vista previa: añade ?ambiente=lluvia | tormenta (con relámpagos) | sol | nublado | noche | luna-llena a la dirección. */
(function () {
  "use strict";
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enabled = true; // el ambiente animado queda siempre activo

  let state = { kind: "clear", isDay: true, intensity: 0 };
  let lastCurrent = null, localRain = null; // localRain: true/false según estaciones cercanas, null = sin dato
  let canvas, ctx, celestial, rafId = null;
  let drops = [], splashes = [], rects = [], mapRect = null, lastRectsAt = 0, dpr = 1, W = 0, H = 0;

  // ---------- clasificación del clima ----------
  function classify(code, isDay) {
    code = Number(code);
    let kind = "clear", intensity = 0;
    if (code === 0) kind = "clear";
    else if (code === 1 || code === 2) kind = "partly";
    else if (code === 3) kind = "cloudy";
    else if (code === 45 || code === 48) kind = "cloudy";
    else if (code >= 51 && code <= 57) { kind = "rain"; intensity = 1; }
    else if (code === 61 || code === 66 || code === 80) { kind = "rain"; intensity = 2; }
    else if ((code >= 63 && code <= 65) || code === 67 || code === 81 || code === 82) { kind = "rain"; intensity = 3; }
    else if (code >= 95) { kind = "rain"; intensity = 4; }
    return { kind, isDay: isDay !== false && isDay !== 0, intensity };
  }

  // ---------- Luna: fase real ----------
  function moonPhase(date) {
    const synodic = 29.530588853;
    const ref = Date.UTC(2000, 0, 6, 18, 14);
    let p = ((date.getTime() - ref) / 86400000 / synodic) % 1;
    return p < 0 ? p + 1 : p;
  }
  function moonName(p) {
    const lit = Math.round((1 - Math.cos(2 * Math.PI * p)) / 2 * 100);
    let name;
    if (p < 0.03 || p > 0.97) name = "Luna nueva";
    else if (p < 0.22) name = "Luna creciente";
    else if (p < 0.28) name = "Cuarto creciente";
    else if (p < 0.47) name = "Gibosa creciente";
    else if (p <= 0.53) name = "Luna llena";
    else if (p < 0.72) name = "Gibosa menguante";
    else if (p < 0.78) name = "Cuarto menguante";
    else name = "Luna menguante";
    return name + " · " + lit + "% iluminada";
  }
  function moonSvg(p) {
    const r = 30, c = 36;
    const k = Math.cos(2 * Math.PI * p);
    const rx = Math.abs(k) * r;
    const sweep = k > 0 ? 0 : 1;
    const lit = `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx.toFixed(2)} ${r} 0 0 ${sweep} ${c} ${c - r} Z`;
    const mirror = p > 0.5 ? `transform="translate(${c * 2} 0) scale(-1 1)"` : "";
    return `<svg viewBox="0 0 72 72" width="64" height="64" aria-hidden="true">
      <defs><radialGradient id="mglow"><stop offset="55%" stop-color="#cfe0ff" stop-opacity=".35"/><stop offset="100%" stop-color="#cfe0ff" stop-opacity="0"/></radialGradient>
      <radialGradient id="mlit" cx="40%" cy="38%"><stop offset="0%" stop-color="#fffdf2"/><stop offset="100%" stop-color="#dfe6f5"/></radialGradient></defs>
      <circle cx="${c}" cy="${c}" r="35" fill="url(#mglow)"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="#1b2438" stroke="#33415f" stroke-width=".8"/>
      <g ${mirror}><path d="${lit}" fill="url(#mlit)"/></g>
    </svg>`;
  }
  function sunSvg() {
    let rays = "";
    for (let i = 0; i < 12; i++) {
      rays += `<rect x="35" y="3" width="2" height="9" rx="1" fill="#fbbf24" opacity=".75" transform="rotate(${i * 30} 36 36)"/>`;
    }
    return `<svg viewBox="0 0 72 72" width="64" height="64" aria-hidden="true">
      <defs><radialGradient id="sglow"><stop offset="40%" stop-color="#fde68a" stop-opacity=".45"/><stop offset="100%" stop-color="#fde68a" stop-opacity="0"/></radialGradient>
      <radialGradient id="score" cx="40%" cy="38%"><stop offset="0%" stop-color="#fff7c2"/><stop offset="100%" stop-color="#f59e0b"/></radialGradient></defs>
      <circle cx="36" cy="36" r="35" fill="url(#sglow)"/>
      <g class="amb-rays">${rays}</g>
      <circle cx="36" cy="36" r="15" fill="url(#score)"/>
    </svg>`;
  }
  function cloudSvg(dark) {
    const f = dark ? "#64748b" : "#e2e8f0";
    return `<svg viewBox="0 0 120 60" width="120" height="60" aria-hidden="true"><g fill="${f}">
      <circle cx="38" cy="36" r="18"/><circle cx="62" cy="28" r="22"/><circle cx="86" cy="38" r="16"/><rect x="26" y="36" width="72" height="18" rx="9"/></g></svg>`;
  }

  // ---------- capa de cielo (sol / luna / nubes / estrellas) ----------
  function buildCelestial() {
    if (!celestial) {
      celestial = document.createElement("div");
      celestial.className = "amb-sky";
      celestial.setAttribute("aria-hidden", "true");
      document.body.appendChild(celestial);
    }
    const { kind, isDay, intensity } = state;
    let html = "";
    let title = "";
    if (isDay) {
      if (kind === "clear" || kind === "partly") html += `<div class="amb-body amb-sun">${sunSvg()}</div>`;
      title = kind === "clear" ? "Cielo despejado" : "";
    } else {
      const p = window.__ambientMoonPhase != null ? window.__ambientMoonPhase : moonPhase(new Date());
      title = moonName(p);
      html += `<div class="amb-body amb-moon ${kind === "clear" ? "" : "dim"}" title="${title}">${moonSvg(p)}</div>`;
      if (kind === "clear" || kind === "partly") {
        let stars = "";
        for (let i = 0; i < 16; i++) {
          const x = (i * 53 + 17) % 100, y = (i * 29 + 7) % 22;
          stars += `<i class="amb-star" style="left:${x}%;top:${y}vh;animation-delay:${(i % 7) * 0.6}s"></i>`;
        }
        html += `<div class="amb-stars">${stars}</div>`;
      }
    }
    if (kind === "partly") html += `<div class="amb-cloud c1">${cloudSvg(false)}</div>`;
    if (kind === "cloudy" || kind === "rain") {
      const dark = kind === "rain" || !isDay;
      html += `<div class="amb-cloud c1 ${dark ? "dark" : ""}">${cloudSvg(dark)}</div><div class="amb-cloud c2 ${dark ? "dark" : ""}">${cloudSvg(dark)}</div>`;
    }
    celestial.innerHTML = html;
    celestial.hidden = !enabled;
    placeCelestial();
  }
  function placeCelestial() {
    if (!celestial) return;
    const h1 = document.querySelector(".intro h1");
    const top = h1 ? h1.getBoundingClientRect().top + window.scrollY - 6 : 90;
    celestial.style.top = Math.max(60, top) + "px";
  }

  // ---------- lluvia que rebota en el texto ----------
  const TEXT_SEL = "h1,h2,h3,p,small,label,strong,.subtitle,.place-name,.btn,button,.version-tag,.system-status";
  function refreshRects() {
    lastRectsAt = performance.now();
    const out = [];
    const map = document.getElementById("mapShell");
    mapRect = map ? map.getBoundingClientRect() : null;
    const nodes = document.querySelectorAll(TEXT_SEL);
    for (const el of nodes) {
      if (out.length > 160) break;
      if (el.closest("#mapShell, [hidden], .map-toolbar")) continue;
      const box = el.getBoundingClientRect();
      if (box.bottom < 0 || box.top > H || box.width < 8 || box.height < 8) continue;
      if (el.matches("button,.btn")) { out.push({ l: box.left, r: box.right, t: box.top }); continue; }
      const range = document.createRange();
      range.selectNodeContents(el);
      for (const line of range.getClientRects()) {
        if (line.width < 8 || line.height < 6 || line.height > 70) continue;
        out.push({ l: line.left, r: line.right, t: line.top + line.height * 0.18 });
      }
    }
    rects = out;
  }
  function targetDrops() {
    const n = [0, 22, 42, 70, 100][state.intensity] || 0;
    return Math.round(n * Math.min(1.4, Math.max(0.6, W / 420)));
  }
  function newDrop(initial) {
    return { x: Math.random() * W, y: initial ? Math.random() * H : -20 - Math.random() * 120,
             vy: 5 + Math.random() * 4 + state.intensity, len: 8 + Math.random() * 8, a: 0.22 + Math.random() * 0.25 };
  }
  function resize() {
    if (!canvas) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    placeCelestial();
    refreshRects();
  }
  // ---------- relámpagos (solo en tormenta eléctrica) ----------
  let bolt = null, nextBoltAt = 0;
  function makeBolt() {
    const pts = [];
    let x = W * (0.15 + Math.random() * 0.7), y = 0;
    const endY = H * (0.28 + Math.random() * 0.2);
    pts.push([x, y]);
    while (y < endY) { y += 16 + Math.random() * 16; x += (Math.random() - 0.5) * 30; pts.push([x, y]); }
    const bi = 2 + Math.floor(Math.random() * Math.max(1, pts.length - 4));
    const branch = [pts[bi]];
    let bx = pts[bi][0], by = pts[bi][1];
    for (let i = 0; i < 4; i++) { by += 12 + Math.random() * 12; bx += (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 14); branch.push([bx, by]); }
    return { pts, branch, life: 42 };
  }
  function drawBolt() {
    const l = bolt.life;
    const a = l > 34 ? 1 : l > 29 ? 0.3 : l > 22 ? 1 : l / 22;
    ctx.fillStyle = "rgba(200,220,255," + (0.2 * a) + ")";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.shadowColor = "rgba(160,200,255," + a + ")"; ctx.shadowBlur = 22;
    ctx.strokeStyle = "rgba(245,250,255," + a + ")"; ctx.lineWidth = 3.2; ctx.lineJoin = "round";
    for (const path of [bolt.pts, bolt.branch]) {
      ctx.beginPath(); path.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.stroke();
      ctx.lineWidth = 1.8;
    }
    ctx.restore();
    bolt.life--;
    if (bolt.life <= 0) bolt = null;
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (document.hidden || document.body.classList.contains("map-focus")) { ctx.clearRect(0, 0, W, H); return; }
    if (now - lastRectsAt > 350) refreshRects();
    ctx.clearRect(0, 0, W, H);
    const want = targetDrops();
    while (drops.length < want) drops.push(newDrop(false));
    if (drops.length > want) drops.length = want;
    ctx.lineWidth = 1.2; ctx.lineCap = "round";
    for (const d of drops) {
      const prevY = d.y;
      d.y += d.vy; d.x -= 0.8;
      const inMap = mapRect && d.x > mapRect.left && d.x < mapRect.right && d.y > mapRect.top && d.y < mapRect.bottom;
      if (!inMap) {
        ctx.strokeStyle = "rgba(159,211,255," + d.a + ")";
        ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + 0.8 * d.len / 6, d.y - d.len); ctx.stroke();
        for (const r of rects) {
          if (prevY < r.t && d.y >= r.t && d.x >= r.l && d.x <= r.r) {
            for (let i = 0; i < 3; i++) splashes.push({ x: d.x, y: r.t, vx: (Math.random() - 0.5) * 2.4, vy: -1.2 - Math.random() * 1.8, life: 16 });
            d.y = H + 10;
            break;
          }
        }
      }
      if (d.y > H) Object.assign(d, newDrop(false));
    }
    ctx.fillStyle = "rgba(190,225,255,.7)";
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      s.x += s.vx; s.y += s.vy; s.vy += 0.16; s.life--;
      if (s.life <= 0) { splashes.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, s.life / 16);
      ctx.beginPath(); ctx.arc(s.x, s.y, 1.3, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (state.intensity >= 4) {
      if (!bolt && now > nextBoltAt) {
        bolt = makeBolt();
        nextBoltAt = now + (nextBoltAt ? 6000 + Math.random() * 9000 : 2500);
      }
      if (bolt) drawBolt();
    }
  }
  function startRain() {
    if (rafId || reduceMotion || !enabled) return;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "amb-rain";
      canvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(canvas);
      ctx = canvas.getContext("2d");
      window.addEventListener("resize", resize);
      window.addEventListener("scroll", () => { if (performance.now() - lastRectsAt > 120) refreshRects(); placeCelestialSoon(); }, { passive: true });
    }
    resize();
    drops = Array.from({ length: targetDrops() }, () => newDrop(true));
    rafId = requestAnimationFrame(frame);
  }
  let placeTimer = null;
  function placeCelestialSoon() { if (!placeTimer) placeTimer = setTimeout(() => { placeTimer = null; placeCelestial(); }, 200); }
  function stopRain() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null; drops = []; splashes = []; bolt = null; nextBoltAt = 0;
    if (ctx) ctx.clearRect(0, 0, W, H);
  }

  function refresh() {
    state = classify(lastCurrent.weather_code, lastCurrent.is_day);
    if (localRain === false && state.kind === "rain") state = { kind: "cloudy", isDay: state.isDay, intensity: 0 };
    apply();
  }

  function apply() {
    buildCelestial();
    document.body.classList.toggle("amb-on", enabled);
    if (enabled && state.kind === "rain" && state.intensity > 0) startRain(); else stopRain();
  }

  // ---------- API pública ----------
  window.RainTrackAmbient = {
    setWeather(current) {
      if (!current || window.__ambientForced) return;
      lastCurrent = current;
      refresh();
    },
    // Estaciones medidas cerca del usuario mandan sobre el modelo: sin lluvia medida, sin animación de lluvia.
    setLocalRain(value) {
      localRain = value === true || value === false ? value : null;
      if (lastCurrent && !window.__ambientForced) refresh();
    },
    flash() { if (rafId) bolt = makeBolt(); },
    preview(name) {
      const map = {
        lluvia: [63, true], tormenta: [95, true], llovizna: [53, true], sol: [0, true], nublado: [3, true],
        noche: [0, false], "luna-llena": [0, false], "noche-lluvia": [61, false]
      };
      const m = map[name]; if (!m) return;
      window.__ambientForced = true;
      window.__ambientMoonPhase = name === "luna-llena" ? 0.5 : null;
      state = classify(m[0], m[1]);
      apply();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    const param = new URLSearchParams(location.search).get("ambiente");
    if (param) window.RainTrackAmbient.preview(param);
    else apply();
    window.addEventListener("resize", placeCelestialSoon);
  });
})();
