const UF_CENTRO = {
  AC: [-8.77, -70.55], AL: [-9.57, -36.55], AM: [-3.47, -62.21], AP: [1.41, -51.77],
  BA: [-12.97, -41.57], CE: [-5.20, -39.53], DF: [-15.78, -47.93], ES: [-19.19, -40.34],
  GO: [-15.98, -49.86], MA: [-5.42, -45.44], MG: [-18.10, -44.38], MS: [-20.51, -54.54],
  MT: [-12.64, -55.42], PA: [-3.79, -52.48], PB: [-7.28, -36.72], PE: [-8.38, -37.86],
  PI: [-6.60, -42.28], PR: [-24.89, -51.55], RJ: [-22.25, -42.66], RN: [-5.81, -36.59],
  RO: [-10.83, -63.34], RR: [1.99, -61.33], RS: [-30.17, -53.50], SC: [-27.45, -50.95],
  SE: [-10.57, -37.45], SP: [-22.19, -48.79], TO: [-9.46, -48.26],
};

const biState = { data: null, munis: [], map: null, layer: null, novos: [], modo: "novos", cidade: null, mes: null };

const MES_NOMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MES_CURTO = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

function mesIndex(mes) {
  const mo = Number(String(mes || "").split("-")[1]);
  return mo >= 1 && mo <= 12 ? mo - 1 : -1;
}

function mesValue() {
  if (biState.mes) return biState.mes;
  const lista = (biState.data && biState.data.mensal) || [];
  if (lista.length) return lista[lista.length - 1].mes;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function mesCurto(mes) {
  const idx = mesIndex(mes);
  return idx < 0 ? "" : MES_CURTO[idx];
}

function mesLabel(mes) {
  const idx = mesIndex(mes);
  return idx < 0 ? "" : MES_NOMES[idx];
}

function biFmt(n) {
  return Math.round(Number(n) || 0).toLocaleString("pt-BR");
}

function heatColor(t) {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.33) return `rgb(29, ${Math.round(78 + x * 300)}, 216)`;
  if (x < 0.66) return `rgb(${Math.round(29 + (x - 0.33) * 600)}, 224, ${Math.round(108 - (x - 0.33) * 180)})`;
  return `rgb(239, ${Math.round(196 - (x - 0.66) * 280)}, 68)`;
}

function fillBars(id, rows, labelKey = "label") {
  const el = document.getElementById(id);
  if (!el) return;
  const max = Math.max(...rows.map((r) => r.value), 1);
  el.innerHTML = rows.map((r) => `
    <div class="bar-row">
      <span>${r[labelKey] || r.uf || r.label}</span>
      <i><b style="width:${(r.value / max) * 100}%"></b></i>
      <em>${biFmt(r.value)}</em>
    </div>
  `).join("");
}

