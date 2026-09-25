const UF_CENTRO = {
  AC: [-8.77, -70.55], AL: [-9.57, -36.55], AM: [-3.47, -62.21], AP: [1.41, -51.77],
  BA: [-12.97, -41.57], CE: [-5.20, -39.53], DF: [-15.78, -47.93], ES: [-19.19, -40.34],
  GO: [-15.98, -49.86], MA: [-5.42, -45.44], MG: [-18.10, -44.38], MS: [-20.51, -54.54],
  MT: [-12.64, -55.42], PA: [-3.79, -52.48], PB: [-7.28, -36.72], PE: [-8.38, -37.86],
  PI: [-6.60, -42.28], PR: [-24.89, -51.55], RJ: [-22.25, -42.66], RN: [-5.81, -36.59],
  RO: [-10.83, -63.34], RR: [1.99, -61.33], RS: [-30.17, -53.50], SC: [-27.45, -50.95],
  SE: [-10.57, -37.45], SP: [-22.19, -48.79], TO: [-9.46, -48.26],
};

const biState = {
  data: null,
  munis: [],
  map: null,
  layer: null,
  novos: [],
  modo: "novos",
  cidade: null,
  mes: null,
  cidadesNovos: {},
  busca: "",
  totalCompleto: 0,
};
let mapaReq = 0;

const MES_NOMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MES_EIXO = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

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

function mesEixo(mes) {
  const idx = mesIndex(mes);
  return idx < 0 ? "" : MES_EIXO[idx];
}

function mesAno(mes) {
  return String(mes || "").slice(0, 4);
}

function mesValido(mes) {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ""))) return false;
  const [ano, mo] = String(mes).split("-").map(Number);
  if (ano < 2000 || ano > 2100 || mo < 1 || mo > 12) return false;
  const agora = new Date();
  return ano * 100 + mo <= agora.getFullYear() * 100 + (agora.getMonth() + 1);
}

