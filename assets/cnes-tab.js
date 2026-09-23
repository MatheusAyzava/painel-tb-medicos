const cnesState = { data: null, selecionado: null, mes: null };

const CNES_MES_NOMES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function cnesEsc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

function cnesCurto(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const first = raw.split("/")[0].replace(/^\s*[\d.\s-]+/, "").replace(/^\d+\s*-\s*/, "").trim();
  const text = (first || raw).replace(/\s+/g, " ").trim();
  const clean = text.replace(/\bnao se aplica\b/ig, "").replace(/\s{2,}/g, " ").trim() || raw;
  const lower = clean.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function cnesCbo(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "—") return "—";
  const match = raw.match(/^(\d+)\s*-\s*(.+)$/);
  if (!match) return cnesEsc(raw);
  return `<em>${cnesEsc(match[1])}</em> ${cnesEsc(match[2])}`;
}

function cnesFmt(n) {
  return Math.round(Number(n) || 0).toLocaleString("pt-BR");
}

function cnesMesAtual() {
  if (typeof mesValue === "function") return mesValue();
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function cnesMesLabel() {
  if (typeof mesLabel === "function") return mesLabel(cnesMesAtual()) || "mês";
  return cnesMesAtual();
}

function atualizarCnesMes() {
  const el = document.getElementById("cnes-mes");
  if (el) el.textContent = cnesMesLabel();
}

function cnesPessoaId(d) {
  return d && (d.pessoa_id || `${d.uf_crm || ""}::${String(d.nome || "").trim().toUpperCase()}`);
}

function cnesCompKey(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(raw)) return raw;
  const d = raw.replace(/\D/g, "");
  if (d.length >= 6) return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
  return "";
}

function cnesMesNome(key, anos) {
  const idx = Number(String(key || "").split("-")[1]) - 1;
  const nome = (typeof mesLabel === "function" && mesLabel(key))
    || (idx >= 0 && idx < 12 ? CNES_MES_NOMES[idx] : "");
  if (!nome) return key || "—";
  if (anos && anos.size > 1) return `${nome} ${String(key).slice(0, 4)}`;
  return nome;
}

function vinculosDoMedico(pessoaId, mes) {
  return ((cnesState.data && cnesState.data.vinculos) || []).filter((v) => {
    if (cnesPessoaId(v) !== pessoaId) return false;
    if (!mes) return true;
    return cnesCompKey(v.competencia) === mes;
  });
}

function cnesMesesDoMedico(pessoaId) {
  const map = new Map();
  vinculosDoMedico(pessoaId).forEach((v) => {
    const key = cnesCompKey(v.competencia);
    if (!key) return;
    const cur = map.get(key) || { mes: key, horas: 0, vinculos: 0 };
    cur.horas += Number(v.horas_total) || 0;
    cur.vinculos += 1;
    map.set(key, cur);
  });
  return [...map.values()].sort((a, b) => String(b.mes).localeCompare(String(a.mes)));
}

function cnesHorasPorCbo(rows) {
  const byCbo = new Map();
  (rows || []).forEach((v) => {
    const label = String(v.cbo || "Sem CBO").trim() || "Sem CBO";
    if (!byCbo.has(label)) {
      byCbo.set(label, { cbo: label, horas: 0, estabelecimento: v.estabelecimento || "", _max: -1 });
    }
    const item = byCbo.get(label);
    const horas = Number(v.horas_total) || 0;
    item.horas += horas;
    if (horas >= item._max) {
      item._max = horas;
      item.estabelecimento = v.estabelecimento || item.estabelecimento;
    }
  });
  return [...byCbo.values()]
    .map(({ _max, ...rest }) => rest)
    .sort((a, b) => b.horas - a.horas || a.cbo.localeCompare(b.cbo, "pt-BR"));
}

function renderCnesDocs() {
  const box = document.getElementById("cnes-docs");
  const count = document.getElementById("cnes-count");
  const docs = (cnesState.data && cnesState.data.profissionais) || [];
  count.textContent = docs.length
    ? `${cnesFmt(docs.length)} médico(s) — clique para ver os meses e os estabelecimentos`
    : (cnesState.data && cnesState.data.aviso) || "Nenhum médico encontrado.";
  box.innerHTML = docs.map((d) => {
    const id = cnesPessoaId(d);
    const meses = cnesMesesDoMedico(id);
    const anos = new Set(meses.map((m) => m.mes.slice(0, 4)));
    const ultimo = meses[0];
    const extra = ultimo
      ? `${cnesFmt(ultimo.horas)}h em ${cnesMesNome(ultimo.mes, anos)}`
      : "sem vínculo CNES";
    return `
    <button type="button" class="cnes-doc${cnesState.selecionado === id ? " on" : ""}" data-pessoa="${cnesEsc(id)}">
      <strong>${cnesEsc(d.nome || d.uf_crm)}</strong>
      <span>${cnesEsc(d.uf_crm || "sem CRM")} · ${cnesFmt(meses.length)} mês(es) · ${cnesEsc(extra)}</span>
    </button>`;
  }).join("");
}

