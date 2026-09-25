const state = {
  fontes: {
    dadosfera: { gold: 0, silver: 0, bronze: 0, extras: [], atualizado_em: "", atualizado_cnes: "", atualizado_cfm: "" },
    databricks: { gold: 0, silver: 0, bronze: 0, extras: [], atualizado_em: "", atualizado_cnes: "", atualizado_cfm: "" },
    manual: { gold: 0, silver: 0, bronze: 0, extras: [], atualizado_em: "" },
  },
  extras: [],
  genero: [],
  tipoInscricao: [],
  ufs: [],
  lacunas: { sem_cpf: 0, sem_telefone: 0, sem_email: 0, sem_genero: 0, sem_nasc: 0 },
};

const $ = (id) => document.getElementById(id);

function formatMi(n) {
  const value = Math.round(Number(n) || 0);
  return value.toLocaleString("pt-BR");
}

function formatDate(raw) {
  if (raw == null || raw === "") return "—";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.toLocaleDateString("pt-BR")} ${raw.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
  }
  const text = String(raw).trim().replace(/(\.\d+)(?=(Z|[+-]\d{2}:?\d{2})?$)/, "");
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n) && n >= 1e9) {
      const ms = n >= 1e18 ? n / 1e6 : n >= 1e14 ? n / 1e3 : n >= 1e12 ? n : n * 1000;
      const epoch = new Date(ms);
      if (!Number.isNaN(epoch.getTime()) && epoch.getFullYear() >= 2000 && epoch.getFullYear() < 2100) {
        return `${epoch.toLocaleDateString("pt-BR")} ${epoch.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
      }
    }
  }
  const dayOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayOnly) return `${dayOnly[3]}/${dayOnly[2]}/${dayOnly[1]}`;
  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return text.slice(0, 16);
  const d = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  if (!Number.isNaN(d.getTime())) {
    const date = d.toLocaleDateString("pt-BR");
    if (text.includes("T") || /\d{2}:\d{2}/.test(text)) {
      return `${date} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    }
    return date;
  }
  return text;
}

function parseNumber(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim().replace(/[^0-9,.-]/g, "");
  if (!s || s === "-" || s === "." || s === ",") return 0;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function norm(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function platformOf(value) {
  const k = norm(value);
  if (k.includes("dadosfera") || k.includes("snowflake") || k === "df") return "dadosfera";
  if (k.includes("databricks") || k === "dbx" || k === "db") return "databricks";
  if (k.includes("manual") || k.includes("txt") || k.includes("csv")) return "manual";
  return null;
}

function layerOf(value) {
  const k = norm(value);
  if (k.includes("gold") || k.includes("ouro")) return "gold";
  if (k.includes("silver") || k.includes("prata")) return "silver";
  if (k.includes("bronze")) return "bronze";
  return null;
}

function setStatus(source, on) {
  document.querySelectorAll(`[data-status-for="${source}"]`).forEach((el) => {
    el.textContent = on ? "on" : "off";
    el.classList.toggle("on", on);
  });
}

function toast(message) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 5200);
}

function nowIso() {
  return new Date().toISOString();
}

function kpiValue(fonte, testers, fallback) {
  const extras = fonte.extras || [];
  const hit = extras.find((item) => testers.some((test) => test.test(item.label || "")));
  if (hit && Number(hit.value)) return Number(hit.value);
  return Number(fallback) || 0;
}

function kpiRow(fonte, prefix) {
  return [
    { label: `${prefix} · CRMs únicos ativos`, value: kpiValue(fonte, [/crm/i], fonte.gold || fonte.bronze), accent: true },
    { label: `${prefix} · CPFs únicos ativos`, value: kpiValue(fonte, [/cpf/i], 0) },
    { label: `${prefix} · Total médicos ativos`, value: kpiValue(fonte, [/total médicos|total medicos/i], fonte.gold || 0) },
    { label: `${prefix} · Total registros`, value: kpiValue(fonte, [/total registros/i], 0) },
  ];
}