function mesCurto(mes) {
  return mesEixo(mes).toLowerCase();
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
  const mix = (a, b, u) => Math.round(a + (b - a) * u);
  if (x < 0.5) {
    const u = x / 0.5;
    return `rgb(${mix(29, 81, u)}, ${mix(51, 224, u)}, ${mix(58, 46, u)})`;
  }
  const u = (x - 0.5) / 0.5;
  return `rgb(${mix(81, 245, u)}, ${mix(224, 73, u)}, ${mix(46, 99, u)})`;
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
  const cx = 60, cy = 60, r0 = 34, r1 = 54;
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
  const updRaw = data.atualizado_em;
  let upd = null;
  if (updRaw != null && /^\d+(\.\d+)?$/.test(String(updRaw).trim()) && Number(updRaw) >= 1e9) {
    const n = Number(updRaw);
    const ms = n >= 1e18 ? n / 1e6 : n >= 1e14 ? n / 1e3 : n >= 1e12 ? n : n * 1000;
    upd = new Date(ms);
  } else if (updRaw) {
    upd = new Date(String(updRaw).includes("T") ? updRaw : String(updRaw).replace(" ", "T"));
  }
  document.getElementById("bi-updated").textContent = upd && !Number.isNaN(upd.getTime())
    ? `Atualizado em: ${upd.toLocaleString("pt-BR")}`
    : `Atualizado em: ${data.atualizado_em || "—"}`;

  const genderColors = { feminino: "#f54963", masculino: "#51e02e", "não informado": "#f4f7fb", "nao informado": "#f4f7fb" };
  const slices = (data.genero || []).map((g) => ({
    key: g.label,
    color: genderColors[String(g.label).toLowerCase()] || "#f4f7fb",
    value: g.value,
  }));
  const total = slices.reduce((s, g) => s + g.value, 0) || 1;
  document.getElementById("bi-donut-total").textContent = biFmt(total);
  drawBiPie(slices, total);
  document.getElementById("bi-legend").innerHTML = slices.map((g) => {
    const pct = ((g.value / total) * 100).toFixed(2).replace(".", ",");
    return `<li><i style="background:${g.color}"></i><span>${g.key} · ${biFmt(g.value)} (${pct}%)</span></li>`;
  }).join("");

  const mensalOk = (data.mensal || []).filter((m) => mesValido(m.mes));
  if (!biState.mes || !mesValido(biState.mes)) biState.mes = mensalOk.length ? mensalOk[mensalOk.length - 1].mes : null;
  const escolhido = mesValue();
  const rows = [...mensalOk].sort((a, b) => String(b.mes).localeCompare(String(a.mes)));
  const maxM = Math.max(...rows.map((m) => m.value), 1);
  const grupos = [];
  rows.forEach((m) => {
    const year = mesAno(m.mes);
    if (!grupos.length || grupos[grupos.length - 1].year !== year) grupos.push({ year, items: [] });
    grupos[grupos.length - 1].items.push(m);
  });
  document.getElementById("bi-mensal").innerHTML = grupos.map((grupo) => `
    <div class="month-year">
      <div class="month-year-bars">
        ${grupo.items.map((m) => `
          <div class="month-col${m.mes === escolhido ? " on" : ""}" data-mes="${m.mes}" title="${mesLabel(m.mes)} ${grupo.year} · ${biFmt(m.value)}">
            <span class="month-track"><i style="height:${Math.max(4, (m.value / maxM) * 100)}%"><em>${biFmt(m.value)}</em></i></span>
            <span class="month-name">${mesEixo(m.mes)}</span>
          </div>
        `).join("")}
      </div>
      <strong>${grupo.year}</strong>
    </div>
  `).join("");
  atualizarTitulo();

  fillBars("bi-regiao", data.regioes || []);
  fillBars("bi-faixa", data.faixa || []);
  fillBars("bi-esp-ds", data.especialidade_ds || []);
  fillBars("bi-esp-cfm", data.especialidade_cfm || []);
  fillBars("bi-ufs", (data.ufs || []).slice(0, 16), "uf");
  renderVisao(data);

  const sel = document.getElementById("map-uf");
  const current = sel.value;
  const ufs = ["BR", ...[...new Set((data.cidades || []).map((c) => c.uf).filter(Boolean))].sort()];
  sel.innerHTML = ufs.map((u) => `<option value="${u}">${u === "BR" ? "Brasil" : u}</option>`).join("");
  sel.value = ufs.includes(current) ? current : "BR";
  atualizarMapa();
}