function drawBiPie(slices, total) {
  const svg = document.getElementById("bi-donut");
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const cx = 60, cy = 60, r0 = 28, r1 = 52;
  let angle = -Math.PI / 2;
  slices.forEach((s) => {
    const sweep = (s.value / total) * 2 * Math.PI;
    const next = angle + sweep;
    const large = next - angle > Math.PI ? 1 : 0;
    const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(r1, angle);
    const [x1, y1] = p(r1, next);
    const [x2, y2] = p(r0, next);
    const [x3, y3] = p(r0, angle);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x0} ${y0} A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`);
    path.setAttribute("fill", s.color);
    svg.appendChild(path);
    angle = next;
  });
}

function renderBi(data) {
  biState.data = data;
  document.getElementById("bi-crm").textContent = biFmt(data.crm);
  document.getElementById("bi-medicos").textContent = biFmt(data.medicos);
  document.getElementById("bi-esp").textContent = biFmt(data.especialidades);
  const upd = data.atualizado_em ? new Date(data.atualizado_em) : null;
  document.getElementById("bi-updated").textContent = upd && !Number.isNaN(upd.getTime())
    ? `Atualizado em: ${upd.toLocaleString("pt-BR")}`
    : `Atualizado em: ${data.atualizado_em || "—"}`;

  const genderColors = { feminino: "#ff5b7a", masculino: "#22e06c" };
  const slices = (data.genero || []).map((g) => ({
    key: g.label,
    color: genderColors[String(g.label).toLowerCase()] || "#f0c14a",
    value: g.value,
  }));
  const total = slices.reduce((s, g) => s + g.value, 0) || 1;
  document.getElementById("bi-donut-total").textContent = biFmt(total);
  drawBiPie(slices, total);
  document.getElementById("bi-legend").innerHTML = slices.map((g) => {
    const pct = ((g.value / total) * 100).toFixed(1).replace(".", ",");
    return `<li><i style="background:${g.color}"></i>${g.key} · ${biFmt(g.value)} (${pct}%)</li>`;
  }).join("");

  if (!biState.mes && (data.mensal || []).length) biState.mes = data.mensal[data.mensal.length - 1].mes;
  const escolhido = mesValue();
  const maxM = Math.max(...(data.mensal || []).map((m) => m.value), 1);
  document.getElementById("bi-mensal").innerHTML = (data.mensal || []).map((m) => `
    <div class="month-col${m.mes === escolhido ? " on" : ""}" data-mes="${m.mes}" title="${mesLabel(m.mes)} · ${biFmt(m.value)}">
      <i style="height:${Math.max(4, (m.value / maxM) * 100)}%"></i>
      <span>${mesCurto(m.mes)}</span>
    </div>
  `).join("");
  atualizarTitulo();

  fillBars("bi-regiao", data.regioes || []);
  fillBars("bi-faixa", data.faixa || []);
  fillBars("bi-esp-ds", data.especialidade_ds || []);
  fillBars("bi-esp-cfm", data.especialidade_cfm || []);
  fillBars("bi-ufs", (data.ufs || []).slice(0, 16), "uf");

  const sel = document.getElementById("map-uf");
  const current = sel.value;
  const ufs = ["BR", ...[...new Set((data.cidades || []).map((c) => c.uf).filter(Boolean))].sort()];
  sel.innerHTML = ufs.map((u) => `<option value="${u}">${u === "BR" ? "Brasil" : u}</option>`).join("");
  sel.value = ufs.includes(current) ? current : "BR";
  drawMap(sel.value);
}

function padIbge(code) {
  return String(code || "").replace(/\D/g, "").padStart(7, "0");
}

function ensureMap() {
  if (biState.map || typeof L === "undefined") return biState.map;
  biState.map = L.map("map-br", { zoomControl: true, attributionControl: true }).setView([-14.2, -54], 4);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 12,
    attribution: "Tiles © Esri",
  }).addTo(biState.map);
  return biState.map;
}

function drawMap(uf) {
  const map = ensureMap();
  if (!map || !biState.data) return;
  if (biState.layer) {
    map.removeLayer(biState.layer);
    biState.layer = null;
  }
  const group = L.layerGroup();
  const bounds = [];
  const byIbge = new Map();
  const byName = new Map();
  biState.munis.forEach((m) => {
    const code = String(m.i || "");
    byIbge.set(code, m);
    if (code.length >= 6) byIbge.set(code.slice(0, 6), m);
    byName.set(`${m.u}|${String(m.n).toLowerCase()}`, m);
  });
  const brasil = !uf || uf === "BR";
  const cidades = (biState.data.cidades || []).filter((c) => brasil || c.uf === uf);
  const max = Math.max(...cidades.map((c) => c.value), 1);

  cidades.forEach((c) => {
    const ibge7 = padIbge(c.ibge);
    const ibge6 = String(c.ibge || "").replace(/\D/g, "");
    const geo = byIbge.get(ibge7)
      || byIbge.get(ibge6)
      || byName.get(`${c.uf}|${String(c.municipio).toLowerCase()}`);
    if (!geo) return;
    const ll = [geo.y, geo.x];
    bounds.push(ll);
    const t = c.value / max;
    L.circleMarker(ll, {
      radius: 5 + Math.sqrt(t) * 16,
      color: heatColor(t),
      fillColor: heatColor(t),
      fillOpacity: 0.75,
      weight: 1,
    }).bindTooltip(`${c.municipio}: ${biFmt(c.value)}`).on("click", () => {
      abrirCidade(c);
    }).addTo(group);
  });

  group.addTo(map);
  biState.layer = group;
  if (brasil) map.setView([-14.2, -54], 4);
  else if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 8 });
  else if (UF_CENTRO[uf]) map.setView(UF_CENTRO[uf], 6);
  setTimeout(() => map.invalidateSize(), 80);
}

async function loadBi() {
  try {
    const snap = await fetch("assets/snapshot-bi.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (snap) renderBi(snap);
    const res = await fetch("/api/dadosfera-bi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Falha no painel Dadosfera");
    renderBi(data);
  } catch (err) {
    const toast = document.getElementById("toast");
    if (toast) {
      toast.hidden = false;
      toast.textContent = err.message || "Não carreguei o painel Dadosfera.";
    }
  }
}

function csvEscape(value) {
  const text = String(value || "");
  if (/[;"\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function atualizarTitulo() {
  const mes = mesLabel(mesValue()) || "mês";
  const elMes = document.getElementById("mes-escolhido");
  if (elMes) elMes.textContent = mes;
  document.getElementById("lista-titulo").textContent = biState.modo === "novos"
    ? `Médicos novos · ${mes}`
    : `Todos os médicos · ${mes}`;
  const cidade = biState.cidade
    ? `${biState.cidade.municipio} · ${biState.cidade.uf}`
    : "Brasil";
  document.getElementById("lista-local").textContent = `${cidade} · ${mes}`;
  document.querySelectorAll(".month-col").forEach((col) => {
    col.classList.toggle("on", col.dataset.mes === mesValue());
  });
}

function setModo(modo) {
  biState.modo = modo === "todos" ? "todos" : "novos";
  document.getElementById("modo-todos").classList.toggle("on", biState.modo === "todos");
  document.getElementById("modo-novos").classList.toggle("on", biState.modo === "novos");
  atualizarTitulo();
  if (biState.cidade) buscarLista();
}

function abrirCidade(cidade) {
  biState.cidade = cidade;
  atualizarTitulo();
  document.getElementById("novos-body").scrollIntoView({ behavior: "smooth", block: "start" });
  buscarLista();
}

function escolherMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes)) return;
  biState.mes = mes;
  atualizarTitulo();
  document.getElementById("novos-body").scrollIntoView({ behavior: "smooth", block: "start" });
  buscarLista();
}

function downloadNovosCsv() {
  if (!biState.novos.length) return;
  const header = "UF_CRM;NOME;CIDADE;UF;TELEFONE;EMAIL";
  const body = biState.novos.map((r) => [r.uf_crm, r.nome, r.cidade, r.uf, r.telefone, r.email].map(csvEscape).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const cidade = (biState.cidade && biState.cidade.municipio) || "lista";
  a.download = `medicos-${biState.modo}-${cidade}-${mesCurto(mesValue())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function buscarLista() {
  const mes = mesValue();
  const bodyEl = document.getElementById("novos-body");
  const payload = { modo: biState.modo, mes };
  if (biState.cidade) {
    payload.uf = biState.cidade.uf;
    payload.municipio = biState.cidade.municipio;
    payload.ibge = biState.cidade.ibge;
  }
  atualizarTitulo();
  if (biState.modo === "todos" && !biState.cidade) {
    bodyEl.innerHTML = "<tr><td colspan='6'>Clique numa cidade no mapa para ver todos os médicos dali naquele mês.</td></tr>";
    document.getElementById("novos-count").textContent = "0 registros";
    return;
  }
  bodyEl.innerHTML = "<tr><td colspan='6'>Consultando Snowflake…</td></tr>";
  try {
    const res = await fetch("/api/medicos-novos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Falha ao buscar médicos");
    biState.novos = data.linhas || [];
    document.getElementById("novos-count").textContent = `${biFmt(data.total)} registros`;
    if (data.aviso && !biState.novos.length) {
      bodyEl.innerHTML = `<tr><td colspan="6">${data.aviso}</td></tr>`;
      return;
    }
    if (!biState.novos.length) {
      bodyEl.innerHTML = "<tr><td colspan='6'>Nenhum médico encontrado nesse mês.</td></tr>";
      return;
    }
    bodyEl.innerHTML = biState.novos.map((r) => `
      <tr>
        <td>${r.uf_crm}</td>
        <td>${r.nome}</td>
        <td>${r.cidade || "—"}</td>
        <td>${r.uf || "—"}</td>
        <td>${r.telefone || "—"}</td>
        <td>${r.email || "—"}</td>
      </tr>
    `).join("");
  } catch (err) {
    bodyEl.innerHTML = `<tr><td colspan="6">${err.message}</td></tr>`;
  }
}

function switchTab(tab) {
  const comparativo = document.getElementById("view-comparativo");
  const dadosfera = document.getElementById("view-dadosfera");
  comparativo.hidden = tab !== "comparativo";
  dadosfera.hidden = tab !== "dadosfera";
  document.querySelectorAll("[data-tab]").forEach((btn) => btn.classList.toggle("on", btn.dataset.tab === tab));
  if (tab === "dadosfera") {
    location.hash = "dadosfera";
    if (!biState.data) loadBi();
    setTimeout(() => biState.map && biState.map.invalidateSize(), 120);
  } else {
    if (location.hash.replace("#", "") === "dadosfera") location.hash = "";
  }
}

async function initBi() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  if (location.hash.replace("#", "") === "dadosfera") switchTab("dadosfera");
  document.getElementById("map-uf").addEventListener("change", (e) => drawMap(e.target.value));
  document.getElementById("map-reset").addEventListener("click", () => {
    document.getElementById("map-uf").value = "BR";
    drawMap("BR");
  });
  document.getElementById("btn-novos").addEventListener("click", buscarLista);
  document.getElementById("btn-csv").addEventListener("click", downloadNovosCsv);
  document.getElementById("modo-todos").addEventListener("click", () => setModo("todos"));
  document.getElementById("modo-novos").addEventListener("click", () => setModo("novos"));
  document.getElementById("bi-mensal").addEventListener("click", (event) => {
    const col = event.target.closest(".month-col");
    if (col && col.dataset.mes) escolherMes(col.dataset.mes);
  });
  biState.modo = "novos";
  atualizarTitulo();
  try {
    biState.munis = await fetch("assets/municipios.json").then((r) => r.json());
  } catch {
    biState.munis = [];
  }
}

initBi();