function render() {
  const { fontes, ufs, genero, tipoInscricao } = state;
  const labels = {
    dadosfera: "CRMs únicos ativos",
    databricks: "CRMs únicos ativos",
    manual: "TXT Manual",
  };

  $("source-cards").innerHTML = [
    ["dadosfera", "Dadosfera · CFM", fontes.dadosfera.gold || fontes.dadosfera.bronze],
    ["databricks", "Databricks", fontes.databricks.gold || fontes.databricks.bronze],
    ["manual", "TXT Manual", fontes.manual.bronze || fontes.manual.gold],
  ].map(([key, name, value]) => `
    <article class="card ${key}">
      <p class="label">${name}</p>
      <p class="value">${formatMi(value)}</p>
      <p class="sub">${labels[key]} · ${formatDate(fontes[key].atualizado_em)}</p>
    </article>
  `).join("");

  $("stamps").innerHTML = [
    ["Dadosfera · Gold", fontes.dadosfera.atualizado_em],
    ["Dadosfera · CFM", fontes.dadosfera.atualizado_cfm],
    ["Databricks · Gold", fontes.databricks.atualizado_em],
    ["Manual", fontes.manual.atualizado_em],
  ].map(([name, date]) => `
    <div class="stamp"><b>${formatDate(date)}</b><span>Última atualização ${name}</span></div>
  `).join("");

  const rows = [
    { label: "Databricks · Gold", value: fontes.databricks.gold, tone: "green" },
    { label: "Databricks · Silver", value: fontes.databricks.silver, tone: "teal" },
    { label: "Databricks · Bronze", value: fontes.databricks.bronze, tone: "teal" },
    { label: "Dadosfera · Gold", value: fontes.dadosfera.gold, tone: "coral" },
    { label: "TXT Manual · Bronze", value: fontes.manual.bronze || fontes.manual.gold, tone: "white" },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);
  $("bars").innerHTML = rows.map((r) => `
    <div class="bar-row">
      <span>${r.label}</span>
      <i><b class="${r.tone}" style="width:${(r.value / max) * 100}%"></b></i>
      <em>${formatMi(r.value)}</em>
    </div>
  `).join("");

  const genderColors = {
    feminino: "#f54963",
    masculino: "#51e02e",
    "nao informado": "#f4f7fb",
    "não informado": "#f4f7fb",
  };
  const genderSlices = (genero || []).map((g) => ({
    key: g.label,
    color: genderColors[norm(g.label)] || "#f4f7fb",
    value: g.value,
  }));
  const genderTotal = genderSlices.reduce((s, g) => s + g.value, 0) || 1;
  if ($("donut-total")) $("donut-total").textContent = formatMi(genderTotal);
  if ($("donut-label")) $("donut-label").textContent = "ativos";
  drawPie(genderSlices, genderTotal);
  $("legend").innerHTML = genderSlices.map((g) => {
    const pct = genderTotal ? ((g.value / genderTotal) * 100).toFixed(2).replace(".", ",") : "0";
    return `<li><i style="background:${g.color}"></i><span>${g.key} · ${formatMi(g.value)} (${pct}%)</span></li>`;
  }).join("");
  const source = $("donut-source");
  if (source) {
    const day = formatDate(fontes.dadosfera.atualizado_cfm || fontes.dadosfera.atualizado_em).split(" ")[0];
    source.textContent = `Fonte: Dadosfera · CFM · ${day}.`;
  }

  const gaps = state.lacunas || {};
  if ($("gap-cards")) {
    $("gap-cards").innerHTML = [
      ["sem_cpf", "UFCRM sem CPF"],
      ["sem_telefone", "UFCRM sem telefone"],
      ["sem_email", "UFCRM sem e-mail"],
      ["sem_genero", "UFCRM sem gênero"],
      ["sem_nasc", "UFCRM sem data nasc."],
    ].map(([key, label]) => `
      <article class="gap">
        <strong>${formatMi(gaps[key])}</strong>
        <span>${label}</span>
      </article>
    `).join("");
  }

  $("kpis").innerHTML = [
    ...kpiRow(fontes.dadosfera, "Dadosfera"),
    ...kpiRow(fontes.databricks, "Databricks"),
  ].map((k) => `
    <article class="kpi ${k.accent ? "accent" : ""}">
      <strong>${formatMi(k.value)}</strong>
      <span>${k.label}</span>
    </article>
  `).join("");

  if (!ufs.length) {
    $("uf-panel").hidden = true;
  } else {
    $("uf-panel").hidden = false;
    const ufMax = Math.max(...ufs.map((u) => u.value), 1);
    $("uf-bars").innerHTML = ufs.map((u) => `
      <div class="bar-row">
        <span>${u.uf}</span>
        <i><b style="width:${(u.value / ufMax) * 100}%"></b></i>
        <em>${formatMi(u.value)}</em>
      </div>
    `).join("");
  }

  $("date-grid").innerHTML = [
    { label: "Última atualização Dadosfera · CNES", value: fontes.dadosfera.atualizado_em || fontes.dadosfera.atualizado_cnes },
    { label: "Última atualização Dadosfera · CFM", value: fontes.dadosfera.atualizado_cfm },
    { label: "Última atualização Databricks · Gold", value: fontes.databricks.atualizado_em },
    { label: "Última atualização manual", value: fontes.manual.atualizado_em },
  ].map((d) => `
    <div class="date-box">
      <b>${formatDate(d.value)}</b>
      <span>${d.label}</span>
    </div>
  `).join("");

  const breakdown = (id, rows) => {
    const el = $(id);
    if (!el) return;
    if (!rows || !rows.length) {
      el.innerHTML = "";
      return;
    }
    const max = Math.max(...rows.map((r) => r.value), 1);
    el.innerHTML = rows.map((r) => `
      <div class="bar-row">
        <span>${r.label}</span>
        <i><b style="width:${(r.value / max) * 100}%"></b></i>
        <em>${formatMi(r.value)}</em>
      </div>
    `).join("");
  };
  breakdown("tipo-bars", tipoInscricao);
}