function foldText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function lookupGeo(cidade, byIbge, byName) {
  const digits = String(cidade.ibge || "").replace(/\D/g, "");
  const ibge7 = digits.padStart(7, "0");
  const geo = byIbge.get(digits)
    || byIbge.get(ibge7)
    || (digits.length >= 6 ? byIbge.get(digits.slice(0, 6)) : null)
    || byName.get(`${String(cidade.uf || "").toUpperCase()}|${foldText(cidade.municipio)}`);
  if (geo) return { lat: geo.y, lng: geo.x };
  const centro = UF_CENTRO[String(cidade.uf || "").toUpperCase()];
  if (centro) return { lat: centro[0], lng: centro[1], fallback: true };
  return null;
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

function mapaCidades() {
  if (biState.modo === "novos") return biState.cidadesNovos[mesValue()] || [];
  return (biState.data && biState.data.cidades) || [];
}

function atualizarHint() {
  const hint = document.getElementById("map-hint");
  if (!hint) return;
  const mes = mesLabel(mesValue()) || "mês";
  if (biState.modo !== "novos") {
    hint.textContent = "Clique na cidade para ver todos os médicos dali.";
    return;
  }
  const cidades = biState.cidadesNovos[mesValue()] || [];
  const medicos = cidades.reduce((s, c) => s + (Number(c.value) || 0), 0);
  hint.textContent = medicos
    ? `${biFmt(medicos)} médicos novos de ${mes} em ${biFmt(cidades.length)} localidades. Clique na bolinha para ver a lista.`
    : `Clique no mês na evolução mensal e depois na cidade para ver os médicos novos de ${mes}.`;
}

async function atualizarMapa() {
  const uf = document.getElementById("map-uf").value;
  atualizarHint();
  const req = ++mapaReq;
  if (biState.modo === "novos") {
    const mes = mesValue();
    if (!biState.cidadesNovos[mes] && biState.layer && biState.map) {
      biState.map.removeLayer(biState.layer);
      biState.layer = null;
    }
    if (!biState.cidadesNovos[mes]) {
      try {
        const res = await fetch("/api/cidades-novos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mes }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Falha ao filtrar cidades de médicos novos");
        if (req !== mapaReq) return;
        biState.cidadesNovos[mes] = data.cidades || [];
        atualizarHint();
      } catch (err) {
        if (req !== mapaReq) return;
        const toast = document.getElementById("toast");
        if (toast) {
          toast.hidden = false;
          toast.textContent = err.message || "Não carreguei as cidades de médicos novos.";
        }
      }
    }
  }
  if (req !== mapaReq) return;
  drawMap(document.getElementById("map-uf").value || uf);
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
    byName.set(`${String(m.u || "").toUpperCase()}|${foldText(m.n)}`, m);
  });
  const brasil = !uf || uf === "BR";
  const cidades = mapaCidades().filter((c) => brasil || c.uf === uf);
  const max = Math.max(...cidades.map((c) => c.value), 1);
  const rotulo = biState.modo === "novos" ? "médicos novos" : "médicos";

  cidades.forEach((c) => {
    const geo = lookupGeo(c, byIbge, byName);
    if (!geo) return;
    const ll = [geo.lat, geo.lng];
    bounds.push(ll);
    const t = c.value / max;
    L.circleMarker(ll, {
      radius: 5 + Math.sqrt(t) * 16,
      color: heatColor(t),
      fillColor: heatColor(t),
      fillOpacity: 0.75,
      weight: 1,
    }).bindTooltip(`${c.municipio}${c.uf ? " · " + c.uf : ""}: ${biFmt(c.value)} ${rotulo}`).on("click", () => {
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
    : "Todos os médicos";
  const cidade = biState.cidade
    ? `${biState.cidade.municipio} · ${biState.cidade.uf}`
    : "Brasil";
  const mapaN = biState.cidade && Number(biState.cidade.value);
  const cadastroN = biState.totalCompleto;
  let local = `${cidade} · ${mes}`;
  if (biState.modo === "todos" && biState.cidade) {
    local = cadastroN
      ? `${cidade}: ${biFmt(cadastroN)} médicos ativos no cadastro`
      : `${cidade}: médicos ativos no cadastro`;
    if (mapaN && (!cadastroN || Math.abs(mapaN - cadastroN) > 5)) {
      local += ` · ${biFmt(mapaN)} profissionais no mapa (CNES)`;
    }
  } else if (biState.cidade) {
    local = `${cidade} · ${mes}`;
  }
  document.getElementById("lista-local").textContent = local;
  document.querySelectorAll(".month-col").forEach((col) => {
    col.classList.toggle("on", col.dataset.mes === mesValue());
  });
  const elMonMes = document.getElementById("monitor-mes");
  const elMonTot = document.getElementById("monitor-total");
  if (elMonMes) elMonMes.textContent = mes;
  if (elMonTot) {
    const item = ((biState.data && biState.data.mensal) || []).find((m) => m.mes === mesValue());
    elMonTot.textContent = item ? `${biFmt(item.value)} médicos novos em ${mes}` : `Relatório completo de ${mes}`;
  }
}

function setModo(modo) {
  biState.modo = modo === "todos" ? "todos" : "novos";
  document.getElementById("modo-todos").classList.toggle("on", biState.modo === "todos");
  document.getElementById("modo-novos").classList.toggle("on", biState.modo === "novos");
  atualizarTitulo();
  atualizarMapa();
  buscarLista();
}

function abrirCidade(cidade) {
  biState.cidade = cidade;
  biState.busca = "";
  const buscaEl = document.getElementById("lista-busca");
  if (buscaEl) buscaEl.value = "";
  atualizarTitulo();
  document.getElementById("novos-body").scrollIntoView({ behavior: "smooth", block: "start" });
  buscarLista();
}

function escolherMes(mes) {
  if (!/^\d{4}-\d{2}$/.test(mes)) return;
  biState.mes = mes;
  atualizarTitulo();
  atualizarMapa();
  document.getElementById("novos-body").scrollIntoView({ behavior: "smooth", block: "start" });
  buscarLista();
}

function textoLinha(r) {
  return [r.uf_crm, r.nome, r.especialidade, r.cidade, r.uf, r.telefone, r.email].join(" ").toLowerCase();
}

function listaFiltrada() {
  const q = (biState.busca || "").trim().toLowerCase();
  if (!q) return biState.novos;
  return biState.novos.filter((r) => textoLinha(r).includes(q));
}

function renderTabela() {
  const bodyEl = document.getElementById("novos-body");
  const rows = listaFiltrada();
  const total = biState.totalCompleto || biState.novos.length;
  const q = (biState.busca || "").trim();
  if (q) {
    document.getElementById("novos-count").textContent = `${biFmt(rows.length)} de ${biFmt(total)} registros`;
  } else if (total > biState.novos.length) {
    document.getElementById("novos-count").textContent = `${biFmt(biState.novos.length)} de ${biFmt(total)} registros`;
  } else {
    document.getElementById("novos-count").textContent = `${biFmt(total)} registros`;
  }
  if (!biState.novos.length) {
    bodyEl.innerHTML = "<tr><td colspan='10'>Nenhum médico encontrado.</td></tr>";
    return;
  }
  if (!rows.length) {
    bodyEl.innerHTML = "<tr><td colspan='10'>Nenhum resultado para essa busca. Aperte Buscar para consultar no Snowflake.</td></tr>";
    return;
  }
  bodyEl.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.uf_crm}</td>
      <td>${r.nome}</td>
      <td>${r.especialidade || "—"}</td>
      <td>${r.cidade || "—"}</td>
      <td>${r.uf || "—"}</td>
      <td>${r.horas_total ? biFmt(r.horas_total) : "—"}</td>
      <td>${r.estabelecimento || "—"}</td>
      <td>${r.setor || "—"}</td>
      <td>${r.telefone || "—"}</td>
      <td>${r.email || "—"}</td>
    </tr>
  `).join("");
}

function csvHeader() {
  return [
    "UF_CRM", "NOME", "ESPECIALIDADE", "CIDADE", "UF", "DATA_INSCRICAO",
    "TELEFONE", "EMAIL", "HORAS_CNES", "HORAS_AMB", "HORAS_HOSP", "VINCULOS_CNES",
    "ESTABELECIMENTO", "CNES", "SETOR", "NATUREZA_JURIDICA", "GESTAO", "SUS",
  ].join(";");
}

function csvLinha(r) {
  return [
    r.uf_crm, r.nome, r.especialidade, r.cidade, r.uf, r.data,
    r.telefone, r.email, r.horas_total, r.horas_amb, r.horas_hosp, r.vinculos,
    r.estabelecimento, r.cnes, r.setor, r.natureza, r.gestao, r.sus,
  ].map((value, idx) => {
    if (idx === 6 || idx === 13) return `"${String(value || "").replace(/"/g, '""')}"`;
    return csvEscape(value);
  }).join(";");
}