function renderCnesDetalhe(pessoaId) {
  cnesState.selecionado = pessoaId;
  const docs = (cnesState.data && cnesState.data.profissionais) || [];
  const doc = docs.find((d) => cnesPessoaId(d) === pessoaId);
  const title = document.getElementById("cnes-detail-title");
  const local = document.getElementById("cnes-detail-local");
  const kpis = document.getElementById("cnes-kpis");
  const body = document.getElementById("cnes-vinculos");
  const principal = document.getElementById("cnes-principal");
  const mesesBox = document.getElementById("cnes-meses");
  const cbos = document.getElementById("cnes-cbos");
  document.querySelectorAll(".cnes-doc").forEach((btn) => btn.classList.toggle("on", btn.dataset.pessoa === pessoaId));
  if (!doc) {
    cnesState.mes = null;
    title.textContent = "Detalhe do profissional";
    local.textContent = "Selecione um médico à esquerda.";
    kpis.innerHTML = "";
    if (mesesBox) {
      mesesBox.hidden = true;
      mesesBox.innerHTML = "";
    }
    if (cbos) {
      cbos.hidden = true;
      cbos.innerHTML = "";
    }
    if (principal) {
      principal.hidden = true;
      principal.innerHTML = "";
    }
    body.innerHTML = "<tr><td colspan='7'>Nenhum vínculo carregado.</td></tr>";
    return;
  }
  const meses = cnesMesesDoMedico(pessoaId);
  const anos = new Set(meses.map((m) => m.mes.slice(0, 4)));
  if (!meses.some((m) => m.mes === cnesState.mes)) cnesState.mes = meses[0] ? meses[0].mes : null;
  const mesNome = cnesMesNome(cnesState.mes, anos);
  const rows = vinculosDoMedico(pessoaId, cnesState.mes);
  const horasCbo = cnesHorasPorCbo(rows);
  const horasMes = rows.reduce((s, v) => s + (Number(v.horas_total) || 0), 0);
  const ests = new Set(rows.map((v) => v.estabelecimento).filter(Boolean));
  const principalEst = (horasCbo[0] && horasCbo[0].estabelecimento)
    || (rows.slice().sort((a, b) => (Number(b.horas_total) || 0) - (Number(a.horas_total) || 0))[0] || {}).estabelecimento
    || "";
  title.textContent = doc.nome || doc.uf_crm;
  local.textContent = `${doc.uf_crm || "sem CRM"} · CNS ${doc.cns || "—"} · ${((doc.cidades) || []).join(" · ") || "sem cidade"}`;
  if (mesesBox) {
    mesesBox.hidden = !meses.length;
    mesesBox.innerHTML = meses.map((item) => `
      <button type="button" class="cnes-mes${item.mes === cnesState.mes ? " on" : ""}" data-mes="${cnesEsc(item.mes)}">
        <b>${cnesFmt(item.horas)}h</b>
        <span>${cnesEsc(cnesMesNome(item.mes, anos))}</span>
      </button>
    `).join("");
  }
  kpis.innerHTML = `
    <div><b>${cnesFmt(horasMes)}h</b><span>Total em ${mesNome || "mês"}</span></div>
    <div><b>${cnesFmt(horasCbo.length)}</b><span>CBOs no mês</span></div>
    <div><b>${cnesFmt(ests.size)}</b><span>Estabelecimentos</span></div>
  `;
  if (cbos) {
    cbos.hidden = !horasCbo.length;
    cbos.innerHTML = horasCbo.map((item) => `
      <div>
        <b>${cnesFmt(item.horas)}h</b>
        <strong title="${cnesEsc(item.cbo || "")}">${cnesCbo(item.cbo)}</strong>
        <span title="${cnesEsc(item.estabelecimento || "")}">${cnesEsc(item.estabelecimento || "—")}</span>
      </div>
    `).join("");
  }
  if (principal) {
    principal.hidden = !principalEst;
    principal.innerHTML = principalEst
      ? `<span>Onde mais atende em ${mesNome || "mês"}</span><strong title="${cnesEsc(principalEst)}">${cnesEsc(principalEst)}</strong>`
      : "";
  }
  if (!rows.length) {
    body.innerHTML = "<tr><td colspan='7'>Sem vínculos CNES neste mês.</td></tr>";
    return;
  }
  const ordered = [...rows].sort((a, b) => String(a.cbo || "").localeCompare(String(b.cbo || ""), "pt-BR") || (Number(b.horas_total) || 0) - (Number(a.horas_total) || 0));
  body.innerHTML = ordered.map((v) => `
    <tr>
      <td>${cnesEsc(v.cns || "—")}</td>
      <td>${cnesEsc(v.nome || "—")}</td>
      <td class="uf">${cnesEsc(v.uf || "—")}</td>
      <td>${cnesEsc(v.municipio || "—")}</td>
      <td class="cbo" title="${cnesEsc(v.cbo || "")}">${cnesCbo(v.cbo)}</td>
      <td class="est" title="${cnesEsc(v.estabelecimento || "")}">${cnesEsc(v.estabelecimento || "—")}</td>
      <td class="hrs">${cnesFmt(v.horas_total)}</td>
    </tr>`).join("") + `
    <tr class="cnes-total">
      <td colspan="6">Total em ${cnesEsc(mesNome || "mês")}</td>
      <td class="hrs">${cnesFmt(horasMes)}</td>
    </tr>`;
}