function piePercent(value, total) {
  return ((value / total) * 100).toFixed(2).replace(".", ",");
}

function showGenderTip(event, slice, total) {
  const tip = $("pie-tip");
  if (!tip) return;
  const pct = piePercent(slice.value, total);
  tip.innerHTML = `
    <div><span>GENERO</span><b>${slice.key}</b></div>
    <div><span>MÉDICOS</span><b>${formatMi(slice.value)} (${pct}%)</b></div>
  `;
  tip.hidden = false;
  const x = Math.min(event.clientX + 14, window.innerWidth - 220);
  const y = Math.min(event.clientY + 14, window.innerHeight - 80);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideGenderTip() {
  const tip = $("pie-tip");
  if (tip) tip.hidden = true;
}

function donutSlicePath(cx, cy, r0, r1, a0, a1) {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = pt(r1, a0);
  const [x1, y1] = pt(r1, a1);
  const [x2, y2] = pt(r0, a1);
  const [x3, y3] = pt(r0, a0);
  return `M ${x0} ${y0} A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

function drawPie(slices, total) {
  const svg = $("donut");
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const cx = 60;
  const cy = 60;
  const r0 = 34;
  const r1 = 54;
  let angle = -Math.PI / 2;
  if (!slices.length || !total) {
    const empty = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    empty.setAttribute("cx", String(cx));
    empty.setAttribute("cy", String(cy));
    empty.setAttribute("r", String(r1));
    empty.setAttribute("fill", "#18222c");
    svg.appendChild(empty);
    return;
  }
  slices.forEach((s) => {
    const sweep = (s.value / total) * 2 * Math.PI;
    const next = angle + sweep;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", donutSlicePath(cx, cy, r0, r1, angle, next));
    path.setAttribute("fill", s.color);
    path.style.cursor = "pointer";
    path.addEventListener("mousemove", (event) => showGenderTip(event, s, total));
    path.addEventListener("mouseenter", (event) => {
      path.setAttribute("opacity", "0.92");
      showGenderTip(event, s, total);
    });
    path.addEventListener("mouseleave", () => {
      path.setAttribute("opacity", "1");
      hideGenderTip();
    });
    svg.appendChild(path);
    angle = next;
  });
}

function drawDonut(slices, total) {
  drawPie(slices, total);
}

function detectDelimiter(line) {
  const counts = {
    ";": (line.match(/;/g) || []).length,
    ",": (line.match(/,/g) || []).length,
    "\t": (line.match(/\t/g) || []).length,
    "|": (line.match(/\|/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function splitRow(line, delimiter) {
  return line.split(delimiter).map((cell) => cell.trim().replace(/^["']|["']$/g, ""));
}

function applyRows(rows) {
  const fontes = {
    dadosfera: { gold: 0, silver: 0, bronze: 0, atualizado_em: state.fontes.dadosfera.atualizado_em },
    databricks: { gold: 0, silver: 0, bronze: 0, atualizado_em: state.fontes.databricks.atualizado_em },
    manual: { gold: 0, silver: 0, bronze: 0, atualizado_em: state.fontes.manual.atualizado_em },
  };
  const extras = [];
  const ufs = [];
  let hit = false;

  rows.forEach((row) => {
    const map = {};
    Object.keys(row).forEach((k) => {
      map[norm(k)] = row[k];
    });
    const platform = platformOf(map.plataforma || map.platform || map.fonte || map.source || map.origem);
    const layer = layerOf(map.camada || map.layer || map.tier) || "gold";
    const value = parseNumber(map.valor || map.value || map.tb || map.qtd || map.quantidade);
    const updated = map.atualizadoem || map.atualizacao || map.updatedat || map.data;
    const uf = (map.uf || "").toUpperCase();
    const metric = map.metrica || map.kpi || map.indicador || map.label;

    if (uf && value) {
      ufs.push({ uf, value });
      hit = true;
      return;
    }

    if (metric && value && !platform) {
      extras.push({ label: String(metric), value });
      hit = true;
      return;
    }

    if (platform && value) {
      fontes[platform][layer] += value;
      if (updated) fontes[platform].atualizado_em = updated;
      hit = true;
    }
  });

  if (!hit) throw new Error("Não achei plataforma/valor no arquivo.");

  state.fontes = fontes;
  if (extras.length) state.extras = extras;
  if (ufs.length) {
    const merged = {};
    ufs.forEach((u) => {
      merged[u.uf] = (merged[u.uf] || 0) + u.value;
    });
    state.ufs = Object.entries(merged)
      .map(([uf, value]) => ({ uf, value }))
      .sort((a, b) => b.value - a.value);
  }
  render();
}

function parseManual(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r|\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) throw new Error("Arquivo vazio.");
  if (/CO_CBO|CO_PROFISSIONAL|CO_CNES|CO_UNIDADE/.test(lines[0])) {
    const delimiter = detectDelimiter(lines[0]);
    const headers = splitRow(lines[0], delimiter);
    const cboIdx = headers.findIndex((h) => /cbo/i.test(h));
    const idIdx = headers.findIndex((h) => /profissional|cpf/i.test(h));
    if (cboIdx >= 0 && idIdx >= 0) {
      const ids = new Set();
      for (let i = 1; i < lines.length; i += 1) {
        const cols = splitRow(lines[i], delimiter);
        const cbo = cols[cboIdx] || "";
        if (cbo.startsWith("225")) ids.add(cols[idIdx] || "");
      }
      state.fontes.manual.bronze = ids.size;
    } else {
      state.fontes.manual.bronze = Math.max(lines.length - 1, 0);
    }
    state.fontes.manual.atualizado_em = nowIso();
    render();
    return;
  }
  const delimiter = detectDelimiter(lines[0]);
  const first = splitRow(lines[0], delimiter);
  const headerish = first.some((cell) => /[a-zA-Z]/.test(cell));
  let rows = [];
  if (headerish) {
    const headers = first.map((h, i) => h || `col${i}`);
    rows = lines.slice(1).map((line) => {
      const cols = splitRow(line, delimiter);
      const row = {};
      headers.forEach((h, i) => {
        row[h] = cols[i] ?? "";
      });
      return row;
    });
  } else {
    rows = lines.map((line) => {
      const cols = splitRow(line, delimiter);
      if (cols.length === 1) {
        const parts = line.split(/\s+/);
        return { plataforma: parts[0], valor: parts.slice(1).join(" ") };
      }
      return {
        plataforma: cols[0],
        camada: cols[1],
        valor: cols[2] ?? cols[1],
        atualizado_em: cols[3],
      };
    });
  }
  applyRows(rows);
}

async function uploadCnesZip(file) {
  toast("Enviando ZIP e lendo os TXT por UF…");
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch("/api/cnes-zip", { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Falha ${res.status}`);
  applyFonte("manual", data, "bronze");
  setStatus("manual", true);
  const fileName = $("file-name");
  if (fileName) fileName.textContent = data.arquivo || file.name;
  render();
  toast(`TXT TOTAL registrado: ${formatMi(data.valor)} CRMs ativos.`);
}