function baixarCsvArquivo(nome, rows) {
  const blob = new Blob(["\ufeff" + csvHeader() + "\n" + rows.map(csvLinha).join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

function payloadLista(extra = {}) {
  const payload = {
    modo: extra.modo || biState.modo,
    mes: mesValue(),
    q: extra.q != null ? extra.q : (biState.busca || ""),
    pagina: extra.pagina || 0,
    tamanho: extra.tamanho || 500,
  };
  if (extra.exportar_mes) payload.exportar_mes = true;
  if (!extra.exportar_mes && extra.ignorar_cidade !== true && biState.cidade) {
    payload.uf = biState.cidade.uf;
    payload.municipio = biState.cidade.municipio;
    payload.ibge = biState.cidade.ibge;
    payload.sem_cidade = Boolean(biState.cidade.sem_cidade);
  }
  return payload;
}

async function fetchTodasLinhas(extra = {}) {
  const linhas = [];
  let pagina = 0;
  const tamanho = 2000;
  let total = Infinity;
  while (linhas.length < total) {
    const res = await fetch("/api/medicos-novos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadLista({ ...extra, pagina, tamanho, q: extra.q != null ? extra.q : "" })),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Falha ao exportar médicos");
    const batch = data.linhas || [];
    total = Number(data.total_completo || linhas.length + batch.length);
    linhas.push(...batch);
    if (!batch.length || batch.length < tamanho) break;
    pagina += 1;
    if (pagina > 40) break;
  }
  return linhas;
}

async function downloadNovosCsv() {
  const btn = document.getElementById("btn-csv");
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Baixando…";
    }
    const rows = await fetchTodasLinhas({ q: biState.busca || "" });
    if (!rows.length) return;
    const cidade = (biState.cidade && biState.cidade.municipio) || "lista";
    baixarCsvArquivo(`medicos-${biState.modo}-${cidade}-${mesCurto(mesValue())}.csv`, rows);
  } catch (err) {
    const toast = document.getElementById("toast");
    if (toast) {
      toast.hidden = false;
      toast.textContent = err.message || "Não baixei o CSV.";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Baixar CSV da lista";
    }
  }
}

async function downloadMesCsv() {
  const btn = document.getElementById("btn-csv-mes");
  try {
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Baixando mês…";
    }
    const rows = await fetchTodasLinhas({ modo: "novos", exportar_mes: true, ignorar_cidade: true, q: "" });
    if (!rows.length) throw new Error("Nenhum médico novo nesse mês.");
    baixarCsvArquivo(`medicos-novos-${mesValue()}.csv`, rows);
  } catch (err) {
    const toast = document.getElementById("toast");
    if (toast) {
      toast.hidden = false;
      toast.textContent = err.message || "Não baixei o relatório do mês.";
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Baixar relatório do mês";
    }
  }
}