async function buscarCnes() {
  atualizarCnesMes();
  const q = document.getElementById("cnes-q").value.trim();
  const uf = document.getElementById("cnes-uf").value;
  const novos = document.getElementById("cnes-novos").checked;
  const count = document.getElementById("cnes-count");
  count.textContent = "Consultando CNES no Snowflake…";
  try {
    const res = await fetch("/api/cnes-busca", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q, uf, novos, mes: cnesMesAtual() }),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (err) {
      throw new Error("A consulta passou do tempo no servidor. Tente de novo em alguns segundos.");
    }
    if (!res.ok) throw new Error(data.error || "Falha na busca CNES");
    cnesState.data = data;
    cnesState.selecionado = null;
    cnesState.mes = null;
    renderCnesDocs();
    const first = (data.profissionais || [])[0];
    if (first) renderCnesDetalhe(cnesPessoaId(first));
    else renderCnesDetalhe(null);
  } catch (err) {
    count.textContent = err.message || "Não consultei o CNES.";
  }
}

function baixarCnesCsv() {
  const rows = cnesState.selecionado
    ? vinculosDoMedico(cnesState.selecionado, cnesState.mes)
    : ((cnesState.data && cnesState.data.vinculos) || []);
  if (!rows.length) return;
  const header = [
    "CNS", "NOME", "UF", "MUNICIPIO", "CBO", "ESTABELECIMENTO", "MES", "HORAS",
  ].join(";");
  const esc = (v) => {
    const t = String(v == null ? "" : v);
    if (/[;"\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const body = rows.map((v) => [
    v.cns, v.nome, v.uf, v.municipio, v.cbo, v.estabelecimento,
    cnesMesNome(cnesCompKey(v.competencia) || v.competencia), v.horas_total,
  ].map(esc).join(";")).join("\n");
  const blob = new Blob(["\ufeff" + header + "\n" + body], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cnes-${cnesState.selecionado || "busca"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function initCnesTab() {
  const btn = document.getElementById("cnes-btn");
  const csv = document.getElementById("cnes-csv");
  const q = document.getElementById("cnes-q");
  const docs = document.getElementById("cnes-docs");
  const meses = document.getElementById("cnes-meses");
  if (!btn || !q) return;
  atualizarCnesMes();
  btn.addEventListener("click", buscarCnes);
  if (csv) csv.addEventListener("click", baixarCnesCsv);
  q.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      buscarCnes();
    }
  });
  if (docs) {
    docs.addEventListener("click", (event) => {
      const card = event.target.closest(".cnes-doc");
      if (card && card.dataset.pessoa) renderCnesDetalhe(card.dataset.pessoa);
    });
  }
  if (meses) {
    meses.addEventListener("click", (event) => {
      const chip = event.target.closest(".cnes-mes");
      if (!chip || !chip.dataset.mes || !cnesState.selecionado) return;
      cnesState.mes = chip.dataset.mes;
      renderCnesDetalhe(cnesState.selecionado);
    });
  }
}

initCnesTab();