async function readFile(file) {
  if (/\.zip$/i.test(file.name) || /zip/.test(file.type || "")) {
    await uploadCnesZip(file);
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast("Arquivo grande: compacte a pasta CNES em ZIP ou clique em Ler pasta CNES.");
    return;
  }
  const text = await file.text();
  parseManual(text);
  const fileName = $("file-name");
  if (fileName) fileName.textContent = file.name;
  setStatus("manual", true);
  render();
  toast(`Arquivo ${file.name} aplicado no painel.`);
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Falha ${res.status}`);
  return data;
}

function applyFonte(name, data, layer) {
  const campo = layer || (name === "manual" ? "bronze" : "gold");
  state.fontes[name][campo] = Number(data.valor) || 0;
  if (data.silver != null) state.fontes[name].silver = Number(data.silver) || 0;
  if (data.bronze != null) state.fontes[name].bronze = Number(data.bronze) || 0;
  if (data.atualizado_em) state.fontes[name].atualizado_em = data.atualizado_em;
  if (data.atualizado_cnes) state.fontes[name].atualizado_cnes = data.atualizado_cnes;
  if (data.atualizado_cfm) state.fontes[name].atualizado_cfm = data.atualizado_cfm;
  if (Array.isArray(data.extras) && data.extras.length) {
    state.fontes[name].extras = data.extras;
  }
  if (Array.isArray(data.ufs) && data.ufs.length && (name === "dadosfera" || !state.ufs.length)) {
    state.ufs = data.ufs;
  }
  if (Array.isArray(data.genero) && data.genero.length && (name === "dadosfera" || !state.genero.length)) {
    state.genero = data.genero;
  }
  if (Array.isArray(data.tipo_inscricao) && data.tipo_inscricao.length && (name === "dadosfera" || !state.tipoInscricao.length)) {
    state.tipoInscricao = data.tipo_inscricao;
  }
  if (data.lacunas && name === "dadosfera") state.lacunas = { ...state.lacunas, ...data.lacunas };
}

async function pullSnowflake() {
  const btn = $("btn-snowflake");
  btn.disabled = true;
  toast("Consultando Snowflake…");
  try {
    const data = await postJson("/api/snowflake", {});
    applyFonte("dadosfera", data, "gold");
    setStatus("dadosfera", true);
    render();
    toast(data.tabela ? `Dadosfera: ${data.tabela}` : "Dadosfera atualizada via Snowflake.");
  } catch (err) {
    toast(err.message || "Não consegui falar com o Snowflake.");
  } finally {
    btn.disabled = false;
  }
}

async function pullDatabricks() {
  const btn = $("btn-databricks");
  btn.disabled = true;
  toast("Consultando Databricks…");
  try {
    const data = await postJson("/api/databricks", {});
    applyFonte("databricks", data, "gold");
    setStatus("databricks", true);
    render();
    toast("Databricks atualizado via API.");
  } catch (err) {
    toast(err.message || "Não consegui falar com o Databricks.");
  } finally {
    btn.disabled = false;
  }
}

async function pullCnes() {
  const btn = $("btn-cnes");
  btn.disabled = true;
  toast("Lendo TOTAL.zip (TXT por UF)…");
  try {
    const data = await postJson("/api/cnes", {});
    applyFonte("manual", data, "bronze");
    setStatus("manual", true);
    const fileName = $("file-name");
    if (fileName) fileName.textContent = data.arquivo || "pasta CNES";
    render();
    toast(`TXT TOTAL registrado: ${formatMi(data.valor)} CRMs ativos.`);
  } catch (err) {
    toast(err.message || "Não consegui ler a pasta CNES.");
  } finally {
    btn.disabled = false;
  }
}

async function loadSnapshot() {
  const res = await fetch("assets/snapshot.json", { cache: "no-store" });
  if (!res.ok) return false;
  const data = await res.json();
  if (data.fontes) {
    ["dadosfera", "databricks", "manual"].forEach((name) => {
      if (data.fontes[name]) state.fontes[name] = { ...state.fontes[name], ...data.fontes[name] };
    });
  }
  if (Array.isArray(data.genero)) state.genero = data.genero;
  if (Array.isArray(data.tipoInscricao)) state.tipoInscricao = data.tipoInscricao;
  if (Array.isArray(data.ufs)) state.ufs = data.ufs;
  if (data.lacunas) state.lacunas = { ...state.lacunas, ...data.lacunas };
  render();
  return true;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/status", { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.cnes && data.cnes.last && data.cnes.last.valor) {
      applyFonte("manual", data.cnes.last, "bronze");
      setStatus("manual", true);
      render();
    }
    setStatus("dadosfera", Boolean(data.snowflake?.ok));
    setStatus("databricks", Boolean(data.databricks?.ok));
    return true;
  } catch {
    return false;
  }
}

function isDrawerLayout() {
  return window.matchMedia("(max-width: 860px), (hover: none) and (pointer: coarse)").matches;
}

function bindMenu() {
  const keys = $("keys");
  const toggle = $("menu-toggle");
  const backdrop = $("keys-backdrop");
  if (!keys || !toggle || !backdrop) return;
  const close = () => {
    keys.classList.remove("open");
    backdrop.hidden = true;
    document.body.classList.remove("menu-open");
  };
  const open = () => {
    keys.classList.add("open");
    backdrop.hidden = false;
    document.body.classList.add("menu-open");
  };
  toggle.addEventListener("click", () => {
    if (keys.classList.contains("open")) close();
    else open();
  });
  backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  keys.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (isDrawerLayout()) close();
    });
  });
  window.addEventListener("resize", () => {
    if (!isDrawerLayout()) close();
  });
}

function bindUi() {
  $("btn-snowflake").addEventListener("click", pullSnowflake);
  $("btn-databricks").addEventListener("click", pullDatabricks);
  $("btn-cnes").addEventListener("click", pullCnes);
}

async function bind() {
  try {
    if (/\.netlify\.app$/i.test(location.hostname) || /netlify/.test(location.hostname)) {
      document.body.classList.add("hosted");
    }
    render();
    await loadSnapshot();
    bindMenu();
    bindUi();
    const live = await loadStatus();
    if (live) {
      pullDatabricks();
      pullSnowflake();
    }
  } catch (err) {
    toast(err.message || String(err));
  }
}

bind();