async function buscarLista() {
  const bodyEl = document.getElementById("novos-body");
  const buscaEl = document.getElementById("lista-busca");
  if (buscaEl) biState.busca = buscaEl.value || "";
  atualizarTitulo();
  if (biState.modo === "todos" && !biState.cidade) {
    bodyEl.innerHTML = "<tr><td colspan='10'>Clique numa cidade no mapa para ver todos os médicos dali.</td></tr>";
    document.getElementById("novos-count").textContent = "0 registros";
    return;
  }
  bodyEl.innerHTML = "<tr><td colspan='10'>Consultando Snowflake…</td></tr>";
  try {
    const res = await fetch("/api/medicos-novos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadLista({ pagina: 0, tamanho: 500 })),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Falha ao buscar médicos");
    biState.novos = data.linhas || [];
    biState.totalCompleto = Number(data.total_completo || data.total || biState.novos.length);
    atualizarTitulo();
    if (data.aviso && !biState.novos.length) {
      document.getElementById("novos-count").textContent = "0 registros";
      bodyEl.innerHTML = `<tr><td colspan="10">${data.aviso}</td></tr>`;
      return;
    }
    renderTabela();
  } catch (err) {
    bodyEl.innerHTML = `<tr><td colspan="10">${err.message}</td></tr>`;
  }
}

function drawPbiPie(slices, total) {
  const svg = document.getElementById("pbi-donut");
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const cx = 60, cy = 60, r0 = 34, r1 = 54;
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
    if (sweep > 0.12) {
      const mid = angle + sweep / 2;
      const lr = (r0 + r1) / 2;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(cx + lr * Math.cos(mid)));
      text.setAttribute("y", String(cy + lr * Math.sin(mid)));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("dominant-baseline", "middle");
      text.setAttribute("fill", /fem|n.o inf/i.test(s.key) ? "#fff7f9" : "#07110c");
      text.setAttribute("font-size", "7");
      text.setAttribute("font-weight", "700");
      text.textContent = `${((s.value / total) * 100).toFixed(1).replace(".", ",")}%`;
      svg.appendChild(text);
    }
    angle = next;
  });
}

function ensurePbiMap() {
  if (biState.mapPbi || typeof L === "undefined") return biState.mapPbi;
  const el = document.getElementById("map-pbi");
  if (!el) return null;
  biState.mapPbi = L.map("map-pbi", { zoomControl: false, attributionControl: false }).setView([-14.2, -54], 4);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 12,
  }).addTo(biState.mapPbi);
  return biState.mapPbi;
}

function drawPbiMap(data) {
  const map = ensurePbiMap();
  if (!map || !data) return;
  if (biState.layerPbi) {
    map.removeLayer(biState.layerPbi);
    biState.layerPbi = null;
  }
  const group = L.layerGroup();
  const byIbge = new Map();
  const byName = new Map();
  (biState.munis || []).forEach((m) => {
    const code = String(m.i || "");
    byIbge.set(code, m);
    if (code.length >= 6) byIbge.set(code.slice(0, 6), m);
    byName.set(`${String(m.u || "").toUpperCase()}|${foldText(m.n)}`, m);
  });
  const cidades = data.cidades || [];
  const max = Math.max(...cidades.map((c) => c.value), 1);
  cidades.forEach((c) => {
    const geo = lookupGeo(c, byIbge, byName);
    if (!geo) return;
    const t = c.value / max;
    L.circleMarker([geo.lat, geo.lng], {
      radius: 3 + Math.sqrt(t) * 10,
      color: "#f54963",
      fillColor: "#f54963",
      fillOpacity: 0.72,
      weight: 0,
    }).bindTooltip(`${c.municipio}${c.uf ? " · " + c.uf : ""}: ${biFmt(c.value)}`).addTo(group);
  });
  group.addTo(map);
  biState.layerPbi = group;
  map.setView([-14.2, -54], 4);
  setTimeout(() => map.invalidateSize(), 80);
}

function renderVisao(data) {
  if (!data || !document.getElementById("view-visao")) return;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set("pbi-crm", biFmt(data.crm));
  set("pbi-medicos", biFmt(data.medicos));
  set("pbi-esp", biFmt(data.especialidades));
  const updRaw = data.atualizado_em;
  let upd = null;
  if (updRaw != null && /^\d+(\.\d+)?$/.test(String(updRaw).trim()) && Number(updRaw) >= 1e9) {
    const n = Number(updRaw);
    const ms = n >= 1e18 ? n / 1e6 : n >= 1e14 ? n / 1e3 : n >= 1e12 ? n : n * 1000;
    upd = new Date(ms);
  } else if (updRaw) {
    upd = new Date(String(updRaw).includes("T") ? updRaw : String(updRaw).replace(" ", "T"));
  }
  set("pbi-updated", upd && !Number.isNaN(upd.getTime())
    ? `Atualizado em: ${upd.toLocaleDateString("pt-BR")}`
    : `Atualizado em: ${data.atualizado_em || "—"}`);

  const genderColors = { feminino: "#f54963", masculino: "#51e02e", "não informado": "#f4f7fb", "nao informado": "#f4f7fb" };
  const slices = (data.genero || []).map((g) => ({
    key: g.label,
    color: genderColors[String(g.label).toLowerCase()] || "#f4f7fb",
    value: g.value,
  }));
  const total = slices.reduce((s, g) => s + g.value, 0) || 1;
  set("pbi-donut-total", biFmt(total));
  drawPbiPie(slices, total);
  const legend = document.getElementById("pbi-legend");
  if (legend) {
    legend.innerHTML = slices.map((g) => {
      const pct = ((g.value / total) * 100).toFixed(1).replace(".", ",");
      return `<li><i style="background:${g.color}"></i><span>${g.key} · ${biFmt(g.value)} (${pct}%)</span></li>`;
    }).join("");
  }

  const mensalOk = (data.mensal || []).filter((m) => mesValido(m.mes));
  const rows = [...mensalOk].sort((a, b) => String(a.mes).localeCompare(String(b.mes)));
  const maxM = Math.max(...rows.map((m) => m.value), 1);
  const grupos = [];
  rows.forEach((m) => {
    const year = mesAno(m.mes);
    if (!grupos.length || grupos[grupos.length - 1].year !== year) grupos.push({ year, items: [] });
    grupos[grupos.length - 1].items.push(m);
  });
  const mensalEl = document.getElementById("pbi-mensal");
  if (mensalEl) {
    mensalEl.innerHTML = grupos.map((grupo) => `
      <div class="month-year">
        <div class="month-year-bars">
          ${grupo.items.map((m) => `
            <div class="month-col" title="${mesLabel(m.mes)} ${grupo.year} · ${biFmt(m.value)}">
              <span class="month-track"><i style="height:${Math.max(4, (m.value / maxM) * 100)}%"><em>${biFmt(m.value)}</em></i></span>
              <span class="month-name">${mesEixo(m.mes)}</span>
            </div>
          `).join("")}
        </div>
        <strong>${grupo.year}</strong>
      </div>
    `).join("");
  }

  fillBars("pbi-regiao", data.regioes || []);
  fillBars("pbi-faixa", data.faixa || []);
  fillBars("pbi-esp-ds", (data.especialidade_ds || []).slice(0, 10));
  fillBars("pbi-esp-cfm", (data.especialidade_cfm || []).slice(0, 10));
  fillBars("pbi-ufs", (data.ufs || []).slice(0, 12), "uf");
  drawPbiMap(data);
}

function switchTab(tab) {
  const comparativo = document.getElementById("view-comparativo");
  const visao = document.getElementById("view-visao");
  const dadosfera = document.getElementById("view-dadosfera");
  const cnes = document.getElementById("view-cnes");
  comparativo.hidden = tab !== "comparativo";
  if (visao) visao.hidden = tab !== "visao";
  dadosfera.hidden = tab !== "dadosfera";
  if (cnes) cnes.hidden = tab !== "cnes";
  document.body.classList.toggle("screen-visao", tab === "visao");
  document.querySelectorAll("[data-tab]").forEach((btn) => btn.classList.toggle("on", btn.dataset.tab === tab));
  if (tab === "dadosfera" || tab === "cnes" || tab === "visao") {
    location.hash = tab;
    if ((tab === "dadosfera" || tab === "visao") && !biState.data) loadBi();
    setTimeout(() => {
      if (biState.map) biState.map.invalidateSize();
      if (biState.mapPbi) biState.mapPbi.invalidateSize();
      if (tab === "visao" && biState.data) renderVisao(biState.data);
    }, 120);
  } else if (["dadosfera", "cnes", "visao"].includes(location.hash.replace("#", ""))) {
    location.hash = "";
  }
}

async function initBi() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  const start = location.hash.replace("#", "");
  if (start === "dadosfera" || start === "cnes" || start === "visao") switchTab(start);
  document.getElementById("map-uf").addEventListener("change", () => atualizarMapa());
  document.getElementById("map-reset").addEventListener("click", () => {
    document.getElementById("map-uf").value = "BR";
    atualizarMapa();
  });
  document.getElementById("btn-novos").addEventListener("click", buscarLista);
  document.getElementById("btn-csv").addEventListener("click", downloadNovosCsv);
  const btnMes = document.getElementById("btn-csv-mes");
  if (btnMes) btnMes.addEventListener("click", downloadMesCsv);
  const buscaEl = document.getElementById("lista-busca");
  if (buscaEl) {
    buscaEl.addEventListener("input", () => {
      biState.busca = buscaEl.value || "";
      if (biState.novos.length) renderTabela();
    });
    buscaEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        buscarLista();
      }
    });
  }
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
  if (biState.data) {
    atualizarMapa();
    renderVisao(biState.data);
  }
}

initBi();
